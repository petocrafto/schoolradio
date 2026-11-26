create extension if not exists pgcrypto;

create table public.admins (user_id uuid primary key references auth.users(id) on delete cascade, created_at timestamptz not null default now());
create table public.system_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
insert into public.system_settings(key,value) values
 ('radio_name','"School Radio"'),('moderation_mode','"manual"'),('request_limit_per_hour','5'),('timezone','"Asia/Jakarta"'),('player_poll_seconds','3'),('opening_behavior','"continue"') on conflict do nothing;

create table public.requests (
 id uuid primary key default gen_random_uuid(), video_id text not null check(video_id ~ '^[A-Za-z0-9_-]{11}$'), title text not null, channel_name text not null, thumbnail_url text not null,
 requester_name text not null, status text not null check(status in ('pending','approved','rejected','playing','played','skipped','cancelled')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), queue_position bigint
);
create index requests_queue_idx on public.requests(status, queue_position, created_at);
create table public.request_rate_events (id uuid primary key default gen_random_uuid(), client_hash text not null, created_at timestamptz not null default now());
create index request_rate_events_client_time_idx on public.request_rate_events(client_hash,created_at desc);
create index requests_video_time_idx on public.requests(video_id,status,created_at desc);

create table public.schedules (id uuid primary key default gen_random_uuid(), weekday smallint not null check(weekday between 0 and 6), start_time time not null, end_time time not null, enabled boolean not null default true, start_behavior text not null default 'continue' check(start_behavior in ('continue','opening_playlist','wait')), playlist_id uuid, created_at timestamptz not null default now(), check(start_time<>end_time));
create index schedules_weekday_idx on public.schedules(weekday,enabled,start_time);
create table public.schedule_overrides (id uuid primary key default gen_random_uuid(), schedule_date date not null, disabled boolean not null default false, start_time time, end_time time, enabled boolean not null default true, start_behavior text not null default 'continue' check(start_behavior in ('continue','opening_playlist','wait')), playlist_id uuid, note text, created_at timestamptz not null default now(), check((start_time is null)=(end_time is null)));
create index schedule_override_date_idx on public.schedule_overrides(schedule_date);
create table public.playlists (id uuid primary key default gen_random_uuid(), name text not null, playlist_type text not null default 'opening' check(playlist_type in ('opening','general')), items jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
alter table public.schedules add constraint schedules_playlist_fk foreign key(playlist_id) references public.playlists(id) on delete set null;
alter table public.schedule_overrides add constraint overrides_playlist_fk foreign key(playlist_id) references public.playlists(id) on delete set null;

create table public.playback_history (id uuid primary key default gen_random_uuid(), request_id uuid references public.requests(id) on delete set null, video_id text not null, title text not null, channel_name text not null, requester_name text not null, played_at timestamptz not null default now(), ended_at timestamptz, status text not null check(status in ('played','skipped')), reason text);
create index playback_video_time_idx on public.playback_history(video_id,played_at desc);
create index playback_recent_idx on public.playback_history(played_at desc);
create table public.player_devices (id uuid primary key default gen_random_uuid(), name text not null default 'Radio Player', state text not null default 'offline' check(state in ('offline','standby','connecting','ready','playing','paused','emergency_stopped','error')), last_seen_at timestamptz, current_request_id uuid references public.requests(id) on delete set null, emergency_stopped boolean not null default false, updated_at timestamptz not null default now());
create table public.player_commands (id uuid primary key default gen_random_uuid(), command text not null check(command in ('play','pause','resume','next','stop','volume','emergency_stop','emergency_resume')), payload jsonb not null default '{}'::jsonb, priority integer not null default 10, issued_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now(), acknowledged_at timestamptz, acknowledged_by uuid references public.player_devices(id) on delete set null);
create index player_commands_pending_idx on public.player_commands(acknowledged_at,priority desc,created_at);

create or replace function public.submit_song_request(p_requester_name text,p_video_id text,p_title text,p_channel_name text,p_thumbnail_url text,p_client_ip text) returns uuid language plpgsql security definer set search_path=public as $$
declare v_limit integer; v_count integer; v_status text; v_id uuid; v_client_hash text;
begin
 if length(trim(p_requester_name)) not between 1 and 60 or p_video_id !~ '^[A-Za-z0-9_-]{11}$' then raise exception 'invalid_request'; end if;
 select (value#>>'{}')::integer into v_limit from system_settings where key='request_limit_per_hour'; v_limit:=coalesce(v_limit,5);
 v_client_hash:=encode(digest(left(coalesce(p_client_ip,'unknown'),80),'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtext(v_client_hash));
 delete from request_rate_events where client_hash=v_client_hash and created_at<now()-interval '24 hours';
 select count(*) into v_count from request_rate_events where client_hash=v_client_hash and created_at>now()-interval '1 hour';
 if v_count>=v_limit then raise exception 'rate_limit'; end if;
 insert into request_rate_events(client_hash) values(v_client_hash);
 select case when value#>>'{}'='automatic' then 'approved' else 'pending' end into v_status from system_settings where key='moderation_mode';
 insert into requests(requester_name,video_id,title,channel_name,thumbnail_url,status) values(trim(p_requester_name),p_video_id,left(trim(p_title),200),left(trim(p_channel_name),120),p_thumbnail_url,coalesce(v_status,'pending')) returning id into v_id;
 return v_id;
end $$;

create or replace function public.claim_next_request() returns setof public.requests language plpgsql security definer set search_path=public as $$
declare v_row public.requests%rowtype; v_now timestamp; v_date date; v_dow integer; v_active boolean;
begin
 if exists(select 1 from player_devices where emergency_stopped) then return; end if;
 perform pg_advisory_xact_lock(hashtext('school-radio-queue-claim'));
 if exists(select 1 from player_devices where current_request_id is not null and state in ('playing','paused')) then return; end if;
 select now() at time zone coalesce((select value#>>'{}' from system_settings where key='timezone'),'Asia/Jakarta') into v_now;
 v_date:=v_now::date; v_dow:=extract(dow from v_now)::integer;
 if exists(select 1 from schedule_overrides where schedule_date=v_date) then
   select exists(select 1 from schedule_overrides where schedule_date=v_date and enabled and not disabled and start_time is not null and ((start_time<end_time and v_now::time>=start_time and v_now::time<end_time) or (start_time>end_time and (v_now::time>=start_time or v_now::time<end_time)))) into v_active;
 else
   select exists(select 1 from schedules where weekday=v_dow and enabled and ((start_time<end_time and v_now::time>=start_time and v_now::time<end_time) or (start_time>end_time and (v_now::time>=start_time or v_now::time<end_time)))) into v_active;
 end if;
 if not coalesce(v_active,false) then return; end if;
 loop
   select * into v_row from requests where status='approved' order by queue_position nulls last,created_at for update skip locked limit 1;
   if not found then return; end if;
   if exists(select 1 from playback_history where video_id=v_row.video_id and played_at>=now()-interval '24 hours') then
     update requests set status='skipped',updated_at=now() where id=v_row.id;
     insert into playback_history(request_id,video_id,title,channel_name,requester_name,status,reason) values(v_row.id,v_row.video_id,v_row.title,v_row.channel_name,v_row.requester_name,'skipped','duplicate_24h');
     continue;
   end if;
   update requests set status='playing',updated_at=now() where id=v_row.id returning * into v_row;
   update player_devices set current_request_id=v_row.id,state='playing',updated_at=now() where id=(select id from player_devices order by last_seen_at desc nulls last limit 1);
   return next v_row; return;
 end loop;
end $$;

create or replace function public.finish_playback(p_request_id uuid,p_status text,p_reason text default null) returns void language plpgsql security definer set search_path=public as $$
declare r requests%rowtype;
begin
 if p_status not in ('played','skipped') then raise exception 'invalid_status'; end if;
 select * into r from requests where id=p_request_id for update;
 if not found or r.status<>'playing' then return; end if;
 update requests set status=p_status,updated_at=now() where id=p_request_id;
 insert into playback_history(request_id,video_id,title,channel_name,requester_name,status,reason) values(r.id,r.video_id,r.title,r.channel_name,r.requester_name,p_status,left(p_reason,120));
 update player_devices set current_request_id=null,state='ready',updated_at=now() where current_request_id=p_request_id;
end $$;

create or replace function public.player_heartbeat(p_device_id uuid,p_state text,p_current_request_id uuid default null) returns setof player_commands language plpgsql security definer set search_path=public as $$
begin
 insert into player_devices(id,name,state,last_seen_at,current_request_id) values(p_device_id,'Radio Player',case when p_state in ('standby','connecting','ready','playing','paused','error','emergency_stopped') then p_state else 'ready' end,now(),p_current_request_id) on conflict(id) do update set state=case when player_devices.emergency_stopped then 'emergency_stopped' else excluded.state end,last_seen_at=now(),current_request_id=case when player_devices.emergency_stopped then player_devices.current_request_id else excluded.current_request_id end,updated_at=now();
 return query with chosen as (select id from player_commands where acknowledged_at is null and (not exists(select 1 from player_devices where id=p_device_id and emergency_stopped) or command in ('emergency_stop','emergency_resume')) order by priority desc,created_at for update skip locked limit 1), ack as (update player_commands c set acknowledged_at=now(),acknowledged_by=p_device_id from chosen where c.id=chosen.id returning c.*) select * from ack order by priority desc,created_at;
end $$;

alter table public.admins enable row level security;
alter table public.requests enable row level security;
alter table public.request_rate_events enable row level security;
alter table public.schedules enable row level security;
alter table public.schedule_overrides enable row level security;
alter table public.playback_history enable row level security;
alter table public.player_devices enable row level security;
alter table public.player_commands enable row level security;
alter table public.system_settings enable row level security;
alter table public.playlists enable row level security;
create policy admin_self_read on public.admins for select to authenticated using(user_id=auth.uid());
create policy public_queue_read on public.requests for select to anon,authenticated using(status in ('approved','playing','played'));
create policy public_history_read on public.playback_history for select to anon,authenticated using(status='played');
create policy admin_requests_manage on public.requests for all to authenticated using(exists(select 1 from admins where user_id=auth.uid())) with check(exists(select 1 from admins where user_id=auth.uid()));
create policy admin_schedule_manage on public.schedules for all to authenticated using(exists(select 1 from admins where user_id=auth.uid())) with check(exists(select 1 from admins where user_id=auth.uid()));
create policy admin_override_manage on public.schedule_overrides for all to authenticated using(exists(select 1 from admins where user_id=auth.uid())) with check(exists(select 1 from admins where user_id=auth.uid()));
create policy admin_history_read on public.playback_history for select to authenticated using(exists(select 1 from admins where user_id=auth.uid()));
create policy admin_devices_read on public.player_devices for select to authenticated using(exists(select 1 from admins where user_id=auth.uid()));
create policy admin_commands_manage on public.player_commands for all to authenticated using(exists(select 1 from admins where user_id=auth.uid())) with check(exists(select 1 from admins where user_id=auth.uid()));
create policy admin_settings_manage on public.system_settings for all to authenticated using(exists(select 1 from admins where user_id=auth.uid())) with check(exists(select 1 from admins where user_id=auth.uid()));
create policy public_radio_settings_read on public.system_settings for select to anon,authenticated using(key in ('radio_name','moderation_mode','timezone'));
create policy admin_playlists_manage on public.playlists for all to authenticated using(exists(select 1 from admins where user_id=auth.uid())) with check(exists(select 1 from admins where user_id=auth.uid()));
revoke all on public.requests from anon, authenticated;
grant select on public.requests to anon,authenticated;
revoke all on public.admins, public.schedules, public.schedule_overrides, public.player_devices, public.player_commands, public.playlists from anon, authenticated;
revoke all on public.request_rate_events from anon, authenticated;
revoke all on public.system_settings from anon, authenticated;
grant select (key,value) on public.system_settings to anon,authenticated;
revoke all on public.playback_history from anon,authenticated;
grant select on public.playback_history to anon,authenticated;
revoke all on function public.submit_song_request(text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_song_request(text,text,text,text,text,text) to service_role;
revoke all on function public.claim_next_request() from public,anon,authenticated;
grant execute on function public.claim_next_request() to service_role;
revoke all on function public.finish_playback(uuid,text,text) from public,anon,authenticated;
grant execute on function public.finish_playback(uuid,text,text) to service_role;
revoke all on function public.player_heartbeat(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.player_heartbeat(uuid,text,uuid) to service_role;
alter publication supabase_realtime add table public.requests;
alter publication supabase_realtime add table public.playback_history;

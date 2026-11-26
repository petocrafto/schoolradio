create or replace function public.submit_song_request(
  p_requester_name text,
  p_video_id text,
  p_title text,
  p_channel_name text,
  p_thumbnail_url text,
  p_client_ip text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_limit integer;
  v_count integer;
  v_status text;
  v_id uuid;
  v_client_hash text;
begin
  if pg_catalog.length(pg_catalog.btrim(p_requester_name)) not between 1 and 60
     or p_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    raise exception 'invalid_request';
  end if;

  select (value#>>'{}')::integer
    into v_limit
    from public.system_settings
    where key = 'request_limit_per_hour';
  v_limit := coalesce(v_limit, 5);

  v_client_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.left(coalesce(p_client_ip, 'unknown'), 80),
        'UTF8'
      ),
      'sha256'::text
    ),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(v_client_hash));

  delete from public.request_rate_events
    where client_hash = v_client_hash
      and created_at < pg_catalog.now() - interval '24 hours';

  select count(*)
    into v_count
    from public.request_rate_events
    where client_hash = v_client_hash
      and created_at > pg_catalog.now() - interval '1 hour';

  if v_count >= v_limit then
    raise exception 'rate_limit';
  end if;

  insert into public.request_rate_events(client_hash) values (v_client_hash);

  select case when value#>>'{}' = 'automatic' then 'approved' else 'pending' end
    into v_status
    from public.system_settings
    where key = 'moderation_mode';

  insert into public.requests(requester_name, video_id, title, channel_name, thumbnail_url, status)
    values (
      pg_catalog.btrim(p_requester_name),
      p_video_id,
      pg_catalog.left(pg_catalog.btrim(p_title), 200),
      pg_catalog.left(pg_catalog.btrim(p_channel_name), 120),
      p_thumbnail_url,
      coalesce(v_status, 'pending')
    )
    returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.submit_song_request(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_song_request(text, text, text, text, text, text)
  to service_role;

# School Radio

A station website and control room built with plain **HTML, CSS and JavaScript**, served by a small dependency-free Node.js server. Supabase provides authentication, Postgres, and Realtime; YouTube Data API provides song search.

No build step, no framework, no bundler. `node server.mjs` serves the site and the JSON API.

## Layout

```
server.mjs                  Local/self-hosted Node server: static files + JSON API
lib/core.mjs                Shared API router (env, Supabase, validation, handlers)
lib/vercel.mjs              Adapter that exposes the router as a Vercel function
api/                        One Vercel function per endpoint (see API table)
public/                     Everything the browser loads
  index.html                Landing page (now playing, programme, next songs)
  queue.html                Public queue and recent history
  request.html              YouTube search and song requests
  player.html               Dedicated player for the radio computer
  admin/                    Control room pages (login, dashboard, requests,
                            queue, schedule, history, statistics, settings)
  assets/css/app.css        Design system
  assets/js/                Page modules (ES modules, no bundler)
  assets/vendor/supabase.js Local copy of supabase-js (UMD build)
supabase/migrations/        SQL schema, functions, RLS and grants
vercel.json                 cleanUrls, function limits, security headers
```

The same `lib/core.mjs` router powers both hosts: `server.mjs` for a normal Node
process, and `api/*.js` for Vercel serverless functions. There is no duplicated
API logic.

## Requirements

- Node.js 20+.
- A Supabase project with Auth enabled.
- YouTube Data API v3 key with the YouTube Data API enabled.

## Configuration

Copy `.env.example` to `.env.local` and fill in:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL (also accepted: `NEXT_PUBLIC_SUPABASE_URL`) |
| `SUPABASE_ANON_KEY` | Public anon key, sent to the browser for Auth and Realtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for the API; never sent to the browser |
| `YOUTUBE_API_KEY` | Server-only YouTube Data API key |
| `PLAYER_DEVICE_TOKEN` | Shared bearer secret the player computer sends |
| `PORT` | HTTP port, default `3000` |

`GET /api/config` exposes only the Supabase URL and anon key. The service-role key, YouTube key, and player token never leave the server.

## Database

Apply the migrations in order in the Supabase SQL editor:

1. `202611220001_initial.sql` — tables, functions, RLS policies, grants.
2. `202611220002_submit_song_request_extensions_digest.sql` — fixes `digest()` to use `extensions.digest(bytea, 'sha256'::text)`.
3. `202611220003_schedule_program_names.sql` — adds `program_name` to `schedules` and `schedule_overrides`.

The server detects whether `program_name` exists. If it is missing, schedule management reports it in the UI and the player shows the default programme name, so an unmigrated database degrades instead of breaking.

Create an administrator by signing up a user in Supabase Auth, then granting access:

```sql
insert into public.admins(user_id)
select id from auth.users where email = 'admin@example.com';
```

RLS stays enabled. The browser uses only the anon key and the admin's own session; every privileged operation goes through the server, which re-checks `public.admins` for the caller's token.

## Run

```bash
npm start        # or: node server.mjs
npm test         # schedule/validation unit checks, no network
```

Open `http://localhost:3000`. Admin sign-in is at `/admin/`.

## Deploy to Vercel

`server.mjs` is a long-running HTTP server, which Vercel does not run. The
repository therefore ships both targets in the layouts Vercel detects by
default: static files in `public/`, one serverless function per endpoint in
`api/`, and both backed by `lib/core.mjs`.

1. Push the repository to GitHub.
2. In Vercel: **Add New → Project → Import** the repository.
3. Framework preset: **Other**. Build command empty, output directory default
   (`public`). `vercel.json` adds `cleanUrls`, function limits, and headers.
4. Add the environment variables from the table above under
   **Settings → Environment Variables** (Production and Preview):
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `YOUTUBE_API_KEY`, `PLAYER_DEVICE_TOKEN`.
5. Deploy. Then open `https://<project>.vercel.app` and `/admin`.

Notes specific to Vercel:

- `.env.local` is ignored by `.gitignore` and never read in the cloud; the
  dashboard variables are used instead.
- Static pages are served by the CDN; only `/api/*` runs as functions.
- `cleanUrls` is enabled, so `/admin/schedule` works without `.html`.
- Functions run in the Node.js runtime (Node 20+), region defaults to the
  project's region. Put the project in a region close to your Supabase project
  to keep API latency low.
- The player and the queue use Supabase Realtime directly from the browser, so
  no websocket support is needed on Vercel.
- Free-tier functions are stateless between invocations: the YouTube search
  cache and the `program_name` schema probe simply re-run after a cold start.

Deploying anywhere else that runs Node (Render, Railway, Fly.io, a school
server) works unchanged with `npm start`, because `server.mjs` serves both the
static site and the API.

### Deploy from the terminal

`scripts/deploy-vercel.mjs` automates steps 2–5 with the Vercel CLI:

```bash
npx vercel login                  # once, interactive device login
node scripts/deploy-vercel.mjs    # link project, push env vars, deploy --prod
```

It reads the five variables from `.env.local` (never committed), writes them to
the Vercel project for both `production` and `preview`, then prints the live
URL. Pass `--project <name>` to choose a project name other than
`school-radio`.


## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/config` | public | Supabase URL + anon key |
| GET | `/api/public/queue` | public | Current track, approved queue, recent history |
| GET | `/api/search?q=` | public | YouTube search (8 results, 30s in-memory cache) |
| POST | `/api/requests` | public, rate limited | Submit a song request |
| GET | `/api/player/schedule` | public | Active and next programme |
| GET | `/api/player` | public | Device state and radio settings |
| POST | `/api/player` | player token | `heartbeat`, `claim`, `finish` |
| GET | `/api/admin/me` | admin | Verify the session is an administrator |
| GET | `/api/admin/overview` | admin | Dashboard totals and today's sessions |
| GET/PATCH/DELETE | `/api/admin/requests` | admin | List, moderate, reorder, delete requests |
| GET | `/api/admin/history` | admin | Last 200 playback records |
| GET | `/api/admin/statistics` | admin | Seven-day playback series and totals |
| GET/POST/PATCH/DELETE | `/api/admin/schedules` | admin | Weekly sessions and date overrides |
| GET/PUT | `/api/admin/settings` | admin | Radio name, moderation mode, hourly limit |
| POST | `/api/admin/commands` | admin | Queue player commands |

Schedule writes validate server-side: valid clock times, different start and end, weekday or calendar date, programme name length, and no overlap with another enabled session. Overnight sessions (end before start) are compared across the day boundary, including the next weekday; date overrides are compared against the previous, same, and next date so an overnight override cannot collide silently. Closed-day overrides block any other override on that date.

## Player computer

Open `/player`, enter `PLAYER_DEVICE_TOKEN`, and keep the tab open in kiosk mode. The page shows a Jakarta clock ticking every second, the active and next programme, and the current track. It polls the studio every 3 seconds for commands and schedule changes, and uses Supabase Realtime on the public queue for the other pages.

YouTube's IFrame API may require a user gesture before audio starts; press **Start playback** after loading or refreshing. Autoplay rules, embedding restrictions, and ads remain in effect.

## Known limits

- YouTube IFrame API playback requires a modern browser. Windows 7 is unsupported by current browser vendors; the pages avoid modern-only APIs beyond `fetch`, `Intl`, and ES modules, but the browser itself must still support TLS and YouTube.
- The player token is a shared bearer secret. Serve the site over TLS and rotate the token if it leaks.
- Request throttling hashes the client IP in Postgres. Ensure your reverse proxy sets `X-Forwarded-For` truthfully.
- A track already playing is not force-stopped at the end of a scheduled session; start behaviours are stored and displayed but not executed by the player.
- Playback requires the player to be online; queued emergency commands are delivered on its next heartbeat.

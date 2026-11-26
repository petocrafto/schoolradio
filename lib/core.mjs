import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ env */

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
  } catch {
    return;
  }
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, ".env.local"));
loadEnvFile(path.join(ROOT, ".env"));

const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const SB_ANON = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY || "";
const PLAYER_TOKEN = process.env.PLAYER_DEVICE_TOKEN || "";

export function configuration() {
  return { supabaseUrl: SB_URL, hasAnonKey: Boolean(SB_ANON), hasServiceKey: Boolean(SB_SERVICE), hasYouTubeKey: Boolean(YOUTUBE_KEY), hasPlayerToken: Boolean(PLAYER_TOKEN) };
}

export function assertConfiguration() {
  const missing = [];
  if (!SB_URL) missing.push("SUPABASE_URL");
  if (!SB_ANON) missing.push("SUPABASE_ANON_KEY");
  if (!SB_SERVICE) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) throw new Error(`Missing Supabase configuration: ${missing.join(", ")}`);
}

/* -------------------------------------------------------------- postgrest */

export class ApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

function serviceHeaders() {
  return {
    apikey: SB_SERVICE,
    authorization: `Bearer ${SB_SERVICE}`,
    "content-type": "application/json",
  };
}

async function rest(pathname, options = {}) {
  const response = await fetch(`${SB_URL}/rest/v1/${pathname}`, {
    method: options.method || "GET",
    headers: { ...serviceHeaders(), ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = data && typeof data === "object" ? data.message || data.hint || "Database request failed." : "Database request failed.";
    throw new ApiError(String(message), response.status);
  }
  return { data, headers: response.headers };
}

async function restCount(pathname) {
  const response = await fetch(`${SB_URL}/rest/v1/${pathname}`, {
    method: "HEAD",
    headers: { ...serviceHeaders(), prefer: "count=exact" },
  });
  if (!response.ok) throw new ApiError("Could not count records.", response.status);
  const range = response.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

/* ------------------------------------------------------------------ auth */

async function authUser(headers) {
  const header = headers.authorization || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (!token) return null;
  const response = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_ANON, authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requireAdmin(headers) {
  const user = await authUser(headers);
  if (!user || !user.id) return null;
  const { data } = await rest(`admins?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`);
  return Array.isArray(data) && data.length ? user : null;
}

/* -------------------------------------------------------------- helpers */

const JAKARTA = "Asia/Jakarta";
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: JAKARTA, year: "numeric", month: "2-digit", day: "2-digit" });

export function jakartaToday() {
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function jakartaDayStart(daysAgo = 0) {
  return new Date(`${shiftDate(jakartaToday(), -daysAgo)}T00:00:00+07:00`).toISOString();
}

/* ------------------------------------------------------------- schedules */

let hasProgramName = null;
let schemaProbe = null;

export async function ensureSchema() {
  if (hasProgramName !== null) return hasProgramName;
  if (!schemaProbe) {
    schemaProbe = (async () => {
      try {
        await rest("schedules?select=program_name&limit=1");
        hasProgramName = true;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 400 || error.status === 404)) {
          hasProgramName = false;
          console.warn("Column schedules.program_name is missing. Run supabase/migrations/202611220003_schedule_program_names.sql to enable program names.");
        } else {
          hasProgramName = true;
        }
      }
      return hasProgramName;
    })();
  }
  return schemaProbe;
}

const WEEKLY_COLUMNS = (extra = "") => `id,weekday,start_time,end_time,enabled,start_behavior${hasProgramName ? ",program_name" : ""}${extra}`;
const OVERRIDE_COLUMNS = (extra = "") => `id,schedule_date,start_time,end_time,enabled,disabled,note,start_behavior${hasProgramName ? ",program_name" : ""}${extra}`;

function withProgramName(row) {
  return { ...row, program_name: hasProgramName ? row.program_name ?? "Untitled program" : "Untitled program" };
}

const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function minutesOf(value) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function intervalOf(start, end) {
  const from = minutesOf(start);
  let to = minutesOf(end);
  if (from === to) return null;
  if (to < from) to += 1440;
  return [from, to];
}

function overlaps(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

export function weeklyConflict(day, start, end, other) {
  if (!Number.isInteger(other.weekday) || typeof other.start_time !== "string" || typeof other.end_time !== "string") return false;
  const a = intervalOf(start, end);
  const b = intervalOf(other.start_time.slice(0, 5), other.end_time.slice(0, 5));
  if (!a || !b) return false;
  const startA = day * 1440 + a[0];
  const startB = Number(other.weekday) * 1440 + b[0];
  return [-10080, 0, 10080].some((shift) => overlaps([startA, startA + a[1] - a[0]], [startB + shift, startB + shift + b[1] - b[0]]));
}

export function overrideConflict(date, start, end, other, rowClosed = false) {
  if (typeof other.schedule_date !== "string") return false;
  const dayShift = (Date.parse(`${other.schedule_date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
  if (Math.abs(dayShift) > 1) return false;
  const a = rowClosed ? [0, 1440] : intervalOf(start, end);
  const b = other.disabled === true
    ? [0, 1440]
    : typeof other.start_time === "string" && typeof other.end_time === "string"
      ? intervalOf(other.start_time.slice(0, 5), other.end_time.slice(0, 5))
      : null;
  if (!a || !b) return false;
  return overlaps(a, [dayShift * 1440 + b[0], dayShift * 1440 + b[1]]);
}

export function validateSchedule(body, kind) {
  if (!body || typeof body !== "object") throw new ApiError("Invalid schedule request.", 400);
  const program = typeof body.programName === "string" ? body.programName.trim() : "";
  if (!program || program.length > 120) throw new ApiError("Enter a program name of 1 to 120 characters.", 400);
  const behavior = body.startBehavior ?? "continue";
  if (!["continue", "opening_playlist", "wait"].includes(behavior)) throw new ApiError("Choose a valid start behavior.", 400);
  if (kind === "weekly" && (!Number.isInteger(body.weekday) || body.weekday < 0 || body.weekday > 6)) throw new ApiError("Choose a valid weekday.", 400);
  if (kind === "override" && !isValidDate(body.date)) throw new ApiError("Choose a valid calendar date.", 400);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new ApiError("Choose whether this schedule is enabled.", 400);
  if (kind === "override" && body.disabled !== undefined && typeof body.disabled !== "boolean") throw new ApiError("Choose whether this date is closed.", 400);

  const closed = kind === "override" && body.disabled === true;
  if (closed) {
    const row = { program_name: program, disabled: true, enabled: body.enabled === undefined ? true : body.enabled, start_time: null, end_time: null, start_behavior: behavior, schedule_date: body.date };
    if (typeof body.note === "string") row.note = body.note.trim().slice(0, 500);
    return row;
  }
  if (typeof body.startTime !== "string" || !clockPattern.test(body.startTime) || typeof body.endTime !== "string" || !clockPattern.test(body.endTime) || body.startTime === body.endTime) {
    throw new ApiError("Choose valid start and end times; they must be different.", 400);
  }
  const row = { program_name: program, enabled: body.enabled === undefined ? true : body.enabled, start_time: body.startTime, end_time: body.endTime, start_behavior: behavior };
  if (kind === "weekly") row.weekday = body.weekday;
  else {
    row.schedule_date = body.date;
    row.disabled = false;
    if (typeof body.note === "string") row.note = body.note.trim().slice(0, 500);
  }
  return row;
}

async function scheduleConflict(kind, row, excludeId) {
  if (row.enabled !== true) return false;
  const table = kind === "weekly" ? "schedules" : "schedule_overrides";
  const select = kind === "weekly" ? "id,weekday,start_time,end_time,enabled" : "id,start_time,end_time,enabled,disabled,schedule_date";
  let query = `${table}?select=${select}&enabled=eq.true`;
  if (kind === "override") {
    if (typeof row.schedule_date !== "string") return false;
    query += `&schedule_date=in.(${[shiftDate(row.schedule_date, -1), row.schedule_date, shiftDate(row.schedule_date, 1)].join(",")})`;
  }
  if (excludeId) query += `&id=neq.${encodeURIComponent(excludeId)}`;
  const { data } = await rest(query);
  return (data || []).some((other) => {
    if (kind === "weekly") return weeklyConflict(Number(row.weekday), String(row.start_time), String(row.end_time), other);
    const start = row.disabled === true ? "00:00" : String(row.start_time);
    const end = row.disabled === true ? "00:00" : String(row.end_time);
    return overrideConflict(String(row.schedule_date), start, end, other, row.disabled === true);
  });
}

function scheduleRowForWrite(row) {
  if (hasProgramName) return row;
  const { program_name, ...restRow } = row;
  return restRow;
}

export function occurrencesFor(date, weekly, overrides) {
  const dayOverrides = overrides.filter((row) => row.schedule_date === date);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const rows = dayOverrides.length
    ? dayOverrides.filter((row) => row.enabled && !row.disabled && row.start_time && row.end_time).map((row) => ({ start_time: row.start_time, end_time: row.end_time, program_name: row.program_name }))
    : weekly.filter((row) => row.enabled && row.weekday === weekday).map((row) => ({ start_time: row.start_time, end_time: row.end_time, program_name: row.program_name }));
  return rows.map((row) => {
    const [year, month, day] = date.split("-").map(Number);
    const [startHour, startMinute] = row.start_time.split(":").map(Number);
    const [endHour, endMinute] = row.end_time.split(":").map(Number);
    const start = Date.UTC(year, month - 1, day, startHour, startMinute) - 7 * 3_600_000;
    let end = Date.UTC(year, month - 1, day, endHour, endMinute) - 7 * 3_600_000;
    if (end <= start) end += 86_400_000;
    return { programName: row.program_name || "Untitled program", start, end };
  });
}

async function loadSchedules() {
  await ensureSchema();
  const [weeklyResult, overrideResult] = await Promise.all([
    rest(`schedules?select=${WEEKLY_COLUMNS()}&order=weekday.asc,start_time.asc`),
    rest(`schedule_overrides?select=${OVERRIDE_COLUMNS()}&order=schedule_date.asc,start_time.asc`),
  ]);
  return {
    weekly: (weeklyResult.data || []).map(withProgramName),
    overrides: (overrideResult.data || []).map(withProgramName),
    schemaReady: hasProgramName !== false,
  };
}

/* ---------------------------------------------------------------- player */

function playerAuthorized(headers) {
  const provided = headers["x-player-token"];
  if (!PLAYER_TOKEN || typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(PLAYER_TOKEN);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- request */

export function validateSongRequest(body) {
  if (!body || typeof body !== "object") return null;
  const requesterName = typeof body.requesterName === "string" ? body.requesterName.trim() : "";
  const videoId = typeof body.videoId === "string" ? body.videoId : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const channelName = typeof body.channelName === "string" ? body.channelName.trim() : "";
  const thumbnailUrl = typeof body.thumbnailUrl === "string" ? body.thumbnailUrl : "";
  if (requesterName.length < 1 || requesterName.length > 60) return null;
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  if (title.length < 1 || title.length > 200) return null;
  if (channelName.length < 1 || channelName.length > 120) return null;
  if (thumbnailUrl.length > 500) return null;
  let host;
  try {
    host = new URL(thumbnailUrl).hostname;
  } catch {
    return null;
  }
  if (host !== "i.ytimg.com" && host !== "img.youtube.com") return null;
  return { requesterName, videoId, title, channelName, thumbnailUrl };
}

/* ------------------------------------------------------------------ api */

const searchCache = new Map();
const SEARCH_CACHE_LIMIT = 50;

async function searchYouTube(query) {
  const cached = searchCache.get(query);
  if (cached && Date.now() - cached.at < 30_000) return cached.videos;
  if (!YOUTUBE_KEY) throw new ApiError("Song search is not configured.", 503);
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.search = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoEmbeddable: "true",
    safeSearch: "strict",
    maxResults: "8",
    q: query,
    key: YOUTUBE_KEY,
  }).toString();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new ApiError("YouTube search is temporarily unavailable.", 502);
  }
  if (!response.ok) throw new ApiError("YouTube search is temporarily unavailable.", 502);
  const payload = await response.json();
  const videos = (payload.items || [])
    .map((item) => ({
      id: item.id?.videoId,
      title: item.snippet?.title,
      channelName: item.snippet?.channelTitle,
      thumbnailUrl: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url,
    }))
    .filter((video) => video.id && video.title && video.channelName && video.thumbnailUrl);
  searchCache.set(query, { at: Date.now(), videos });
  if (searchCache.size > SEARCH_CACHE_LIMIT) searchCache.delete(searchCache.keys().next().value);
  return videos;
}

/** Turns the player's heartbeat into the single source of truth for "now playing",
    so the public queue and the admin dashboard always agree. */
function describeNow(current, progress) {
  if (!progress || !progress.updatedAt) return null;
  const age = Date.now() - Date.parse(progress.updatedAt);
  if (!Number.isFinite(age) || age > 20000) return null;
  const state = String(progress.state || "");
  if (state !== "playing" && state !== "paused") return null;
  const sameRequest = Boolean(current && progress.requestId && current.id === progress.requestId);
  return {
    title: progress.title || (current && current.title) || "",
    channelName: sameRequest ? current.channel_name : "",
    requesterName: sameRequest ? current.requester_name : "",
    position: Number.isFinite(progress.position) ? progress.position : null,
    duration: Number.isFinite(progress.duration) ? progress.duration : null,
    state,
    test: progress.test === true,
    previous: progress.previous === true,
  };
}

async function publicQueue() {
  const [currentResult, upcomingResult, historyResult, settingsResult, progressResult] = await Promise.all([
    rest("requests?select=id,title,channel_name,requester_name,updated_at&status=eq.playing&order=updated_at.desc&limit=1"),
    rest("requests?select=id,title,channel_name,requester_name,created_at,status&status=eq.approved&order=queue_position.asc.nullslast,created_at.asc&limit=20"),
    rest("playback_history?select=title,channel_name,played_at&status=eq.played&order=played_at.desc&limit=8"),
    rest("system_settings?select=key,value&key=in.(radio_name,moderation_mode,timezone)"),
    rest("system_settings?select=key,value&key=eq.player_progress"),
  ]);
  const settings = Object.fromEntries((settingsResult.data || []).map((row) => [row.key, row.value]));
  const current = (currentResult.data || [])[0] || null;
  const progressRow = (progressResult.data || [])[0];
  const progress = progressRow && progressRow.value ? progressRow.value : null;
  return {
    current,
    now: describeNow(current, progress),
    upcoming: upcomingResult.data || [],
    history: historyResult.data || [],
    radioName: settings.radio_name || "School Radio",
    moderationMode: settings.moderation_mode || "manual",
  };
}

async function playerSchedule() {
  const now = new Date();
  const today = jakartaToday();
  const { weekly, overrides } = await loadSchedules();
  const windowOverrides = overrides.filter((row) => row.schedule_date >= shiftDate(today, -1) && row.schedule_date <= shiftDate(today, 8));
  const all = [];
  for (let offset = -1; offset <= 8; offset += 1) {
    all.push(...occurrencesFor(shiftDate(today, offset), weekly, windowOverrides));
  }
  all.sort((a, b) => a.start - b.start);
  const instant = now.getTime();
  const active = all.find((item) => item.start <= instant && instant < item.end) || null;
  const next = all.find((item) => item.start > instant) || null;
  const shape = (item) => (item ? { programName: item.programName, start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString() } : null);
  return { active: shape(active), next: shape(next), checkedAt: now.toISOString() };
}

async function adminOverview() {
  await ensureSchema();
  const today = jakartaToday();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const [deviceResult, pendingResult, pendingCount, queueCount, playedToday, scheduleCount, scheduleResult, playingResult, recentResult, progressResult] = await Promise.all([
    rest("player_devices?select=state,last_seen_at,emergency_stopped&order=last_seen_at.desc.nullslast&limit=1"),
    rest("requests?select=id,title,channel_name,requester_name,status,created_at&status=eq.pending&order=created_at.asc&limit=6"),
    restCount("requests?status=eq.pending"),
    restCount("requests?status=eq.approved"),
    restCount(`playback_history?status=eq.played&played_at=gte.${encodeURIComponent(jakartaDayStart())}`),
    restCount("schedules?enabled=eq.true"),
    rest(`schedules?select=${WEEKLY_COLUMNS()}&weekday=eq.${weekday}&enabled=eq.true&order=start_time.asc`),
    rest("requests?select=id,title,channel_name,requester_name&status=eq.playing&limit=1"),
    rest("playback_history?select=video_id,title,channel_name,played_at,status&order=played_at.desc&limit=6"),
    rest("system_settings?select=key,value&key=eq.player_progress"),
  ]);
  const device = (deviceResult.data || [])[0] || null;
  const recent = recentResult.data || [];
  const progressRow = (progressResult.data || [])[0];
  const progress = progressRow && progressRow.value ? progressRow.value : null;
  const lastFinished = recent.find((item) => item.status === "played" || item.status === "skipped") || null;
  return {
    device,
    current: (playingResult.data || [])[0] || null,
    recent,
    progress,
    lastFinished,
    counts: { pending: pendingCount, queue: queueCount, playedToday, schedules: scheduleCount },
    pending: pendingResult.data || [],
    todaySchedule: (scheduleResult.data || []).map(withProgramName),
    radioTime: new Intl.DateTimeFormat("en-GB", { timeZone: JAKARTA, hour: "2-digit", minute: "2-digit" }).format(new Date()),
  };
}

async function adminStatistics() {
  const start = jakartaDayStart(6);
  const { data } = await rest(`playback_history?select=played_at&status=eq.played&played_at=gte.${encodeURIComponent(start)}&limit=2000`);
  const buckets = new Map();
  for (let offset = 6; offset >= 0; offset -= 1) buckets.set(shiftDate(jakartaToday(), -offset), 0);
  for (const row of data || []) {
    const key = Object.fromEntries(dateFormatter.formatToParts(new Date(row.played_at)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const day = `${key.year}-${key.month}-${key.day}`;
    if (buckets.has(day)) buckets.set(day, buckets.get(day) + 1);
  }
  const [pending, schedules, queue] = await Promise.all([
    restCount("requests?status=eq.pending"),
    restCount("schedules?enabled=eq.true"),
    restCount("requests?status=eq.approved"),
  ]);
  const series = [...buckets.entries()].map(([date, count]) => ({ date, count }));
  return { series, pending, schedules, queue, total: series.reduce((sum, item) => sum + item.count, 0) };
}

async function adminSettings() {
  const { data } = await rest("system_settings?select=key,value&key=in.(radio_name,moderation_mode,request_limit_per_hour,timezone)");
  const values = Object.fromEntries((data || []).map((row) => [row.key, row.value]));
  return {
    radioName: String(values.radio_name || "School Radio"),
    moderationMode: String(values.moderation_mode || "manual"),
    requestLimit: Number(values.request_limit_per_hour || 5),
    timezone: String(values.timezone || JAKARTA),
  };
}

/* --------------------------------------------------------------- routing */

const json = (status, body, headers) => ({ status, body, headers });

/**
 * Framework-agnostic API router. Returns { status, body, headers }.
 * `request` = { method, pathname, searchParams, headers, body, ip }
 */
export async function handleApi(request) {
  assertConfiguration();
  const { method, pathname, headers, body } = request;
  const searchParams = request.searchParams;

  if (pathname === "/api/config" && method === "GET") {
    return json(200, { supabaseUrl: SB_URL, supabaseAnonKey: SB_ANON, radioTimezone: JAKARTA });
  }

  if (pathname === "/api/public/queue" && method === "GET") {
    return json(200, await publicQueue());
  }

  if (pathname === "/api/search" && method === "GET") {
    const query = (searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 100) return json(400, { error: "Search must be between 2 and 100 characters." });
    return json(200, { videos: await searchYouTube(query) });
  }

  if (pathname === "/api/requests" && method === "POST") {
    const song = validateSongRequest(body);
    if (!song) return json(400, { error: "Enter your name and select a valid song." });
    try {
      const { data } = await rest("rpc/submit_song_request", {
        method: "POST",
        body: {
          p_requester_name: song.requesterName,
          p_video_id: song.videoId,
          p_title: song.title,
          p_channel_name: song.channelName,
          p_thumbnail_url: song.thumbnailUrl,
          p_client_ip: request.ip || "unknown",
        },
      });
      return json(200, { id: data });
    } catch (error) {
      if (error instanceof ApiError && error.message.includes("rate_limit")) {
        return json(429, { error: "Request limit reached. Please wait before requesting again." });
      }
      console.error("[api/requests]", error.message);
      return json(500, { error: "Request could not be saved. Please try again." });
    }
  }

  if (pathname === "/api/player" && method === "GET") {
    const [device, settings] = await Promise.all([
      rest("player_devices?select=state,emergency_stopped,last_seen_at,current_request_id&order=last_seen_at.desc.nullslast&limit=1"),
      rest("system_settings?select=key,value&key=in.(timezone,radio_name)"),
    ]);
    return json(200, {
      device: (device.data || [])[0] || null,
      settings: Object.fromEntries((settings.data || []).map((row) => [row.key, row.value])),
    });
  }

  if (pathname === "/api/player" && method === "POST") {
    if (!playerAuthorized(headers)) return json(401, { error: "Player is not authorized." });
    const payload = body && typeof body === "object" ? body : {};
    if (payload.action === "heartbeat") {
      const id = String(payload.deviceId || "");
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(400, { error: "deviceId required" });
      const existing = await rest(`player_devices?select=current_request_id&id=eq.${encodeURIComponent(id)}`);
      const current = (existing.data || [])[0];
      if (current?.current_request_id && current.current_request_id !== payload.requestId) {
        await rest("rpc/finish_playback", { method: "POST", body: { p_request_id: current.current_request_id, p_status: "skipped", p_reason: "player_reconnected" } });
      }
      const { data } = await rest("rpc/player_heartbeat", {
        method: "POST",
        body: { p_device_id: id, p_state: String(payload.state || "ready"), p_current_request_id: payload.requestId || null },
      });
      const progress = {
        deviceId: id,
        state: String(payload.state || "ready"),
        requestId: payload.requestId || null,
        title: typeof payload.title === "string" ? payload.title.slice(0, 200) : null,
        videoId: typeof payload.videoId === "string" ? payload.videoId : null,
        test: payload.test === true,
        previous: payload.previous === true,
        position: Number.isFinite(payload.position) ? payload.position : null,
        duration: Number.isFinite(payload.duration) ? payload.duration : null,
        updatedAt: new Date().toISOString(),
      };
      try {
        await rest("system_settings?on_conflict=key", {
          method: "POST",
          headers: { prefer: "resolution=merge-duplicates,return=minimal" },
          body: [{ key: "player_progress", value: progress }],
        });
      } catch (error) {
        console.warn("[api/player] could not store progress:", error.message);
      }
      return json(200, { commands: data || [] });
    }
    if (payload.action === "claim") {
      const { data } = await rest("rpc/claim_next_request", { method: "POST", body: {} });
      return json(200, { item: (data || [])[0] || null });
    }
    if (payload.action === "finish") {
      if (typeof payload.requestId !== "string") return json(400, { error: "requestId required" });
      await rest("rpc/finish_playback", {
        method: "POST",
        body: { p_request_id: payload.requestId, p_status: payload.status === "skipped" ? "skipped" : "played", p_reason: String(payload.reason || "") },
      });
      return json(200, { ok: true });
    }
    return json(400, { error: "Unknown action." });
  }

  if (pathname === "/api/player/schedule" && method === "GET") {
    return json(200, await playerSchedule());
  }

  /* -------------------------------------------------------- admin APIs */

  if (pathname.startsWith("/api/admin/")) {
    const admin = await requireAdmin(headers);
    if (!admin) return json(401, { error: "Unauthorized" });

    if (pathname === "/api/admin/me" && method === "GET") {
      return json(200, { user: { id: admin.id, email: admin.email || "" }, isAdmin: true });
    }

    if (pathname === "/api/admin/overview" && method === "GET") {
      return json(200, await adminOverview());
    }

    if (pathname === "/api/admin/requests" && method === "GET") {
      const status = searchParams.get("status") === "pending" ? "pending" : "approved";
      const { data } = await rest(`requests?select=id,title,channel_name,requester_name,status,created_at,queue_position&status=eq.${status}&order=${status === "approved" ? "queue_position.asc.nullslast,created_at.asc" : "created_at.asc"}&limit=200`);
      return json(200, { items: data || [] });
    }

    if (pathname === "/api/admin/requests" && method === "PATCH") {
      if (!body || typeof body.id !== "string") return json(400, { error: "Invalid request update." });
      let values;
      if (["approved", "rejected", "cancelled"].includes(body.status)) values = { status: body.status };
      else if (Number.isInteger(body.queuePosition) && body.queuePosition >= 0 && body.queuePosition <= 10000) values = { queue_position: body.queuePosition };
      else return json(400, { error: "Invalid request update." });
      const { data } = await rest(`requests?id=eq.${encodeURIComponent(body.id)}&status=in.(pending,approved)`, {
        method: "PATCH",
        body: values,
        headers: { prefer: "return=representation" },
      });
      if (!Array.isArray(data) || !data.length) return json(404, { error: "That request can no longer be changed." });
      return json(200, { ok: true });
    }

    if (pathname === "/api/admin/requests" && method === "DELETE") {
      if (!body || typeof body.id !== "string") return json(400, { error: "Request id required." });
      const { data } = await rest(`requests?id=eq.${encodeURIComponent(body.id)}&status=in.(pending,approved)`, {
        method: "DELETE",
        headers: { prefer: "return=representation" },
      });
      if (!Array.isArray(data) || !data.length) return json(404, { error: "That request is already closed or removed." });
      return json(200, { ok: true });
    }

    if (pathname === "/api/admin/history" && method === "GET") {
      const { data } = await rest("playback_history?select=title,channel_name,requester_name,played_at,status,reason&order=played_at.desc&limit=200");
      return json(200, { items: data || [] });
    }

    if (pathname === "/api/admin/statistics" && method === "GET") {
      return json(200, await adminStatistics());
    }

    if (pathname === "/api/admin/schedules" && method === "GET") {
      return json(200, await loadSchedules());
    }

    if (pathname === "/api/admin/schedules" && method === "POST") {
      await ensureSchema();
      if (!hasProgramName) return json(503, { error: "Programme names need the database migration 202611220003_schedule_program_names.sql before sessions can be saved." });
      if (!body || (body.kind !== "weekly" && body.kind !== "override")) return json(400, { error: "Invalid schedule request." });
      const row = validateSchedule(body, body.kind);
      if (await scheduleConflict(body.kind, row)) return json(409, { error: "This session overlaps another enabled session." });
      const table = body.kind === "weekly" ? "schedules" : "schedule_overrides";
      await rest(table, { method: "POST", body: scheduleRowForWrite(row), headers: { prefer: "return=minimal" } });
      return json(200, { ok: true });
    }

    if (pathname === "/api/admin/schedules" && method === "PATCH") {
      await ensureSchema();
      if (!hasProgramName) return json(503, { error: "Programme names need the database migration 202611220003_schedule_program_names.sql before sessions can be saved." });
      if (!body || typeof body.id !== "string" || !body.id || (body.kind !== "weekly" && body.kind !== "override")) return json(400, { error: "Invalid schedule update." });
      const table = body.kind === "weekly" ? "schedules" : "schedule_overrides";
      const enabledOnly = typeof body.enabled === "boolean" && Object.keys(body).every((key) => ["id", "kind", "enabled"].includes(key));
      const update = enabledOnly ? { enabled: body.enabled } : validateSchedule(body, body.kind);
      const existingResult = await rest(`${table}?select=${body.kind === "weekly" ? "id,enabled" : "id,enabled,disabled"}&id=eq.${encodeURIComponent(body.id)}`);
      const existing = (existingResult.data || [])[0];
      if (!existing) return json(404, { error: "Schedule was not found." });
      const next = { ...existing, ...update };
      if (next.enabled === true) {
        let candidate = update;
        if (enabledOnly) {
          const fullResult = await rest(`${table}?select=${body.kind === "weekly" ? WEEKLY_COLUMNS(",playlist_id") : OVERRIDE_COLUMNS(",playlist_id")}&id=eq.${encodeURIComponent(body.id)}`);
          candidate = { ...(fullResult.data || [])[0], ...update };
        }
        const closed = body.kind === "override" && candidate.disabled === true;
        if (closed || (typeof candidate.start_time === "string" && typeof candidate.end_time === "string")) {
          if (await scheduleConflict(body.kind, candidate, body.id)) {
            return json(409, { error: closed ? "A closed-day override cannot overlap another enabled override." : "This session overlaps another enabled session." });
          }
        }
      }
      await rest(`${table}?id=eq.${encodeURIComponent(body.id)}`, { method: "PATCH", body: scheduleRowForWrite(update), headers: { prefer: "return=minimal" } });
      return json(200, { ok: true });
    }

    if (pathname === "/api/admin/schedules" && method === "DELETE") {
      if (!body || typeof body.id !== "string" || !body.id || (body.kind !== "weekly" && body.kind !== "override")) return json(400, { error: "Invalid schedule delete." });
      const table = body.kind === "weekly" ? "schedules" : "schedule_overrides";
      await rest(`${table}?id=eq.${encodeURIComponent(body.id)}`, { method: "DELETE" });
      return json(200, { ok: true });
    }

    if (pathname === "/api/admin/settings" && method === "GET") {
      return json(200, await adminSettings());
    }

    if (pathname === "/api/admin/settings" && method === "PUT") {
      if (!body || !["manual", "automatic"].includes(body.moderationMode) || !Number.isInteger(body.requestLimit) || body.requestLimit < 1 || body.requestLimit > 50 || typeof body.radioName !== "string" || body.radioName.trim().length < 1 || body.radioName.trim().length > 80 || body.timezone !== JAKARTA) {
        return json(400, { error: "Invalid settings. Timezone currently supports Asia/Jakarta only." });
      }
      await rest("system_settings?on_conflict=key", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=minimal" },
        body: [
          { key: "moderation_mode", value: body.moderationMode },
          { key: "request_limit_per_hour", value: body.requestLimit },
          { key: "radio_name", value: body.radioName.trim() },
          { key: "timezone", value: body.timezone },
        ],
      });
      return json(200, { ok: true });
    }

    if (pathname === "/api/admin/commands" && method === "POST") {
      const allowed = ["play", "pause", "resume", "next", "previous", "stop", "volume", "emergency_stop", "emergency_resume"];
      if (!body || !allowed.includes(body.command)) return json(400, { error: "Invalid command." });
      const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

      if (body.command === "previous") {
        const { data } = await rest("playback_history?select=video_id,title,channel_name&order=played_at.desc&limit=1");
        const last = (data || [])[0];
        if (!last || !last.video_id) return json(404, { error: "There is no earlier song to replay yet." });
        const created = await rest("player_commands", {
          method: "POST",
          headers: { prefer: "return=representation" },
          body: {
            command: "play",
            payload: { videoId: last.video_id, title: last.title, channelName: last.channel_name, test: false, previous: true },
            priority: 10,
            issued_by: admin.id,
          },
        });
        const row = (created.data || [])[0] || {};
        return json(200, { ok: true, id: row.id || null, command: "play", replaying: { title: last.title, videoId: last.video_id } });
      }

      if (body.command === "volume" && (typeof payload.volume !== "number" || payload.volume < 0 || payload.volume > 100)) {
        return json(400, { error: "Volume must be between 0 and 100." });
      }
      if (body.command === "play" && payload.videoId !== undefined) {
        if (typeof payload.videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(payload.videoId)) {
          return json(400, { error: "Choose a valid YouTube video to test." });
        }
        if (typeof payload.title === "string") payload.title = payload.title.slice(0, 200);
        if (typeof payload.channelName === "string") payload.channelName = payload.channelName.slice(0, 120);
      }
      const priority = body.command === "emergency_stop" ? 100 : body.command === "emergency_resume" ? 90 : 10;
      const created = await rest("player_commands", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: { command: body.command, payload, priority, issued_by: admin.id },
      });
      const row = (created.data || [])[0] || {};
      if (body.command === "emergency_stop") {
        await rest("player_devices?id=neq.00000000-0000-0000-0000-000000000000", { method: "PATCH", body: { emergency_stopped: true, state: "emergency_stopped" }, headers: { prefer: "return=minimal" } });
      }
      if (body.command === "emergency_resume") {
        await rest("player_devices?id=neq.00000000-0000-0000-0000-000000000000", { method: "PATCH", body: { emergency_stopped: false, state: "ready" }, headers: { prefer: "return=minimal" } });
      }
      return json(200, { ok: true, id: row.id || null, command: body.command });
    }

    /* Command delivery status: the player acknowledges each command on its next
       heartbeat, so the dashboard can show "delivered" instead of guessing. */
    if (pathname === "/api/admin/commands" && method === "GET") {
      const limit = Math.min(20, Math.max(1, Number(searchParams.get("limit")) || 8));
      const [commandsResult, deviceResult] = await Promise.all([
        rest(`player_commands?select=id,command,payload,priority,created_at,acknowledged_at&order=created_at.desc&limit=${limit}`),
        rest("player_devices?select=state,last_seen_at,emergency_stopped&order=last_seen_at.desc.nullslast&limit=1"),
      ]);
      const device = (deviceResult.data || [])[0] || null;
      const online = Boolean(device && device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 15000);
      const items = (commandsResult.data || []).map((row) => ({
        id: row.id,
        command: row.command,
        title: row.payload && typeof row.payload.title === "string" ? row.payload.title : null,
        videoId: row.payload && typeof row.payload.videoId === "string" ? row.payload.videoId : null,
        createdAt: row.created_at,
        acknowledgedAt: row.acknowledged_at,
        delivered: Boolean(row.acknowledged_at),
        pendingSeconds: row.acknowledged_at ? 0 : Math.max(0, Math.round((Date.now() - new Date(row.created_at).getTime()) / 1000)),
      }));
      return json(200, { items, online, deviceState: device ? device.state : null });
    }

    return json(404, { error: "Not found." });
  }

  return json(404, { error: "Not found." });
}

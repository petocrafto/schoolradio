import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, assertConfiguration, configuration, ensureSchema, handleApi, overrideConflict, validateSchedule, validateSongRequest, weeklyConflict } from "./lib/core.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);

/* ---------------------------------------------------------------- static */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(response, pathname, status = 200) {
  let relative = decodeURIComponent(pathname);
  if (relative.includes("\0")) return false;
  if (relative.endsWith("/")) relative += "index.html";
  const target = path.resolve(SITE, `.${relative}`);
  if (target !== SITE && !target.startsWith(SITE + path.sep)) return false;

  const candidates = [target];
  if (!path.extname(target)) {
    candidates.push(`${target}.html`);
    candidates.push(path.join(target, "index.html"));
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith(SITE + path.sep)) continue;
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      response.writeHead(status, {
        "content-type": MIME[path.extname(candidate).toLowerCase()] || "application/octet-stream",
        "cache-control": "no-cache",
        "content-length": stat.size,
        "x-content-type-options": "nosniff",
      });
      if (response.req.method === "HEAD") {
        response.end();
        return true;
      }
      fs.createReadStream(candidate).pipe(response);
      return true;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

/* ------------------------------------------------------------------ body */

async function readJson(request, limit = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ApiError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function clientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return request.socket.remoteAddress || "unknown";
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/* ----------------------------------------------------------------- http */

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const body = request.method === "GET" || request.method === "HEAD" ? null : await readJson(request);
      const result = await handleApi({
        method: request.method || "GET",
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers: request.headers,
        body,
        ip: clientIp(request),
      });
      return sendJson(response, result.status, result.body);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }
    if (serveStatic(response, url.pathname)) return;
    if (serveStatic(response, "/404.html", 404)) return;
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    if (status >= 500) console.error(`[${request.method} ${url.pathname}]`, error.message);
    if (!response.headersSent) sendJson(response, status, { error: status >= 500 ? "Something went wrong. Please try again." : error.message });
    else response.end();
  }
});

/* ------------------------------------------------------------ self-test */

function selfTest() {
  const assert = (condition, message) => {
    if (!condition) {
      console.error(`FAIL: ${message}`);
      process.exitCode = 1;
    } else {
      console.log(`ok - ${message}`);
    }
  };
  assert(weeklyConflict(1, "07:00", "09:00", { weekday: 1, start_time: "08:00:00", end_time: "10:00:00" }), "weekly overlap detected");
  assert(!weeklyConflict(1, "07:00", "09:00", { weekday: 1, start_time: "09:00:00", end_time: "10:00:00" }), "adjacent weekly sessions allowed");
  assert(weeklyConflict(1, "23:00", "01:00", { weekday: 2, start_time: "00:30:00", end_time: "02:00:00" }), "overnight session overlaps next day");
  assert(!weeklyConflict(1, "07:00", "09:00", { weekday: 2, start_time: "07:00:00", end_time: "09:00:00" }), "different weekday allowed");
  assert(overrideConflict("2026-11-22", "10:00", "12:00", { schedule_date: "2026-11-22", start_time: "11:00:00", end_time: "13:00:00", disabled: false }), "same-day override overlap");
  assert(!overrideConflict("2026-11-22", "10:00", "12:00", { schedule_date: "2026-11-23", start_time: "10:00:00", end_time: "12:00:00", disabled: false }), "different day override allowed");
  assert(overrideConflict("2026-11-22", "10:00", "12:00", { schedule_date: "2026-11-22", start_time: null, end_time: null, disabled: true }, false), "closed day blocks sessions");
  assert(!overrideConflict("2026-11-22", "10:00", "12:00", { schedule_date: "2026-11-24", start_time: null, end_time: null, disabled: true }, false), "closed day only affects its date");
  assert(validateSongRequest({ requesterName: "A", videoId: "dQw4w9WgXcQ", title: "T", channelName: "C", thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hq.jpg" }) !== null, "valid song request accepted");
  assert(validateSongRequest({ requesterName: "A", videoId: "short", title: "T", channelName: "C", thumbnailUrl: "https://i.ytimg.com/x.jpg" }) === null, "invalid video id rejected");
  assert(validateSongRequest({ requesterName: "A", videoId: "dQw4w9WgXcQ", title: "T", channelName: "C", thumbnailUrl: "https://evil.example/x.jpg" }) === null, "non-YouTube thumbnail rejected");

  let rejected = false;
  try {
    validateSchedule({ programName: "X", weekday: 1, startTime: "10:00", endTime: "10:00" }, "weekly");
  } catch (error) {
    rejected = error instanceof ApiError && error.status === 400;
  }
  assert(rejected, "equal schedule times rejected");

  const closed = validateSchedule({ programName: "Closed", date: "2026-12-02", disabled: true }, "override");
  assert(closed.schedule_date === "2026-12-02" && closed.disabled === true && closed.start_time === null, "closed-day override keeps its date");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(process.exitCode || 0);
}

/* ----------------------------------------------------------------- boot */

assertConfiguration();
await ensureSchema();

const config = configuration();
server.listen(PORT, () => {
  console.log(`School Radio listening on http://localhost:${PORT}`);
  console.log(`Supabase: ${config.supabaseUrl}`);
  console.log(`YouTube search: ${config.hasYouTubeKey ? "enabled" : "not configured"}`);
  console.log(`Player token: ${config.hasPlayerToken ? "configured" : "missing"}`);
});

import { api, clockFormat, escapeHtml, getSupabase, timeRange } from "./common.js";

const heroState = document.querySelector("#hero-state");
const heroTitle = document.querySelector("#hero-title");
const heroMeta = document.querySelector("#hero-meta");
const heroProgram = document.querySelector("#hero-program");
const heroClock = document.querySelector("#hero-clock");
const heroProgress = document.querySelector("#hero-progress");
const heroTime = document.querySelector("#hero-time");
const heroUpNext = document.querySelector("#hero-upnext");
const livePill = document.querySelector("#live-pill");
const liveText = document.querySelector("#live-text");

let schedule = null;
let now = null;
let fetchedAt = 0;

function mmss(total) {
  if (!Number.isFinite(total) || total < 0) return "--:--";
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function livePosition() {
  if (!now || !Number.isFinite(now.position)) return null;
  const elapsed = now.state === "playing" ? (Date.now() - fetchedAt) / 1000 : 0;
  const value = now.position + elapsed;
  return Number.isFinite(now.duration) && now.duration > 0 ? Math.min(value, now.duration) : value;
}

function paintProgress() {
  if (!heroProgress || !heroTime) return;
  const position = livePosition();
  const percent = position !== null && now && Number.isFinite(now.duration) && now.duration > 0 ? Math.min(100, (position / now.duration) * 100) : 0;
  heroProgress.style.width = `${percent}%`;
  heroTime.textContent = now ? `${mmss(position)} / ${mmss(now.duration)}` : "";
}

function renderClock() {
  heroClock.textContent = clockFormat(new Date());
}

function renderState(state) {
  const playing = state === "playing";
  const paused = state === "paused";
  livePill.classList.toggle("on", playing);
  liveText.textContent = playing ? "On air" : paused ? "Paused" : "Off air";
  heroState.textContent = playing ? "LIVE" : paused ? "PAUSED" : "OFF AIR";
  heroState.className = playing ? "badge accent" : paused ? "badge warning" : "badge";
}

function render(queue) {
  now = queue.now || null;
  fetchedAt = Date.now();
  renderState(now ? now.state : "");

  if (now) {
    heroTitle.textContent = now.title;
    const credit = now.test
      ? "test playback from the studio"
      : now.previous
        ? "replayed by the studio"
        : now.requesterName
          ? `requested by ${now.requesterName}`
          : "";
    heroMeta.textContent = [now.channelName, credit].filter(Boolean).join(" · ");
  } else {
    heroTitle.textContent = "Nothing playing right now";
    heroMeta.textContent = "The studio is between tracks. Send a request to get things going.";
  }
  paintProgress();

  if (schedule?.active) {
    heroProgram.textContent = `${schedule.active.programName} · ${timeRange(schedule.active.start, schedule.active.end)}`;
  } else if (schedule?.next) {
    heroProgram.textContent = `Next programme: ${schedule.next.programName}`;
  } else {
    heroProgram.textContent = "No programme scheduled";
  }

  const upNext = queue.upcoming.slice(0, 3);
  heroUpNext.innerHTML = upNext.length
    ? upNext
        .map(
          (item, index) => `
          <div class="list-item">
            <span class="index">${index + 1}</span>
            <span class="grow">
              <strong>${escapeHtml(item.title)}</strong>
              <span class="muted tiny">${escapeHtml(item.channel_name)} · requested by ${escapeHtml(item.requester_name)}</span>
            </span>
          </div>`,
        )
        .join("")
    : `<div class="empty">The queue is empty. <a href="/request">Request the first song →</a></div>`;
}

async function refresh() {
  try {
    const [queue, scheduleData] = await Promise.all([api("/api/public/queue"), api("/api/player/schedule")]);
    schedule = scheduleData;
    render(queue);
  } catch {
    heroTitle.textContent = "Radio data is unavailable";
    heroMeta.textContent = "Could not reach the station. Retrying automatically.";
    renderState("");
  }
}

renderClock();
setInterval(renderClock, 1000);
setInterval(paintProgress, 1000);
refresh();
setInterval(refresh, 5_000);

getSupabase()
  .then((db) => {
    const channel = db
      .channel("home-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "playback_history" }, refresh)
      .subscribe();
    window.addEventListener("pagehide", () => void db.removeChannel(channel), { once: true });
  })
  .catch(() => {
    /* polling already covers this */
  });

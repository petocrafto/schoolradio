import { api, dateTimeOf, debounce, escapeHtml, getSupabase } from "./common.js";

const nowBody = document.querySelector("#now-body");
const nowBadge = document.querySelector("#now-badge");
const upcoming = document.querySelector("#upcoming");
const queueCount = document.querySelector("#queue-count");
const historyBody = document.querySelector("#history");
const historyWrap = document.querySelector("#history-wrap");
const historyEmpty = document.querySelector("#history-empty");
const historyCount = document.querySelector("#history-count");
const updated = document.querySelector("#updated");
const livePill = document.querySelector("#live-pill");
const liveText = document.querySelector("#live-text");

let now = null;
let fetchedAt = 0;
let lastError = false;

function mmss(total) {
  if (!Number.isFinite(total) || total < 0) return "--:--";
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Position advances locally between polls so the seconds tick every second. */
function livePosition() {
  if (!now || !Number.isFinite(now.position)) return null;
  const elapsed = now.state === "playing" ? (Date.now() - fetchedAt) / 1000 : 0;
  const value = now.position + elapsed;
  return Number.isFinite(now.duration) && now.duration > 0 ? Math.min(value, now.duration) : value;
}

function renderNow() {
  const playing = Boolean(now);
  livePill.classList.toggle("on", playing);
  liveText.textContent = playing ? "On air" : "Off air";
  nowBadge.textContent = !playing ? "OFF AIR" : now.state === "paused" ? "PAUSED" : "LIVE";
  nowBadge.className = !playing ? "badge" : now.state === "paused" ? "badge warning" : "badge accent";

  if (!playing) {
    nowBody.innerHTML = `<p class="muted" style="margin:0">Nothing is playing right now. <a href="/request">Request a song →</a></p>`;
    return;
  }

  const credit = now.test
    ? "test playback from the studio"
    : now.previous
      ? "replayed by the studio"
      : now.requesterName
        ? `requested by ${now.requesterName}`
        : "";
  const subtitle = [now.channelName, credit].filter(Boolean).join(" · ");

  nowBody.innerHTML = `
    <div class="now-playing">
      <div class="title">${escapeHtml(now.title)}</div>
      <div class="artist">${escapeHtml(subtitle)}</div>
    </div>
    <div class="progress" style="margin:16px 0 6px"><span id="now-progress"></span></div>
    <div class="row-between tiny muted">
      <span class="mono" id="now-time">${mmss(now.position)} / ${mmss(now.duration)}</span>
      <span id="now-remaining"></span>
    </div>`;
  paintProgress();
}

function paintProgress() {
  const bar = document.querySelector("#now-progress");
  const time = document.querySelector("#now-time");
  const remaining = document.querySelector("#now-remaining");
  if (!bar || !now) return;
  const position = livePosition();
  const percent = position !== null && Number.isFinite(now.duration) && now.duration > 0 ? Math.min(100, (position / now.duration) * 100) : 0;
  bar.style.width = `${percent}%`;
  if (time) time.textContent = `${mmss(position)} / ${mmss(now.duration)}`;
  if (remaining) {
    remaining.textContent = Number.isFinite(now.duration) && now.duration > 0 ? `${mmss(Math.max(0, now.duration - (position || 0)))} left` : "";
  }
}

function render(queue) {
  now = queue.now || null;
  fetchedAt = Date.now();
  renderNow();

  queueCount.textContent = `${queue.upcoming.length} in queue`;
  upcoming.innerHTML = queue.upcoming.length
    ? queue.upcoming
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
    : `<div class="empty">No songs in the queue yet. <a href="/request">Send the first request →</a></div>`;

  historyCount.textContent = `${queue.history.length} recent`;
  if (queue.history.length) {
    historyWrap.hidden = false;
    historyEmpty.innerHTML = "";
    historyBody.innerHTML = queue.history
      .map(
        (item) => `<tr>
          <td>${escapeHtml(item.title)}</td>
          <td class="muted">${escapeHtml(item.channel_name)}</td>
          <td class="muted num nowrap">${escapeHtml(dateTimeOf(item.played_at))}</td>
        </tr>`,
      )
      .join("");
  } else {
    historyWrap.hidden = true;
    historyEmpty.innerHTML = `<div class="empty">No tracks have been played yet.</div>`;
  }

  updated.textContent = `Updated ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

async function refresh() {
  try {
    const queue = await api("/api/public/queue");
    render(queue);
    lastError = false;
  } catch {
    if (!lastError) {
      updated.textContent = "Connection lost — retrying";
      lastError = true;
    }
  }
}

const refreshSoon = debounce(refresh, 400);

refresh();
setInterval(refresh, 3_000);
setInterval(paintProgress, 1_000);

getSupabase()
  .then((db) => {
    const channel = db
      .channel("public-queue")
      .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, refreshSoon)
      .on("postgres_changes", { event: "*", schema: "public", table: "playback_history" }, refreshSoon)
      .subscribe();
    window.addEventListener("pagehide", () => void db.removeChannel(channel), { once: true });
  })
  .catch(() => {
    /* polling already covers this */
  });

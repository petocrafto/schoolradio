import { api, confirmDialog, dateTimeOf, escapeHtml, toast } from "./common.js";
import { emptyState, initAdminShell, setLiveIndicator } from "./admin-shell.js";

const kpis = document.querySelector("#kpis");
const todaySchedule = document.querySelector("#today-schedule");
const pendingList = document.querySelector("#pending-list");
const onAir = document.querySelector("#on-air");
const recentList = document.querySelector("#recent-list");
const replayPrevious = document.querySelector("#replay-previous");
const playerState = document.querySelector("#player-state");
const commandActions = document.querySelector("#command-actions");
const emergencyBtn = document.querySelector("#emergency-btn");
const commandStatus = document.querySelector("#command-status");
const commandLog = document.querySelector("#command-log");

let session = null;
let emergency = false;
let busy = false;

function renderKpis(data) {
  const device = data.device;
  const online = device && device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 15000;
  const stateText = online ? String(device.state || "online") : "Offline";
  const playingTitle = data.current && data.current.title ? data.current.title : "";
  const progress = data.progress || null;
  const position = progress && Number.isFinite(progress.position) ? progress.position : null;
  const duration = progress && Number.isFinite(progress.duration) ? progress.duration : null;
  const progressHint = position !== null && duration
    ? `Playing: ${playingTitle || "studio playback"} · ${mmss(position)} / ${mmss(duration)}`
    : playingTitle
      ? `Playing: ${playingTitle}`
      : device?.last_seen_at
        ? `Last seen ${dateTimeOf(device.last_seen_at)}`
        : "No heartbeat received";
  const cards = [
    {
      label: "Player",
      value: stateText,
      hint: progressHint,
      icon: "player",
      tone: online ? "accent" : "",
    },
    { label: "Requests to review", value: data.counts.pending, hint: "Pending moderation", icon: "requests" },
    { label: "Songs in queue", value: data.counts.queue, hint: "Approved for playback", icon: "queue" },
    { label: "Songs played today", value: data.counts.playedToday, hint: "Asia/Jakarta day", icon: "history" },
    { label: "Enabled sessions", value: data.counts.schedules, hint: "Weekly schedule", icon: "schedule" },
  ];
  kpis.innerHTML = cards
    .map(
      (card) => `
      <article class="card kpi">
        <div class="stat">
          <span class="stat-label">${escapeHtml(card.label)}</span>
          <span class="stat-value" style="${card.tone === "accent" ? "color:var(--accent);font-size:22px;text-transform:capitalize" : ""}">${escapeHtml(String(card.value))}</span>
          <span class="stat-hint">${escapeHtml(card.hint)}</span>
        </div>
      </article>`,
    )
    .join("");

  playerState.textContent = stateText;
  playerState.className = online ? "badge accent" : "badge";
  emergency = Boolean(device && device.emergency_stopped);
  emergencyBtn.textContent = emergency ? "Resume emergency stop" : "Emergency stop";
  emergencyBtn.className = emergency ? "btn btn-secondary" : "btn btn-danger";
  emergencyBtn.dataset.command = emergency ? "emergency_resume" : "emergency_stop";
  setLiveIndicator(Boolean(device && device.state === "playing" && online));
}

function renderToday(rows) {
  if (!rows.length) {
    todaySchedule.innerHTML = `<p class="muted" style="margin:0">No programme scheduled today. <a href="/admin/schedule">Add a session →</a></p>`;
    return;
  }
  todaySchedule.innerHTML = rows
    .map(
      (row) => `
      <div class="schedule-entry ${row.enabled ? "" : "off"}">
        <span class="schedule-time">${escapeHtml(row.start_time.slice(0, 5))}–${escapeHtml(row.end_time.slice(0, 5))}</span>
        <span class="name">${escapeHtml(row.program_name)}</span>
        <span class="badge ${row.enabled ? "accent" : ""}">${row.enabled ? "On" : "Off"}</span>
      </div>`,
    )
    .join("");
}

function renderPending(rows) {
  if (!rows.length) {
    pendingList.innerHTML = emptyState("No requests are waiting for review.");
    return;
  }
  pendingList.innerHTML = rows
    .map(
      (item) => `
      <article class="list-item" data-id="${escapeHtml(item.id)}">
        <span class="grow">
          <strong>${escapeHtml(item.title)}</strong>
          <span class="muted tiny">${escapeHtml(item.channel_name)} · requested by ${escapeHtml(item.requester_name)} · ${escapeHtml(dateTimeOf(item.created_at))}</span>
        </span>
        <span class="acts row" style="gap:8px">
          <button class="btn btn-sm" data-act="approve" type="button">Approve</button>
          <button class="btn btn-secondary btn-sm" data-act="reject" type="button">Reject</button>
        </span>
      </article>`,
    )
    .join("");

  pendingList.querySelectorAll("[data-act]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-id]");
      moderate(row.dataset.id, button.dataset.act === "approve" ? "approved" : "rejected");
    });
  });
}

async function moderate(id, status) {
  if (busy) return;
  busy = true;
  try {
    await session.request("/api/admin/requests", { method: "PATCH", body: { id, status } });
    toast(status === "approved" ? "Request approved." : "Request rejected.");
    await load();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    busy = false;
  }
}

function mmss(total) {
  if (!Number.isFinite(total) || total < 0) return "--:--";
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderOnAir(data) {
  const current = data.current;
  const progress = data.progress || null;
  const state = progress ? String(progress.state || "") : "";
  const position = progress && Number.isFinite(progress.position) ? progress.position : null;
  const duration = progress && Number.isFinite(progress.duration) ? progress.duration : null;
  const title = (progress && progress.title) || (current && current.title) || "";
  const percent = position !== null && duration ? Math.min(100, Math.round((position / duration) * 100)) : null;
  const finished = position !== null && duration !== null && duration > 0 && position >= duration - 1;
  const stale = progress && progress.updatedAt ? Date.now() - new Date(progress.updatedAt).getTime() > 20000 : true;

  let statusBadge = `<span class="badge">Idle</span>`;
  if (finished) statusBadge = `<span class="badge teal">Finished</span>`;
  else if (state === "playing") statusBadge = `<span class="badge accent">Playing</span>`;
  else if (state === "paused") statusBadge = `<span class="badge warning">Paused</span>`;
  else if (state === "emergency_stopped") statusBadge = `<span class="badge danger">Emergency</span>`;
  else if (state === "ready" || state === "standby") statusBadge = `<span class="badge">Stopped</span>`;

  const detail = [
    progress && progress.test ? "test playback" : progress && progress.previous ? "replayed" : null,
    stale ? "player not reporting" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  onAir.innerHTML = title
    ? `<div class="list-item" style="border-color:rgba(182,242,74,.35);align-items:flex-start">
         <span class="index" style="background:var(--accent);color:var(--accent-ink)">▶</span>
         <span class="grow" style="display:grid;gap:6px">
           <strong>${escapeHtml(title)}</strong>
           <span class="muted tiny">${escapeHtml(current ? `${current.channel_name} · requested by ${current.requester_name}` : detail || "Studio playback")}</span>
           <span class="row" style="gap:10px;align-items:center">
             <span class="progress" style="flex:1;max-width:320px"><span style="width:${percent === null ? 0 : percent}%"></span></span>
             <span class="mono tiny muted nowrap">${position === null ? "--:--" : mmss(position)} / ${duration === null ? "--:--" : mmss(duration)}</span>
           </span>
         </span>
         ${statusBadge}
       </div>`
    : `<div class="empty">Nothing is playing right now.${data.lastFinished ? `<br><span class="tiny muted">Last finished: ${escapeHtml(data.lastFinished.title)} · ${escapeHtml(dateTimeOf(data.lastFinished.played_at))}</span>` : ""}</div>`;

  const recent = data.recent || [];
  recentList.innerHTML = recent.length
    ? recent
        .map(
          (item) => `
        <div class="list-item" data-video="${escapeHtml(item.video_id)}" data-title="${escapeHtml(item.title)}" data-channel="${escapeHtml(item.channel_name)}">
          <span class="grow"><strong>${escapeHtml(item.title)}</strong><span class="muted tiny">${escapeHtml(item.channel_name)} · ${escapeHtml(dateTimeOf(item.played_at))} · ${escapeHtml(item.status === "played" ? "finished" : item.status)}</span></span>
          <button class="btn btn-secondary btn-sm" data-act="replay" type="button">Replay</button>
        </div>`,
        )
        .join("")
    : emptyState("No songs have finished playing yet.");

  recentList.querySelectorAll("[data-act='replay']").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-video]");
      void replayTrack(row.dataset.video, row.dataset.title, row.dataset.channel, button);
    });
  });
  replayPrevious.disabled = !recent.length;
}

async function replayTrack(videoId, title, channelName, button) {
  if (busy) return;
  busy = true;
  if (button) button.disabled = true;
  try {
    const result = await session.request("/api/admin/commands", {
      method: "POST",
      body: { command: "play", payload: { videoId, title, channelName, previous: true } },
    });
    toast(`Replaying “${title}”.`);
    watchCommand(result.id, `Replay “${title}”`);
    setTimeout(load, 3000);
  } catch (error) {
    toast(error.message, "err");
  } finally {
    busy = false;
    if (button) button.disabled = false;
  }
}

/** Shows whether the player actually received each command, instead of leaving
    the studio guessing after a click. */
function renderCommandLog(data) {
  const items = (data && data.items) || [];
  if (!items.length) {
    commandLog.innerHTML = `<p class="muted tiny" style="margin:0">No commands sent yet.</p>`;
    return;
  }
  commandLog.innerHTML = items
    .map((item) => {
      const label = item.command.replace("_", " ");
      const detail = item.title ? ` · ${item.title}` : "";
      let badge;
      if (item.delivered) {
        const seconds = Math.max(0, Math.round((new Date(item.acknowledgedAt).getTime() - new Date(item.createdAt).getTime()) / 1000));
        badge = `<span class="badge accent">Delivered · ${seconds}s</span>`;
      } else if (!data.online) {
        badge = `<span class="badge danger">Player offline</span>`;
      } else if (item.pendingSeconds > 15) {
        badge = `<span class="badge warning">No response · ${item.pendingSeconds}s</span>`;
      } else {
        badge = `<span class="badge">Sending…</span>`;
      }
      return `<div class="list-item" style="padding:8px 10px">
        <span class="grow"><strong style="font-size:13px;text-transform:capitalize">${escapeHtml(label)}</strong>
        <span class="muted tiny">${escapeHtml(dateTimeOf(item.createdAt))}${escapeHtml(detail)}</span></span>
        ${badge}
      </div>`;
    })
    .join("");
}

async function refreshCommandLog() {
  try {
    renderCommandLog(await session.request("/api/admin/commands?limit=6"));
  } catch {
    /* the overview poll reports connection problems */
  }
}

/** Polls one command until the player acknowledges it or the window closes. */
function watchCommand(id, label) {
  if (!id) {
    commandStatus.textContent = `${label} queued. Waiting for the player.`;
    return;
  }
  const started = Date.now();
  commandStatus.textContent = `${label} queued — waiting for the player to confirm…`;
  const timer = setInterval(async () => {
    try {
      const data = await session.request("/api/admin/commands?limit=10");
      const item = (data.items || []).find((entry) => entry.id === id);
      if (item && item.delivered) {
        clearInterval(timer);
        const seconds = Math.max(0, Math.round((new Date(item.acknowledgedAt).getTime() - started) / 1000));
        commandStatus.textContent = `${label} delivered to the player after ${seconds}s.`;
        commandStatus.className = "form-ok tiny";
        toast(`${label} delivered to the player.`);
        void refreshCommandLog();
        void load();
        return;
      }
      if (!data.online) {
        commandStatus.textContent = `${label} queued, but the player is offline. It runs when the player reconnects.`;
        commandStatus.className = "form-error tiny";
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        commandStatus.textContent = `${label} not confirmed after 15s. Check that the player page is open and its token is valid.`;
        commandStatus.className = "form-error tiny";
        void refreshCommandLog();
        return;
      } else {
        commandStatus.textContent = `${label} queued — waiting for the player to confirm…`;
        commandStatus.className = "muted tiny";
      }
      renderCommandLog(data);
    } catch {
      clearInterval(timer);
      commandStatus.textContent = `${label} status unknown: could not reach the server.`;
      commandStatus.className = "form-error tiny";
    }
  }, 2000);
}

async function load() {
  try {
    const data = await session.request("/api/admin/overview");
    renderKpis(data);
    renderOnAir(data);
    renderToday(data.todaySchedule);
    renderPending(data.pending);
    void refreshCommandLog();
  } catch (error) {
    if (error.status !== 401) toast(error.message, "err");
  }
}

commandActions.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-command]");
  if (!button || busy) return;
  const command = button.dataset.command;
  if (command === "emergency_stop") {
    const ok = await confirmDialog({ title: "Emergency stop", message: "This stops playback immediately on the radio computer.", confirmLabel: "Stop playback" });
    if (!ok) return;
  }
  busy = true;
  commandActions.querySelectorAll("button").forEach((element) => {
    element.disabled = true;
  });
  try {
    const result = await session.request("/api/admin/commands", { method: "POST", body: { command, payload: {} } });
    const label = command.replace("_", " ");
    toast(`Command sent: ${label}`);
    watchCommand(result.id, label);
    await load();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    busy = false;
    commandActions.querySelectorAll("button").forEach((element) => {
      element.disabled = false;
    });
  }
});

session = await initAdminShell({
  active: "dashboard",
  title: "Dashboard",
  subtitle: "Live overview of the player, requests, and today's station activity.",
});

/* ------------------------------------------------------- test playback */

const testForm = document.querySelector("#test-search");
const testQuery = document.querySelector("#test-query");
const testSearchBtn = document.querySelector("#test-search-btn");
const testResults = document.querySelector("#test-results");
const testStatus = document.querySelector("#test-status");
const testBadge = document.querySelector("#test-badge");
const testStop = document.querySelector("#test-stop");

let testBusy = false;

function setTestStatus(message, isError) {
  testStatus.textContent = message;
  testStatus.className = isError ? "form-error tiny" : "muted tiny";
  testStatus.hidden = !message;
}

function renderTestResults(videos) {
  if (!videos.length) {
    testResults.innerHTML = `<div class="empty">No videos found. Try another search.</div>`;
    return;
  }
  testResults.innerHTML = videos
    .map(
      (video) => `
      <article class="result" style="cursor:default">
        <img src="${escapeHtml(video.thumbnailUrl)}" alt="" loading="lazy">
        <span class="meta"><strong>${escapeHtml(video.title)}</strong><span>${escapeHtml(video.channelName)}</span></span>
        <button class="btn btn-sm" data-video="${escapeHtml(video.id)}" data-title="${escapeHtml(video.title)}" data-channel="${escapeHtml(video.channelName)}" type="button">Play</button>
      </article>`,
    )
    .join("");
  testResults.querySelectorAll("[data-video]").forEach((button) => {
    button.addEventListener("click", () => playTestVideo(button.dataset.video, button.dataset.title, button.dataset.channel, button));
  });
}

async function playTestVideo(videoId, title, channelName, button) {
  if (testBusy) return;
  testBusy = true;
  if (button) button.disabled = true;
  setTestStatus(`Sending “${title}” to the player…`);
  try {
    const result = await session.request("/api/admin/commands", {
      method: "POST",
      body: { command: "play", payload: { videoId, title, channelName, test: true } },
    });
    testBadge.textContent = "Test sent";
    testBadge.className = "badge warning";
    setTestStatus(`“${title}” queued for the player. It starts within a few seconds.`);
    toast("Test video sent to the player.");
    watchCommand(result.id, `Test “${title}”`);
    setTimeout(load, 4000);
  } catch (error) {
    setTestStatus(error.message, true);
    toast(error.message, "err");
  } finally {
    testBusy = false;
    if (button) button.disabled = false;
  }
}

if (session) {
  testForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = testQuery.value.trim();
    if (query.length < 2) {
      setTestStatus("Type at least two characters to search.", true);
      return;
    }
    testBusy = true;
    testSearchBtn.disabled = true;
    testSearchBtn.textContent = "Searching…";
    setTestStatus("Searching YouTube…");
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
      renderTestResults(data.videos || []);
      setTestStatus("");
    } catch (error) {
      setTestStatus(error.message, true);
      testResults.innerHTML = "";
    } finally {
      testBusy = false;
      testSearchBtn.disabled = false;
      testSearchBtn.textContent = "Search";
    }
  });

  testStop.addEventListener("click", async () => {
    try {
      const result = await session.request("/api/admin/commands", { method: "POST", body: { command: "stop", payload: {} } });
      testBadge.textContent = "Stopped";
      testBadge.className = "badge";
      setTestStatus("Stop command sent to the player.");
      toast("Player stopped.");
      watchCommand(result.id, "Stop");
      setTimeout(load, 3000);
    } catch (error) {
      setTestStatus(error.message, true);
    }
  });

  replayPrevious.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    replayPrevious.disabled = true;
    try {
      const result = await session.request("/api/admin/commands", { method: "POST", body: { command: "previous", payload: {} } });
      toast(result.replaying ? `Replaying “${result.replaying.title}”.` : "Replay sent.");
      setTimeout(load, 3000);
    } catch (error) {
      toast(error.message, "err");
    } finally {
      busy = false;
      replayPrevious.disabled = false;
    }
  });

  await load();
  setInterval(load, 5_000);
}

import { api, clockFormat, escapeHtml, timeRange } from "./common.js";

const TOKEN_KEY = "school-radio-token";
const DEVICE_KEY = "school-radio-device";
const UNLOCK_KEY = "school-radio-unlocked";
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
const dayLabel = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", weekday: "short", day: "2-digit", month: "short" });

const setup = document.querySelector("#setup");
const tokenForm = document.querySelector("#token-form");
const tokenInput = document.querySelector("#token-input");
const tokenError = document.querySelector("#token-error");
const playerGrid = document.querySelector("#player-grid");
const songTitle = document.querySelector("#song-title");
const songMeta = document.querySelector("#song-meta");
const songState = document.querySelector("#song-state");
const songProgress = document.querySelector("#song-progress");
const songPercent = document.querySelector("#song-percent");
const playbackBadge = document.querySelector("#playback-badge");
const primaryBtn = document.querySelector("#primary-btn");
const pauseBtn = document.querySelector("#pause-btn");
const resumeBtn = document.querySelector("#resume-btn");
const stopBtn = document.querySelector("#stop-btn");
const volumeInput = document.querySelector("#volume");
const volumeValue = document.querySelector("#volume-value");
const qualitySelect = document.querySelector("#quality");
const qualityNote = document.querySelector("#quality-note");
const clockElement = document.querySelector("#clock");
const scheduleBadge = document.querySelector("#schedule-badge");
const programName = document.querySelector("#program-name");
const programTimes = document.querySelector("#program-times");
const nextProgram = document.querySelector("#next-program");
const deviceState = document.querySelector("#device-state");
const devicePill = document.querySelector("#device-pill");
const devicePillText = document.querySelector("#device-pill-text");
const disconnectBtn = document.querySelector("#disconnect-btn");

let token = "";
let deviceId = "";
let ytPlayer = null;
let ytReady = false;
let pendingVideoId = null;
let loadWatchdog = null;
let unlocked = false;
let volume = Number(localStorage.getItem("school-radio-volume") || 70);
let quality = localStorage.getItem("school-radio-quality") || "default";
let currentSong = null;
let heartbeatTimer = null;
let progressTimer = null;
let scheduleTimer = null;
let clockTimer = null;
let alive = false;
let lastStateText = "Connecting";
let busy = false;
let lastClaimAt = 0;

/* ------------------------------------------------------------- helpers */

function setState(text) {
  lastStateText = text;
  songState.textContent = text;
}

function setDeviceState(text, online) {
  deviceState.textContent = text;
  devicePill.classList.toggle("on", Boolean(online));
  devicePillText.textContent = online ? "Online" : "Connecting";
}

/** Reads the real YouTube state instead of trusting the label text, so the
    studio never sees "standby" while audio is still playing. */
function playerStateForHeartbeat() {
  if (ytPlayer && ytReady) {
    let state = -1;
    try {
      state = ytPlayer.getPlayerState();
    } catch {
      state = -1;
    }
    if (state === 1) return "playing";
    if (state === 2) return "paused";
    if (state === 3) return "connecting";
    if (state === 5) return currentSong ? "ready" : "standby";
  }
  const value = lastStateText.toLowerCase();
  if (value.indexOf("emergency") !== -1) return "emergency_stopped";
  if (value.indexOf("paused") === 0) return "paused";
  if (value.indexOf("connecting") === 0) return "connecting";
  if (value.indexOf("standby") !== -1) return "standby";
  return "ready";
}

/** Current position and duration in seconds, or nulls when unavailable. */
function playbackProgress() {
  if (!ytPlayer || !ytReady) return { position: null, duration: null };
  try {
    const position = Number(ytPlayer.getCurrentTime());
    const duration = Number(ytPlayer.getDuration());
    return {
      position: Number.isFinite(position) ? Math.max(0, Math.round(position)) : null,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    };
  } catch {
    return { position: null, duration: null };
  }
}

function renderSong() {
  if (currentSong) {
    songTitle.textContent = currentSong.title;
    if (currentSong.test) {
      songMeta.textContent = `${currentSong.channel_name || "YouTube"} · test playback from the studio`;
      playbackBadge.textContent = "TEST";
      playbackBadge.className = "badge warning";
    } else if (currentSong.previous) {
      songMeta.textContent = `${currentSong.channel_name} · replayed by the studio`;
      playbackBadge.textContent = "REPLAY";
      playbackBadge.className = "badge teal";
    } else {
      songMeta.textContent = `${currentSong.channel_name} · requested by ${currentSong.requester_name}`;
      playbackBadge.textContent = "LIVE";
      playbackBadge.className = "badge accent";
    }
  } else {
    songTitle.textContent = "School Radio";
    songMeta.textContent = "Waiting for the studio.";
    playbackBadge.textContent = "Idle";
    playbackBadge.className = "badge";
    songProgress.style.width = "0%";
    songPercent.textContent = "0%";
  }
}

async function callPlayer(action, body) {
  const response = await fetch("/api/player", {
    method: "POST",
    headers: { "content-type": "application/json", "x-player-token": token },
    body: JSON.stringify(Object.assign({ action: action }, body || {})),
  });
  if (!response.ok) throw new Error("Player request failed.");
  return response.json();
}

/* ------------------------------------------------------------- youtube */

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  return new Promise((resolve) => {
    const existing = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof existing === "function") existing();
      resolve();
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    }
    setTimeout(() => {
      if (window.YT && window.YT.Player) resolve();
    }, 4000);
  });
}

async function initYouTube() {
  if (ytPlayer || !window.YT || !window.YT.Player) return;
  const host = document.querySelector("#yt-player");
  host.className = "";
  host.id = "yt-frame";
  host.innerHTML = "";
  ytPlayer = new window.YT.Player("yt-frame", {
    height: "100%",
    width: "100%",
    playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, origin: location.origin },
    events: {
      onReady: () => {
        ytReady = true;
        ytPlayer.setVolume(volume);
        applyQuality(quality);
        if (pendingVideoId) {
          const videoId = pendingVideoId;
          pendingVideoId = null;
          ytPlayer.loadVideoById(videoId);
        } else {
          setState(unlocked ? "Ready" : "Ready — press Start playback");
        }
      },
      onStateChange: (event) => {
        if (!window.YT) return;
        if (event.data === window.YT.PlayerState.ENDED) {
          void handleEnded();
          return;
        }
        if (event.data === window.YT.PlayerState.PAUSED) setState("Paused");
        if (event.data === window.YT.PlayerState.PLAYING) {
          clearTimeout(loadWatchdog);
          loadWatchdog = null;
          // Ignore stray PLAYING events while nothing is loaded.
          if (!currentSong) return;
          setState("Playing");
        }
      },
      onError: (event) => handleVideoError(event && event.data),
    },
  });
}

async function handleEnded() {
  const ended = currentSong;
  clearTimeout(loadWatchdog);
  loadWatchdog = null;
  currentSong = null;
  renderSong();
  if (!ended || ended.test || !ended.id) {
    setState(ended && ended.test ? "Test playback finished" : "Standby — waiting for requests");
    return;
  }
  setState("Song finished");
  try {
    await callPlayer("finish", { requestId: ended.id, status: "played" });
  } catch (error) {
    console.warn("[player] could not record playback:", error.message);
  }
  await nextSong();
}

/* YouTube error codes: 2 bad id, 5 HTML5 player, 100 removed, 101/150 not embeddable.
   The empty player can emit a spurious error before any song is loaded, so errors
   without a current song are logged and ignored instead of skipping a request. */
async function handleVideoError(code) {
  const broken = currentSong;
  if (!broken) {
    console.warn("[player] YouTube error", code, "with no active song — ignored");
    return;
  }
  clearTimeout(loadWatchdog);
  loadWatchdog = null;
  const retryable = code === 5 || code === 2;
  console.warn("[player] YouTube error", code, "for", broken.video_id);

  if (retryable && broken.retried !== true) {
    broken.retried = true;
    setState(`Video problem (error ${code}) — retrying`);
    if (ytPlayer && ytReady) ytPlayer.loadVideoById(broken.video_id);
    return;
  }

  currentSong = null;
  renderSong();
  setState(`Unavailable video${code ? ` (error ${code})` : ""} — skipping`);
  if (broken.test || !broken.id) return;
  try {
    await callPlayer("finish", { requestId: broken.id, status: "skipped", reason: `youtube_error_${code ?? "unknown"}` });
  } catch (error) {
    console.warn("[player] could not record skip:", error.message);
  }
  await nextSong();
}

/* -------------------------------------------------------------- player */

async function emergencyActive() {
  try {
    const response = await fetch("/api/player", { cache: "no-store" });
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data.device && data.device.emergency_stopped);
  } catch {
    return false;
  }
}

/** Loads a video into the player, whether or not the iframe is ready yet. */
function startVideo(song) {
  currentSong = song;
  renderSong();
  clearTimeout(loadWatchdog);
  if (ytPlayer && ytReady) {
    ytPlayer.loadVideoById(song.video_id);
    applyQuality(quality);
  } else {
    pendingVideoId = song.video_id;
  }
  setState("Loading video…");
  loadWatchdog = setTimeout(() => {
    if (currentSong !== song || lastStateText === "Playing") return;
    let playerState = -1;
    try {
      playerState = ytPlayer.getPlayerState();
    } catch {
      playerState = -1;
    }
    // CUED/UNSTARTED/PAUSED means the video loaded but the browser blocked
    // audio, not that the video is broken. Keep the song and ask for a click.
    if (playerState === 5 || playerState === -1 || playerState === 2 || playerState === 3) {
      console.warn("[player] playback blocked until a user gesture:", song.video_id);
      setState("Press Start playback to enable audio");
      return;
    }
    handleVideoError("timeout");
  }, 15000);
}

/** Fully stops playback: silences the iframe, forgets pending loads, and records
    the request so it does not linger as "playing" in the database. */
async function stopPlayback(reason, { record = true } = {}) {
  clearTimeout(loadWatchdog);
  loadWatchdog = null;
  pendingVideoId = null;
  const stopped = currentSong;
  currentSong = null;

  if (ytPlayer && ytReady) {
    try {
      // pauseVideo stops the audio immediately; stopVideo cancels the load.
      // Never call seekTo here: seeking a cued player restarts playback.
      ytPlayer.pauseVideo();
      ytPlayer.stopVideo();
    } catch (error) {
      console.warn("[player] stop failed:", error.message);
    }
  }

  renderSong();
  setState("Stopped");
  if (!record || !stopped || stopped.test || !stopped.id) return;
  try {
    await callPlayer("finish", { requestId: stopped.id, status: "skipped", reason });
  } catch (error) {
    console.warn("[player] could not record stop:", error.message);
  }
}

async function nextSong() {
  if (busy) return;
  busy = true;
  lastClaimAt = Date.now();
  try {
    const data = await callPlayer("claim");
    if (!data.item) {
      currentSong = null;
      renderSong();
      const blocked = await emergencyActive();
      setState(blocked ? "Emergency stop is active — an admin must resume playback" : "Standby — waiting for requests");
      return;
    }
    startVideo(data.item);
  } catch (error) {
    setState("Reconnecting…");
  } finally {
    busy = false;
  }
}

/** Picks up new approved requests automatically while the player is idle.
    Browsers block audio until a user gesture, so claiming waits for the
    one-time "Start playback" click (remembered in localStorage). */
function maybeAutoPlay() {
  if (!alive || busy || currentSong || !unlocked) return;
  if (lastStateText.toLowerCase().indexOf("emergency") !== -1) return;
  if (Date.now() - lastClaimAt < 8000) return;
  void nextSong();
}

async function heartbeat() {
  if (!alive) return;
  try {
    // Never report idle while audio is still running.
    if (!currentSong && ytPlayer && ytReady) {
      try {
        if (ytPlayer.getPlayerState() === 1) ytPlayer.stopVideo();
      } catch {
        /* ignore */
      }
    }
    const progress = playbackProgress();
    const data = await callPlayer("heartbeat", {
      deviceId: deviceId,
      state: playerStateForHeartbeat(),
      requestId: currentSong ? currentSong.id : null,
      position: progress.position,
      duration: progress.duration,
      title: currentSong ? currentSong.title : null,
      videoId: currentSong ? currentSong.video_id : null,
      test: currentSong ? Boolean(currentSong.test) : false,
      previous: currentSong ? Boolean(currentSong.previous) : false,
    });
    setDeviceState("Connected · " + clockFormat(new Date()), true);
    const commands = data.commands || [];
    for (const command of commands) {
      if (command.command === "emergency_stop") {
        await stopPlayback("emergency_stop");
        setState("Emergency stopped");
      } else if (command.command === "emergency_resume") {
        setState("Ready — emergency stop unlocked");
        await nextSong();
      } else if (command.command === "pause") {
        if (ytPlayer && ytReady) ytPlayer.pauseVideo();
        setState("Paused");
      } else if (command.command === "resume") {
        if (ytPlayer && ytReady && currentSong) {
          ytPlayer.playVideo();
          setState("Playing");
        } else {
          await nextSong();
        }
      } else if (command.command === "stop") {
        await stopPlayback("stopped_by_admin");
      } else if (command.command === "next") {
        if (currentSong && !currentSong.test && currentSong.id) {
          try {
            await callPlayer("finish", { requestId: currentSong.id, status: "skipped", reason: "admin_next" });
          } catch (error) {
            console.warn("[player] could not record skip:", error.message);
          }
        }
        currentSong = null;
        await nextSong();
      } else if (command.command === "play") {
        const payload = command.payload || {};
        const videoId = typeof payload.videoId === "string" ? payload.videoId : "";
        if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
          const isTest = payload.test === true;
          startVideo({
            id: null,
            video_id: videoId,
            title: typeof payload.title === "string" && payload.title ? payload.title : isTest ? "Test video" : "Studio replay",
            channel_name: typeof payload.channelName === "string" ? payload.channelName : "YouTube",
            requester_name: isTest ? "Studio test" : "Studio replay",
            test: isTest,
            previous: payload.previous === true,
          });
        } else {
          await nextSong();
        }
      } else if (command.command === "volume") {
        const value = Number(command.payload && command.payload.volume);
        if (Number.isFinite(value)) applyVolume(value);
      }
    }
    maybeAutoPlay();
  } catch {
    setDeviceState("Reconnecting…", false);
    setState("Reconnecting…");
  }
}

function tickProgress() {
  if (!ytPlayer || !ytReady || !currentSong) return;
  try {
    const position = ytPlayer.getCurrentTime();
    const duration = ytPlayer.getDuration();
    if (duration > 0) {
      const percent = Math.min(100, Math.max(0, (position / duration) * 100));
      songProgress.style.width = percent + "%";
      songPercent.textContent = Math.round(percent) + "%";
    }
  } catch {
    /* player not ready */
  }
}

function applyVolume(value) {
  volume = Math.min(100, Math.max(0, Math.round(value)));
  volumeInput.value = String(volume);
  volumeValue.textContent = volume + "%";
  localStorage.setItem("school-radio-volume", String(volume));
  if (ytPlayer && ytReady) ytPlayer.setVolume(volume);
}

/** Pins the YouTube player to the chosen resolution. YouTube ignores levels the
    video does not offer, so asking for 1080p on a 360p upload simply stays lower. */
function applyQuality(value) {
  quality = value || "default";
  qualitySelect.value = quality;
  localStorage.setItem("school-radio-quality", quality);
  if (!ytPlayer || !ytReady) return;
  try {
    if (typeof ytPlayer.setPlaybackQualityRange === "function") ytPlayer.setPlaybackQualityRange(quality, quality);
    ytPlayer.setPlaybackQuality(quality);
  } catch (error) {
    console.warn("[player] could not set quality:", error.message);
  }
  const labels = { hd1080: "1080p", hd720: "720p", large: "480p", medium: "360p", small: "240p", tiny: "144p" };
  qualityNote.textContent = quality === "default" ? "auto" : `requested ${labels[quality] || quality}`;
  setTimeout(refreshQualityNote, 2500);
}

function refreshQualityNote() {
  if (!qualityNote) return;
  const labels = { hd1080: "1080p", hd720: "720p", large: "480p", medium: "360p", small: "240p", tiny: "144p", highres: "Highest", default: "auto" };
  let actual = "";
  try {
    actual = ytPlayer && ytReady && typeof ytPlayer.getPlaybackQuality === "function" ? ytPlayer.getPlaybackQuality() : "";
  } catch {
    actual = "";
  }
  if (actual && actual !== "unknown") {
    qualityNote.textContent = `now ${labels[actual] || actual}`;
    return;
  }
  qualityNote.textContent = quality === "default" ? "auto" : `requested ${labels[quality] || quality}`;
}

/* ------------------------------------------------------------ schedule */

function renderSchedule(data) {
  if (!data) {
    scheduleBadge.textContent = "Unavailable";
    scheduleBadge.className = "badge";
    programName.textContent = "Schedule unavailable";
    programTimes.textContent = "";
    return;
  }
  if (data.active) {
    scheduleBadge.textContent = "LIVE";
    scheduleBadge.className = "badge accent";
    programName.textContent = data.active.programName;
    programTimes.textContent = timeRange(data.active.start, data.active.end) + " WIB";
  } else {
    scheduleBadge.textContent = "OFF AIR";
    scheduleBadge.className = "badge";
    programName.textContent = data.next ? "Between programmes" : "No programme scheduled";
    programTimes.textContent = "";
  }
  nextProgram.innerHTML = data.next
    ? `<strong>${escapeHtml(data.next.programName)}</strong><br><span class="muted">${escapeHtml(nextLabel(data.next))}</span>`
    : `<span class="muted">No upcoming programme in the next week.</span>`;
}

function nextLabel(item) {
  const start = new Date(item.start);
  const sameDay = dayKey.format(start) === dayKey.format(new Date());
  return `${sameDay ? "Today" : dayLabel.format(start)} · ${timeRange(item.start, item.end)} WIB`;
}

async function loadSchedule() {
  try {
    renderSchedule(await api("/api/player/schedule"));
  } catch {
    renderSchedule(null);
  }
}

/* --------------------------------------------------------------- boot */

function startTimers() {
  stopTimers();
  alive = true;
  heartbeat();
  heartbeatTimer = setInterval(heartbeat, 3000);
  progressTimer = setInterval(tickProgress, 1000);
  loadSchedule();
  scheduleTimer = setInterval(loadSchedule, 30_000);
  clockTimer = setInterval(() => {
    clockElement.textContent = clockFormat(new Date());
  }, 1000);
  clockElement.textContent = clockFormat(new Date());
}

function stopTimers() {
  alive = false;
  clearInterval(heartbeatTimer);
  clearInterval(progressTimer);
  clearInterval(scheduleTimer);
  clearInterval(clockTimer);
  heartbeatTimer = progressTimer = scheduleTimer = clockTimer = null;
}

async function connect() {
  if (!token) {
    setup.hidden = false;
    playerGrid.hidden = true;
    return;
  }
  setup.hidden = true;
  playerGrid.hidden = false;
  deviceId = localStorage.getItem(DEVICE_KEY) || "";
  if (!deviceId) {
    deviceId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    localStorage.setItem(DEVICE_KEY, deviceId);
  }
  setDeviceState("Connecting…", false);
  setState("Connecting");
  applyVolume(volume);
  renderSong();
  await loadYouTubeApi();
  await initYouTube();
  startTimers();
  if (unlocked && ytPlayer && ytReady) {
    // A previous click already authorized audio in this browser profile.
    try {
      ytPlayer.playVideo();
    } catch {
      /* the browser may still require a fresh gesture */
    }
  }
}

tokenForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim();
  if (!value) {
    tokenError.textContent = "Enter the player token.";
    tokenError.hidden = false;
    return;
  }
  tokenError.hidden = true;
  token = value;
  localStorage.setItem(TOKEN_KEY, token);
  await connect();
});

primaryBtn.addEventListener("click", async () => {
  if (!unlocked) {
    unlocked = true;
    localStorage.setItem(UNLOCK_KEY, "1");
    primaryBtn.textContent = "Next song";
    setState("Autoplay authorized");
  }
  // A song may already be loaded but held by the autoplay policy.
  if (ytPlayer && ytReady && currentSong) {
    ytPlayer.playVideo();
    setState("Playing");
    return;
  }
  await nextSong();
});

pauseBtn.addEventListener("click", () => {
  if (ytPlayer && ytReady) ytPlayer.pauseVideo();
  setState("Paused");
});

resumeBtn.addEventListener("click", async () => {
  if (ytPlayer && ytReady && currentSong) {
    ytPlayer.playVideo();
    setState("Playing");
    return;
  }
  await nextSong();
});

stopBtn.addEventListener("click", () => {
  void stopPlayback("stopped_by_player");
});

volumeInput.addEventListener("input", (event) => applyVolume(Number(event.target.value)));
qualitySelect.addEventListener("change", (event) => applyQuality(event.target.value));

disconnectBtn.addEventListener("click", () => {
  stopTimers();
  localStorage.removeItem(TOKEN_KEY);
  token = "";
  tokenInput.value = "";
  setup.hidden = false;
  playerGrid.hidden = true;
  setDeviceState("Disconnected", false);
});

window.addEventListener("pagehide", () => {
  stopTimers();
  if (ytPlayer && ytPlayer.destroy) ytPlayer.destroy();
  ytPlayer = null;
  ytReady = false;
});

token = localStorage.getItem(TOKEN_KEY) || "";
unlocked = localStorage.getItem(UNLOCK_KEY) === "1";
primaryBtn.textContent = unlocked ? "Next song" : "Start playback";
volumeInput.value = String(volume);
volumeValue.textContent = volume + "%";
qualitySelect.value = quality;
clockElement.textContent = clockFormat(new Date());
connect();

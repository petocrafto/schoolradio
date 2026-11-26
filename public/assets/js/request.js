import { api, escapeHtml, setStatus } from "./common.js";

const nameInput = document.querySelector("#name");
const queryInput = document.querySelector("#query");
const searchForm = document.querySelector("#search-form");
const searchBtn = document.querySelector("#search-btn");
const results = document.querySelector("#results");
const resultCount = document.querySelector("#result-count");
const status = document.querySelector("#status");
const selectedPanel = document.querySelector("#selected-panel");
const selectedTitle = document.querySelector("#selected-title");
const selectedChannel = document.querySelector("#selected-channel");
const submitBtn = document.querySelector("#submit-btn");
const submitHint = document.querySelector("#submit-hint");
const clearBtn = document.querySelector("#clear-btn");
const successCard = document.querySelector("#success-card");
const successMessage = document.querySelector("#success-message");
const anotherBtn = document.querySelector("#another-btn");
const livePill = document.querySelector("#live-pill");
const liveText = document.querySelector("#live-text");

let selected = null;
let busy = false;

nameInput.value = localStorage.getItem("school-radio-name") || "";
nameInput.addEventListener("input", () => {
  localStorage.setItem("school-radio-name", nameInput.value.trim());
  updateHint();
});

function setBusy(value) {
  busy = value;
  searchBtn.disabled = value;
  submitBtn.disabled = value;
  searchBtn.textContent = value ? "Working…" : "Search";
  submitBtn.textContent = value ? "Sending…" : "Submit request";
}

function updateHint() {
  if (!selected) {
    submitHint.textContent = "";
    return;
  }
  submitHint.textContent = nameInput.value.trim() ? "One request per song. Rate limits apply." : "Enter your name before submitting.";
  submitBtn.disabled = busy || !nameInput.value.trim();
}

function renderResults(videos) {
  resultCount.textContent = `${videos.length} result${videos.length === 1 ? "" : "s"}`;
  results.innerHTML = videos
    .map(
      (video) => `
      <button type="button" class="result" data-id="${escapeHtml(video.id)}">
        <img src="${escapeHtml(video.thumbnailUrl)}" alt="" loading="lazy">
        <span class="meta"><strong>${escapeHtml(video.title)}</strong><span>${escapeHtml(video.channelName)}</span></span>
      </button>`,
    )
    .join("");
  results.querySelectorAll(".result").forEach((element) => {
    element.addEventListener("click", () => {
      const video = videos.find((item) => item.id === element.dataset.id);
      if (video) select(video);
    });
  });
}

function select(video) {
  selected = video;
  results.querySelectorAll(".result").forEach((element) => element.classList.toggle("selected", element.dataset.id === video.id));
  selectedTitle.textContent = video.title;
  selectedChannel.textContent = video.channelName;
  selectedPanel.hidden = false;
  updateHint();
  selectedPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (query.length < 2) {
    setStatus(status, "Type at least two characters to search.", "error");
    return;
  }
  setBusy(true);
  setStatus(status, "Searching YouTube…");
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (!data.videos.length) {
      results.innerHTML = `<div class="empty">No videos found. Try a different search.</div>`;
      resultCount.textContent = "0 results";
      setStatus(status, "No videos found for that search.", "error");
    } else {
      renderResults(data.videos);
      setStatus(status, "");
    }
  } catch (error) {
    setStatus(status, error.message, "error");
  } finally {
    setBusy(false);
  }
});

submitBtn.addEventListener("click", async () => {
  if (!selected || busy) return;
  const requesterName = nameInput.value.trim();
  if (!requesterName) {
    setStatus(status, "Enter your name before submitting.", "error");
    nameInput.focus();
    return;
  }
  setBusy(true);
  setStatus(status, "");
  try {
    await api("/api/requests", {
      method: "POST",
      body: {
        requesterName,
        videoId: selected.id,
        title: selected.title,
        channelName: selected.channelName,
        thumbnailUrl: selected.thumbnailUrl,
      },
    });
    successMessage.textContent = "Thanks! The studio will review your request.";
    successCard.hidden = false;
    successCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    resetSelection();
    queryInput.value = "";
    results.innerHTML = `<div class="empty">Search for another song to request it.</div>`;
    resultCount.textContent = "—";
  } catch (error) {
    setStatus(status, error.message, "error");
    if (error.status === 429) successCard.hidden = true;
  } finally {
    setBusy(false);
  }
});

function resetSelection() {
  selected = null;
  selectedPanel.hidden = true;
  submitHint.textContent = "";
}

clearBtn.addEventListener("click", resetSelection);

anotherBtn.addEventListener("click", () => {
  successCard.hidden = true;
  queryInput.focus();
});

async function loadLive() {
  try {
    const queue = await api("/api/public/queue");
    const playing = Boolean(queue.current);
    livePill.classList.toggle("on", playing);
    liveText.textContent = playing ? "On air" : "Off air";
  } catch {
    liveText.textContent = "Offline";
  }
}

loadLive();

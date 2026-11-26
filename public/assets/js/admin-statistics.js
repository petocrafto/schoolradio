import { escapeHtml, shortDate } from "./common.js";
import { emptyState, initAdminShell } from "./admin-shell.js";

const kpis = document.querySelector("#kpis");
const chart = document.querySelector("#chart");
const seriesTotal = document.querySelector("#series-total");

const session = await initAdminShell({
  active: "statistics",
  title: "Statistics",
  subtitle: "Playback and request totals in Asia/Jakarta time.",
});

function renderKpis(data) {
  const cards = [
    { label: "Played · 7 days", value: data.total, hint: "Completed tracks" },
    { label: "Requests awaiting review", value: data.pending, hint: "Pending moderation" },
    { label: "Approved in queue", value: data.queue, hint: "Ready to play" },
    { label: "Enabled weekly sessions", value: data.schedules, hint: "Date overrides excluded" },
  ];
  kpis.innerHTML = cards
    .map(
      (card) => `
      <article class="card">
        <div class="stat">
          <span class="stat-label">${escapeHtml(card.label)}</span>
          <span class="stat-value">${escapeHtml(String(card.value))}</span>
          <span class="stat-hint">${escapeHtml(card.hint)}</span>
        </div>
      </article>`,
    )
    .join("");
}

function renderChart(series) {
  if (!series.length) {
    chart.innerHTML = emptyState("No playback data for the last seven days.");
    return;
  }
  const max = Math.max(1, ...series.map((item) => item.count));
  seriesTotal.textContent = `${series.reduce((sum, item) => sum + item.count, 0)} tracks`;
  chart.innerHTML = series
    .map((item) => {
      const percent = Math.round((item.count / max) * 100);
      return `
        <div>
          <div class="row-between tiny" style="margin-bottom:6px">
            <span class="muted">${escapeHtml(shortDate(item.date))}</span>
            <span class="mono">${item.count}</span>
          </div>
          <div class="progress"><span style="width:${percent}%"></span></div>
        </div>`;
    })
    .join("");
}

if (session) {
  try {
    const data = await session.request("/api/admin/statistics");
    renderKpis(data);
    renderChart(data.series || []);
  } catch (error) {
    if (error.status !== 401) chart.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
  }
}

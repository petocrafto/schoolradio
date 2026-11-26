import { dateTimeOf, escapeHtml } from "./common.js";
import { emptyState, initAdminShell } from "./admin-shell.js";

const body = document.querySelector("#history-body");
const wrap = document.querySelector("#history-wrap");
const empty = document.querySelector("#history-empty");
const count = document.querySelector("#history-count");

const session = await initAdminShell({
  active: "history",
  title: "History",
  subtitle: "The most recent 200 playback records.",
});

if (session) {
  try {
    const data = await session.request("/api/admin/history");
    const items = data.items || [];
    count.textContent = `${items.length} record${items.length === 1 ? "" : "s"}`;
    if (!items.length) {
      wrap.hidden = true;
      empty.innerHTML = emptyState("No tracks have been played yet.");
    } else {
      empty.innerHTML = "";
      wrap.hidden = false;
      body.innerHTML = items
        .map(
          (item) => `<tr>
            <td><strong>${escapeHtml(item.title)}</strong><br><small class="muted">${escapeHtml(item.channel_name)}</small></td>
            <td>${escapeHtml(item.requester_name)}</td>
            <td class="muted num nowrap">${escapeHtml(dateTimeOf(item.played_at))}</td>
            <td><span class="badge ${item.status === "played" ? "accent" : ""}">${escapeHtml(item.status)}</span>${item.reason ? `<br><small class="muted">${escapeHtml(item.reason)}</small>` : ""}</td>
          </tr>`,
        )
        .join("");
    }
  } catch (error) {
    if (error.status !== 401) {
      empty.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
    }
  }
}

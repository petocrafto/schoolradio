import { confirmDialog, dateTimeOf, escapeHtml, toast } from "./common.js";
import { emptyState, initAdminShell } from "./admin-shell.js";

const list = document.querySelector("#queue-list");
const count = document.querySelector("#queue-count");
const refreshBtn = document.querySelector("#refresh-btn");

let session = null;
let items = [];
let busy = false;

function render() {
  count.textContent = `${items.length} in queue`;
  if (!items.length) {
    list.innerHTML = emptyState("The queue is empty. Approve requests to fill it.", '<a class="btn btn-sm" href="/admin/requests" style="margin-top:6px">Review requests</a>');
    return;
  }
  list.innerHTML = items
    .map(
      (item, index) => `
      <article class="list-item" data-id="${escapeHtml(item.id)}">
        <span class="index">${index + 1}</span>
        <span class="grow">
          <strong>${escapeHtml(item.title)}</strong>
          <span class="muted tiny">${escapeHtml(item.channel_name)} · requested by ${escapeHtml(item.requester_name)} · ${escapeHtml(dateTimeOf(item.created_at))}</span>
        </span>
        <span class="row" style="gap:6px">
          <button class="btn btn-secondary btn-sm" data-act="up" type="button" ${index === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
          <button class="btn btn-secondary btn-sm" data-act="down" type="button" ${index === items.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          <button class="btn btn-ghost btn-sm" data-act="remove" type="button">Remove</button>
        </span>
      </article>`,
    )
    .join("");

  list.querySelectorAll("[data-act]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-id]");
      void handle(button.dataset.act, row.dataset.id);
    });
  });
}

async function handle(action, id) {
  if (busy) return;
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return;

  if (action === "remove") {
    const ok = await confirmDialog({ title: "Remove from queue", message: `Remove “${items[index].title}” from the queue?`, confirmLabel: "Remove" });
    if (!ok) return;
  }

  busy = true;
  try {
    if (action === "remove") {
      await session.request("/api/admin/requests", { method: "DELETE", body: { id } });
      toast("Removed from the queue.");
    } else {
      const swapWith = action === "up" ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= items.length) return;
      const reordered = items.slice();
      [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
      const moved = [reordered[swapWith], reordered[index]];
      await Promise.all(
        moved.map((item) =>
          session.request("/api/admin/requests", {
            method: "PATCH",
            body: { id: item.id, queuePosition: reordered.findIndex((entry) => entry.id === item.id) },
          }),
        ),
      );
      toast("Queue order updated.");
    }
    await load();
  } catch (error) {
    toast(error.message, "err");
  } finally {
    busy = false;
  }
}

async function load() {
  try {
    const data = await session.request("/api/admin/requests?status=approved");
    items = data.items || [];
    render();
  } catch (error) {
    if (error.status !== 401) list.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
  }
}

refreshBtn.addEventListener("click", () => void load());

session = await initAdminShell({
  active: "queue",
  title: "Queue",
  subtitle: "Order the approved songs and remove anything that should not air.",
});

if (session) await load();

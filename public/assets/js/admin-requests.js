import { confirmDialog, dateTimeOf, escapeHtml, toast } from "./common.js";
import { emptyState, initAdminShell } from "./admin-shell.js";

const list = document.querySelector("#request-list");
const listTitle = document.querySelector("#list-title");
const listCount = document.querySelector("#list-count");
const tabs = [document.querySelector("#tab-pending"), document.querySelector("#tab-approved")];
const refreshBtn = document.querySelector("#refresh-btn");

let session = null;
let filter = "pending";
let busy = false;

function setFilter(next) {
  filter = next;
  tabs.forEach((tab) => {
    const active = tab.dataset.tab === filter;
    tab.className = active ? "btn btn-sm" : "btn btn-secondary btn-sm";
    tab.setAttribute("aria-selected", String(active));
  });
  listTitle.textContent = filter === "pending" ? "Requests awaiting review" : "Approved requests";
  void load();
}

function rowActions(item) {
  if (filter === "pending") {
    return `
      <button class="btn btn-sm" data-act="approve" type="button">Approve</button>
      <button class="btn btn-secondary btn-sm" data-act="reject" type="button">Reject</button>
      <button class="btn btn-ghost btn-sm" data-act="delete" type="button">Delete</button>`;
  }
  return `
    <button class="btn btn-secondary btn-sm" data-act="unapprove" type="button">Back to pending</button>
    <button class="btn btn-ghost btn-sm" data-act="delete" type="button">Delete</button>`;
}

function render(items) {
  listCount.textContent = `${items.length} ${items.length === 1 ? "request" : "requests"}`;
  if (!items.length) {
    list.innerHTML = emptyState(filter === "pending" ? "Nothing is waiting for review. Nice work." : "No approved requests yet.");
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
        <span class="row wrap" style="gap:6px">${rowActions(item)}</span>
      </article>`,
    )
    .join("");

  list.querySelectorAll("[data-act]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-id]");
      handle(row.dataset.id, button.dataset.act, row.querySelector("strong").textContent);
    });
  });
}

async function handle(id, action, title) {
  if (busy) return;
  if (action === "delete") {
    const ok = await confirmDialog({ title: "Delete request", message: `Delete “${title}”? This cannot be undone.`, confirmLabel: "Delete" });
    if (!ok) return;
  }
  busy = true;
  try {
    if (action === "delete") {
      await session.request("/api/admin/requests", { method: "DELETE", body: { id } });
      toast("Request deleted.");
    } else {
      const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";
      await session.request("/api/admin/requests", { method: "PATCH", body: { id, status } });
      toast(status === "approved" ? "Request approved." : status === "rejected" ? "Request rejected." : "Moved back to pending.");
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
    const data = await session.request(`/api/admin/requests?status=${filter}`);
    render(data.items || []);
  } catch (error) {
    if (error.status !== 401) {
      list.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
    }
  }
}

tabs.forEach((tab) => tab.addEventListener("click", () => setFilter(tab.dataset.tab)));
refreshBtn.addEventListener("click", () => void load());

session = await initAdminShell({
  active: "requests",
  title: "Song requests",
  subtitle: "Approve or reject listener requests before they reach the queue.",
});

if (session) await load();

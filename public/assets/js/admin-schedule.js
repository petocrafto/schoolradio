import { confirmDialog, escapeHtml, setStatus, shortDate, toast, DAY_NAMES, DAY_ORDER } from "./common.js";
import { emptyState, initAdminShell } from "./admin-shell.js";

const BEHAVIORS = [
  { value: "continue", label: "Continue current playback" },
  { value: "opening_playlist", label: "Play opening playlist" },
  { value: "wait", label: "Wait for a track" },
];

const schemaWarning = document.querySelector("#schema-warning");

const weeklyForm = document.querySelector("#weekly-form");
const weeklyId = document.querySelector("#weekly-id");
const weeklyName = document.querySelector("#weekly-name");
const weeklyDay = document.querySelector("#weekly-day");
const weeklyStart = document.querySelector("#weekly-start");
const weeklyEnd = document.querySelector("#weekly-end");
const weeklyBehavior = document.querySelector("#weekly-behavior");
const weeklyEnabled = document.querySelector("#weekly-enabled");
const weeklySubmit = document.querySelector("#weekly-submit");
const weeklyTitle = document.querySelector("#weekly-title");
const weeklyCancel = document.querySelector("#weekly-cancel");
const weeklyMessage = document.querySelector("#weekly-message");
const weeklyList = document.querySelector("#weekly-list");
const weeklyCount = document.querySelector("#weekly-count");

const overrideForm = document.querySelector("#override-form");
const overrideId = document.querySelector("#override-id");
const overrideDate = document.querySelector("#override-date");
const overrideName = document.querySelector("#override-name");
const overrideStart = document.querySelector("#override-start");
const overrideEnd = document.querySelector("#override-end");
const overrideBehavior = document.querySelector("#override-behavior");
const overrideClosed = document.querySelector("#override-closed");
const overrideEnabled = document.querySelector("#override-enabled");
const overrideSubmit = document.querySelector("#override-submit");
const overrideTitle = document.querySelector("#override-title");
const overrideCancel = document.querySelector("#override-cancel");
const overrideMessage = document.querySelector("#override-message");
const overrideList = document.querySelector("#override-list");
const overrideCount = document.querySelector("#override-count");

let session = null;
let weekly = [];
let overrides = [];
let busy = false;

/* ------------------------------------------------------------- options */

weeklyDay.innerHTML = DAY_ORDER.map((value) => `<option value="${value}">${DAY_NAMES[value]}</option>`).join("");
weeklyBehavior.innerHTML = BEHAVIORS.map((item) => `<option value="${item.value}">${item.label}</option>`).join("");
overrideBehavior.innerHTML = BEHAVIORS.map((item) => `<option value="${item.value}">${item.label}</option>`).join("");
weeklyDay.value = "1";

overrideClosed.addEventListener("change", () => {
  const closed = overrideClosed.checked;
  overrideStart.disabled = closed;
  overrideEnd.disabled = closed;
  overrideStart.required = !closed;
  overrideEnd.required = !closed;
});

/* -------------------------------------------------------------- render */

function timeLabel(row) {
  if (row.disabled) return "Closed";
  const start = row.start_time.slice(0, 5);
  const end = row.end_time.slice(0, 5);
  return `${start}–${end}${end < start ? " · overnight" : ""}`;
}

function behaviorLabel(value) {
  return BEHAVIORS.find((item) => item.value === value)?.label || value;
}

function renderWeekly() {
  weeklyCount.textContent = `${weekly.length} session${weekly.length === 1 ? "" : "s"}`;
  if (!weekly.length) {
    weeklyList.innerHTML = emptyState("No weekly sessions configured yet. Add the first one on the left.");
    return;
  }
  weeklyList.innerHTML = DAY_ORDER.map((day) => {
    const rows = weekly.filter((item) => item.weekday === day);
    if (!rows.length) return "";
    return `
      <div class="schedule-day">
        <h4>${DAY_NAMES[day]}</h4>
        ${rows
          .map(
            (row) => `
          <div class="schedule-entry ${row.enabled ? "" : "off"}" data-kind="weekly" data-id="${escapeHtml(row.id)}">
            <span class="schedule-time">${escapeHtml(timeLabel(row))}</span>
            <span class="name">${escapeHtml(row.program_name)}</span>
            <span class="badge">${escapeHtml(behaviorLabel(row.start_behavior))}</span>
            <span class="badge ${row.enabled ? "accent" : ""}">${row.enabled ? "Enabled" : "Disabled"}</span>
            <span class="acts">
              <button class="btn btn-secondary btn-sm" data-act="toggle" type="button">${row.enabled ? "Disable" : "Enable"}</button>
              <button class="btn btn-secondary btn-sm" data-act="edit" type="button">Edit</button>
              <button class="btn btn-ghost btn-sm" data-act="delete" type="button">Delete</button>
            </span>
          </div>`,
          )
          .join("")}
      </div>`;
  }).join("");
}

function renderOverrides() {
  overrideCount.textContent = `${overrides.length} override${overrides.length === 1 ? "" : "s"}`;
  if (!overrides.length) {
    overrideList.innerHTML = emptyState("No date overrides. The weekly schedule applies every week.");
    return;
  }
  overrideList.innerHTML = overrides
    .map(
      (row) => `
      <div class="schedule-entry ${row.enabled ? "" : "off"}" data-kind="override" data-id="${escapeHtml(row.id)}">
        <span class="schedule-time">${escapeHtml(shortDate(row.schedule_date))}</span>
        <span class="name">${escapeHtml(row.program_name)}</span>
        <span class="badge ${row.disabled ? "warning" : "teal"}">${row.disabled ? "Closed day" : escapeHtml(timeLabel(row))}</span>
        <span class="badge ${row.enabled ? "accent" : ""}">${row.enabled ? "Enabled" : "Disabled"}</span>
        <span class="acts">
          <button class="btn btn-secondary btn-sm" data-act="toggle" type="button">${row.enabled ? "Disable" : "Enable"}</button>
          <button class="btn btn-secondary btn-sm" data-act="edit" type="button">Edit</button>
          <button class="btn btn-ghost btn-sm" data-act="delete" type="button">Delete</button>
        </span>
      </div>`,
    )
    .join("");
}

/* --------------------------------------------------------------- forms */

function resetWeeklyForm() {
  weeklyId.value = "";
  weeklyName.value = "";
  weeklyDay.value = "1";
  weeklyStart.value = "08:00";
  weeklyEnd.value = "15:00";
  weeklyBehavior.value = "continue";
  weeklyEnabled.checked = true;
  weeklyTitle.textContent = "Add weekly session";
  weeklySubmit.textContent = "Add session";
  weeklyCancel.hidden = true;
  setStatus(weeklyMessage, "");
}

function resetOverrideForm() {
  overrideId.value = "";
  overrideDate.value = "";
  overrideName.value = "";
  overrideStart.value = "08:00";
  overrideEnd.value = "15:00";
  overrideBehavior.value = "continue";
  overrideClosed.checked = false;
  overrideStart.disabled = false;
  overrideEnd.disabled = false;
  overrideEnabled.checked = true;
  overrideTitle.textContent = "Add date override";
  overrideSubmit.textContent = "Add override";
  overrideCancel.hidden = true;
  setStatus(overrideMessage, "");
}

function editWeekly(row) {
  weeklyId.value = row.id;
  weeklyName.value = row.program_name;
  weeklyDay.value = String(row.weekday);
  weeklyStart.value = row.start_time.slice(0, 5);
  weeklyEnd.value = row.end_time.slice(0, 5);
  weeklyBehavior.value = row.start_behavior;
  weeklyEnabled.checked = row.enabled;
  weeklyTitle.textContent = "Edit weekly session";
  weeklySubmit.textContent = "Save changes";
  weeklyCancel.hidden = false;
  weeklyForm.scrollIntoView({ behavior: "smooth", block: "center" });
  weeklyName.focus();
}

function editOverride(row) {
  overrideId.value = row.id;
  overrideDate.value = row.schedule_date;
  overrideName.value = row.program_name;
  overrideStart.value = row.start_time ? row.start_time.slice(0, 5) : "08:00";
  overrideEnd.value = row.end_time ? row.end_time.slice(0, 5) : "15:00";
  overrideBehavior.value = row.start_behavior;
  overrideClosed.checked = Boolean(row.disabled);
  overrideStart.disabled = Boolean(row.disabled);
  overrideEnd.disabled = Boolean(row.disabled);
  overrideEnabled.checked = row.enabled;
  overrideTitle.textContent = "Edit date override";
  overrideSubmit.textContent = "Save changes";
  overrideCancel.hidden = false;
  overrideForm.scrollIntoView({ behavior: "smooth", block: "center" });
  overrideName.focus();
}

weeklyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const body = {
    kind: "weekly",
    programName: weeklyName.value.trim(),
    weekday: Number(weeklyDay.value),
    startTime: weeklyStart.value,
    endTime: weeklyEnd.value,
    startBehavior: weeklyBehavior.value,
    enabled: weeklyEnabled.checked,
  };
  if (!body.programName) return setStatus(weeklyMessage, "Enter a programme name.", "error");
  if (body.startTime === body.endTime) return setStatus(weeklyMessage, "Start and end times must differ.", "error");

  busy = true;
  weeklySubmit.disabled = true;
  setStatus(weeklyMessage, "");
  try {
    if (weeklyId.value) {
      await session.request("/api/admin/schedules", { method: "PATCH", body: { ...body, id: weeklyId.value } });
      toast("Weekly session updated.");
    } else {
      await session.request("/api/admin/schedules", { method: "POST", body });
      toast("Weekly session added.");
    }
    resetWeeklyForm();
    await load();
  } catch (error) {
    setStatus(weeklyMessage, error.message, "error");
  } finally {
    busy = false;
    weeklySubmit.disabled = false;
  }
});

overrideForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const body = {
    kind: "override",
    programName: overrideName.value.trim(),
    date: overrideDate.value,
    startTime: overrideStart.value,
    endTime: overrideEnd.value,
    startBehavior: overrideBehavior.value,
    disabled: overrideClosed.checked,
    enabled: overrideEnabled.checked,
  };
  if (!body.programName) return setStatus(overrideMessage, "Enter a programme name.", "error");
  if (!body.date) return setStatus(overrideMessage, "Choose a date.", "error");
  if (!body.disabled && body.startTime === body.endTime) return setStatus(overrideMessage, "Start and end times must differ.", "error");

  busy = true;
  overrideSubmit.disabled = true;
  setStatus(overrideMessage, "");
  try {
    if (overrideId.value) {
      await session.request("/api/admin/schedules", { method: "PATCH", body: { ...body, id: overrideId.value } });
      toast("Date override updated.");
    } else {
      await session.request("/api/admin/schedules", { method: "POST", body });
      toast("Date override added.");
    }
    resetOverrideForm();
    await load();
  } catch (error) {
    setStatus(overrideMessage, error.message, "error");
  } finally {
    busy = false;
    overrideSubmit.disabled = false;
  }
});

weeklyCancel.addEventListener("click", resetWeeklyForm);
overrideCancel.addEventListener("click", resetOverrideForm);

/* -------------------------------------------------------------- actions */

function bindActions(container, kind) {
  container.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const row = button.closest("[data-id]");
    const id = row.dataset.id;
    const item = (kind === "weekly" ? weekly : overrides).find((entry) => entry.id === id);
    if (!item) return;

    if (button.dataset.act === "edit") {
      if (kind === "weekly") editWeekly(item);
      else editOverride(item);
      return;
    }

    if (button.dataset.act === "delete") {
      const ok = await confirmDialog({
        title: "Delete session",
        message: `Delete “${item.program_name}”? This cannot be undone.`,
        confirmLabel: "Delete",
      });
      if (!ok) return;
    }

    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      if (button.dataset.act === "delete") {
        await session.request("/api/admin/schedules", { method: "DELETE", body: { kind, id } });
        toast("Session deleted.");
      } else {
        await session.request("/api/admin/schedules", { method: "PATCH", body: { kind, id, enabled: !item.enabled } });
        toast(item.enabled ? "Session disabled." : "Session enabled.");
      }
      await load();
    } catch (error) {
      toast(error.message, "err");
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
}

bindActions(weeklyList, "weekly");
bindActions(overrideList, "override");

/* ----------------------------------------------------------------- load */

async function load() {
  try {
    const data = await session.request("/api/admin/schedules");
    weekly = data.weekly || [];
    overrides = data.overrides || [];
    schemaWarning.hidden = data.schemaReady !== false;
    renderWeekly();
    renderOverrides();
  } catch (error) {
    if (error.status === 401) return;
    weeklyList.innerHTML = `<div class="form-error">${escapeHtml(error.message)}</div>`;
    overrideList.innerHTML = "";
  }
}

session = await initAdminShell({
  active: "schedule",
  title: "Schedule",
  subtitle: "Weekly programme sessions and date-specific overrides, in Asia/Jakarta time.",
});

if (session) await load();

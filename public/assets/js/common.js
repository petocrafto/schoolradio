/* Shared helpers for every page. */

const CONFIG_URL = "/api/config";

let configPromise = null;
let client = null;

export function getConfig() {
  if (!configPromise) {
    configPromise = fetch(CONFIG_URL, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error("Configuration is unavailable.");
        return response.json();
      })
      .catch((error) => {
        configPromise = null;
        throw error;
      });
  }
  return configPromise;
}

export async function getSupabase() {
  if (client) return client;
  const config = await getConfig();
  client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, options = {}) {
  const headers = { accept: "application/json", ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let response;
  try {
    response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError("Network error. Check the connection and try again.", 0);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload && typeof payload.error === "string" ? payload.error : "Request failed. Please try again.";
    throw new ApiError(message, response.status);
  }
  return payload;
}

/* ------------------------------------------------------------- format */

const jakartaDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" });
const jakartaTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const jakartaClock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const jakartaFull = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const clockFormat = (date) => jakartaClock.format(date);

export function timeOf(value) {
  return jakartaTime.format(new Date(value));
}

export function timeRange(start, end) {
  return `${timeOf(start)}–${timeOf(end)}`;
}

export function dateTimeOf(value) {
  return `${jakartaFull.format(new Date(value))} WIB`;
}

export function shortDate(value) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short" }).format(new Date(`${value}T00:00:00+07:00`));
}

export function todayJakarta() {
  const parts = Object.fromEntries(jakartaDate.formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function weekdayOf(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export function debounce(fn, wait = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* -------------------------------------------------------------- toast */

let toastHost = null;

export function toast(message, type = "ok") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    toastHost.setAttribute("role", "status");
    toastHost.setAttribute("aria-live", "polite");
    document.body.appendChild(toastHost);
  }
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.innerHTML = `<span class="toast-dot"></span><span>${escapeHtml(message)}</span>`;
  toastHost.appendChild(element);
  setTimeout(() => {
    element.style.opacity = "0";
    element.style.transform = "translateY(-4px)";
    element.style.transition = "opacity .2s, transform .2s";
    setTimeout(() => element.remove(), 220);
  }, 4200);
}

/* -------------------------------------------------------------- modal */

export function confirmDialog({ title, message, confirmLabel = "Delete", danger = true }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="actions">
          <button class="btn btn-ghost" data-act="cancel" type="button">Cancel</button>
          <button class="btn ${danger ? "btn-danger" : ""}" data-act="ok" type="button">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(false);
    };
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
      const action = event.target.closest("[data-act]")?.dataset.act;
      if (action === "ok") close(true);
      if (action === "cancel") close(false);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-act="ok"]').focus();
  });
}

/* ------------------------------------------------------------- status */

export function setStatus(element, message, type = "muted") {
  if (!element) return;
  element.textContent = message;
  element.className = type === "error" ? "form-error" : type === "ok" ? "form-ok" : "muted";
  element.hidden = !message;
}

export function skeletonRows(count, height = 74) {
  return Array.from({ length: count }, () => `<div class="skeleton" style="height:${height}px"></div>`).join("");
}

import { api, escapeHtml, getSupabase, clockFormat } from "./common.js";

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg>',
  requests: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>',
  statistics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
};

const NAV = [
  { id: "dashboard", label: "Dashboard", href: "/admin", icon: "dashboard" },
  { id: "requests", label: "Song requests", href: "/admin/requests", icon: "requests" },
  { id: "queue", label: "Queue", href: "/admin/queue", icon: "queue" },
  { id: "schedule", label: "Schedule", href: "/admin/schedule", icon: "schedule" },
  { id: "history", label: "History", href: "/admin/history", icon: "history" },
  { id: "statistics", label: "Statistics", href: "/admin/statistics", icon: "statistics" },
  { id: "settings", label: "Settings", href: "/admin/settings", icon: "settings" },
];

const STORAGE_KEY = "school-radio-admin";

export function readAdminCache() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function initials(email) {
  const value = (email || "?").split("@")[0];
  return value.slice(0, 2).toUpperCase();
}

/**
 * Renders the admin shell and returns a session object, or redirects to sign-in.
 */
export async function initAdminShell({ active, title, subtitle }) {
  const db = await getSupabase();
  const { data } = await db.auth.getSession();
  const session = data.session;
  if (!session) {
    location.replace("/admin/login");
    return null;
  }

  const request = async (path, options = {}) => {
    const { data: current } = await db.auth.getSession();
    if (!current.session) {
      location.replace("/admin/login");
      throw new Error("Signed out.");
    }
    return api(path, { ...options, token: current.session.access_token });
  };

  let me;
  try {
    me = await request("/api/admin/me");
  } catch (error) {
    if (error.status === 401) {
      await db.auth.signOut();
      location.replace("/admin/login?reason=not-admin");
      return null;
    }
    throw error;
  }

  const email = (me.user && me.user.email) || session.user.email || "admin";
  const sidebar = document.querySelector("#sidebar");
  if (sidebar) {
    sidebar.innerHTML = `
      <a class="brand" href="/">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>
        </span>
        <span>School Radio<small>Control room</small></span>
      </a>
      <div class="side-group">
        <div class="side-label">Station</div>
        ${NAV.map(
          (item) => `<a class="side-link ${item.id === active ? "active" : ""}" href="${item.href}">${ICONS[item.icon]}<span>${item.label}</span></a>`,
        ).join("")}
      </div>
      <div class="sidebar-footer">
        <div class="user-chip">
          <span class="avatar">${escapeHtml(initials(email))}</span>
          <span class="who"><strong>${escapeHtml(email)}</strong><span>Administrator</span></span>
        </div>
        <a class="side-link" href="/" target="_blank" rel="noopener">${ICONS.external}<span>Open station</span></a>
        <button class="side-link" id="sign-out" type="button" style="background:none;border:0;cursor:pointer;text-align:left;font:inherit">${ICONS.logout}<span>Sign out</span></button>
      </div>`;
    sidebar.querySelector("#sign-out").addEventListener("click", async () => {
      await db.auth.signOut();
      sessionStorage.removeItem(STORAGE_KEY);
      location.replace("/admin/login");
    });
  }

  const topbar = document.querySelector("#app-topbar");
  if (topbar) {
    topbar.innerHTML = `
      <div style="min-width:0">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<div class="sub">${escapeHtml(subtitle)}</div>` : ""}
      </div>
      <div class="spacer"></div>
      <span class="live-pill" id="shell-live"><span class="live-dot"></span><span id="shell-live-text">Off air</span></span>
      <span class="badge mono" id="shell-clock">${clockFormat(new Date())}</span>`;
    const clock = topbar.querySelector("#shell-clock");
    setInterval(() => {
      clock.textContent = clockFormat(new Date());
    }, 1000);
  }

  db.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") location.replace("/admin/login");
  });

  return { db, session, user: me.user, email, request };
}

export async function setLiveIndicator(playing) {
  const pill = document.querySelector("#shell-live");
  const text = document.querySelector("#shell-live-text");
  if (!pill || !text) return;
  pill.classList.toggle("on", Boolean(playing));
  text.textContent = playing ? "On air" : "Off air";
}

export function emptyState(message, action) {
  return `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span>${escapeHtml(message)}</span>${action || ""}</div>`;
}

export function skeleton(count, height = 70) {
  return Array.from({ length: count }, () => `<div class="skeleton" style="height:${height}px"></div>`).join("");
}

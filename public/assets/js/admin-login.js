import { api, getSupabase, setStatus } from "./common.js";

const form = document.querySelector("#login-form");
const email = document.querySelector("#email");
const password = document.querySelector("#password");
const button = document.querySelector("#login-btn");
const message = document.querySelector("#login-message");

const params = new URLSearchParams(location.search);
if (params.get("reason") === "not-admin") {
  setStatus(message, "That account is not registered as a radio administrator.", "error");
}

async function redirectIfSignedIn() {
  const db = await getSupabase();
  const { data } = await db.auth.getSession();
  if (!data.session) return;
  try {
    await api("/api/admin/me", { token: data.session.access_token });
    location.replace("/admin");
  } catch {
    await db.auth.signOut();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const emailValue = email.value.trim();
  const passwordValue = password.value;
  if (!emailValue || !passwordValue) {
    setStatus(message, "Enter your email and password.", "error");
    return;
  }
  button.disabled = true;
  button.textContent = "Signing in…";
  setStatus(message, "");
  try {
    const db = await getSupabase();
    const { data, error } = await db.auth.signInWithPassword({ email: emailValue, password: passwordValue });
    if (error) throw error;
    try {
      await api("/api/admin/me", { token: data.session.access_token });
    } catch (adminError) {
      await db.auth.signOut();
      throw new Error(adminError.status === 401 ? "That account is not registered as a radio administrator." : adminError.message);
    }
    location.replace("/admin");
  } catch (error) {
    setStatus(message, error.message || "Sign in failed.", "error");
    button.disabled = false;
    button.textContent = "Sign in";
  }
});

redirectIfSignedIn().catch(() => {});

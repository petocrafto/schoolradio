import { setStatus, toast } from "./common.js";
import { initAdminShell } from "./admin-shell.js";

const form = document.querySelector("#settings-form");
const radioName = document.querySelector("#radio-name");
const moderation = document.querySelector("#moderation");
const limit = document.querySelector("#limit");
const saveBtn = document.querySelector("#save-btn");
const message = document.querySelector("#settings-message");

const session = await initAdminShell({
  active: "settings",
  title: "Settings",
  subtitle: "Station identity and request rules.",
});

if (session) {
  try {
    const data = await session.request("/api/admin/settings");
    radioName.value = data.radioName;
    moderation.value = data.moderationMode;
    limit.value = String(data.requestLimit);
    saveBtn.disabled = false;
    saveBtn.textContent = "Save settings";
  } catch (error) {
    saveBtn.textContent = "Save settings";
    if (error.status !== 401) setStatus(message, error.message, "error");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const requestLimit = Number(limit.value);
    if (!Number.isInteger(requestLimit) || requestLimit < 1 || requestLimit > 50) {
      setStatus(message, "Request limit must be between 1 and 50.", "error");
      return;
    }
    if (!radioName.value.trim()) {
      setStatus(message, "Enter the radio name.", "error");
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    setStatus(message, "");
    try {
      await session.request("/api/admin/settings", {
        method: "PUT",
        body: {
          radioName: radioName.value.trim(),
          moderationMode: moderation.value,
          requestLimit,
          timezone: "Asia/Jakarta",
        },
      });
      toast("Settings saved.");
      setStatus(message, "Settings saved.", "ok");
    } catch (error) {
      setStatus(message, error.message, "error");
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save settings";
    }
  });
}

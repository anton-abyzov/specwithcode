// @effect-diagnostics globalTimers:off globalDate:off -- A static page's countdown and clock, in a preload with no Effect runtime.
import { ipcRenderer } from "electron";

import { SCREEN_SHARE_WINDOW_CHANNEL } from "./ipc/channels.ts";
import { formatElapsed } from "./screenShare/screenShareWindows.logic.ts";

// This preload belongs only to the screen sharing prompt and banner (1490).
// No general desktop bridge is exposed: the page can say Deny, Allow once,
// Always allow or Stop, and nothing else. Allowing still needs Touch ID or the
// password, which the main process asks the system for.
window.addEventListener("DOMContentLoaded", () => {
  const { window: kind, sid, expires, started } = document.body.dataset;
  const on = (id: string, message: unknown) =>
    document.getElementById(id)?.addEventListener("click", () => {
      ipcRenderer.send(SCREEN_SHARE_WINDOW_CHANNEL, message);
    });
  if (kind === "prompt" && sid !== undefined) {
    for (const answer of ["deny", "once", "always"] as const)
      on(answer, { window: "prompt", sid, answer });
    const left = document.getElementById("left");
    const until = Number(expires);
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      if (left !== null) left.textContent = `${seconds} s left.`;
    };
    if (Number.isFinite(until)) {
      tick();
      setInterval(tick, 500);
    }
  } else if (kind === "banner") {
    on("stop", { window: "banner", action: "stop" });
    const elapsed = document.getElementById("elapsed");
    const since = Number(started);
    const tick = () => {
      if (elapsed !== null) elapsed.textContent = formatElapsed(Date.now() - since);
    };
    if (Number.isFinite(since)) {
      tick();
      setInterval(tick, 1000);
    }
  }
});

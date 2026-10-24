/**
 * What the toolbar badge, its tooltip and the popup say for each connection state.
 * Every state has its own text, so color is never the only signal.
 */

const clock = (time) =>
  new Date(time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function badgeFor(phase) {
  switch (phase) {
    case "connected":
      return { text: "ON", color: "#2f9e44" };
    case "disconnected":
      return { text: "OFF", color: "#e03131" };
    case "rejected":
      return { text: "!", color: "#e03131" };
    case "paused":
      return { text: "II", color: "#868e96" };
    case "connecting":
      return { text: "…", color: "#f08c00" };
    default:
      return { text: "OFF", color: "#868e96" };
  }
}

export function titleFor(view) {
  const name = "SpecWithCode Browser";
  const since = view.disconnectedAt ? ` since ${clock(view.disconnectedAt)}` : "";
  const next = view.nextRetryAt ? ` Next try at ${clock(view.nextRetryAt)}.` : "";
  switch (view.phase) {
    case "connected":
      return `${name}: connected. Agents can use this profile (${view.label}).`;
    case "disconnected":
      return `${name}: NOT connected${since}. Agents cannot use this profile. Reconnecting on its own.`;
    case "rejected":
      return `${name}: NOT connected${since}. SpecWithCode did not accept the pairing code.${next} If it keeps failing, paste the current code from Settings › Chrome.`;
    case "paused":
      return `${name}: paused. Agents cannot use this profile.`;
    case "connecting":
      return `${name}: connecting…`;
    default:
      return `${name}: not paired. Click to pair this profile.`;
  }
}

/** When it was last connected and when the next automatic try is, from the worker's own clock. */
export function timingText(state) {
  const parts = [];
  if (state.phase !== "connected" && state.disconnectedAt)
    parts.push(`Not connected since ${clock(state.disconnectedAt)}.`);
  else if (state.phase !== "connected" && state.lastConnectedAt)
    parts.push(`Last connected at ${clock(state.lastConnectedAt)}.`);
  if (state.phase === "connecting" && state.shownPhase !== "connecting") parts.push("Trying now…");
  else if (state.nextRetryAt) {
    const seconds = Math.max(0, Math.ceil((state.nextRetryAt - (state.now ?? Date.now())) / 1000));
    parts.push(
      seconds < 90 ? `Next try in ${seconds} s.` : `Next try at ${clock(state.nextRetryAt)}.`,
    );
  }
  return parts.join(" ");
}

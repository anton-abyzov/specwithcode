// Needs no permissions: it only draws its own command, status and pane.
export function register(on) {
  let endsAt = null;
  let ticker = null;

  const remaining = () => Math.max(0, Math.ceil((endsAt - Date.now()) / 60_000));

  const stop = ($, message) => {
    clearInterval(ticker);
    endsAt = null;
    $.ui.status(undefined);
    if (message) $.ui.toast(message);
  };

  on("app.start", ($, e, next) => {
    $.command.register({ name: "focus-start", description: "Start a 25 minute focus timer" });
    $.command.register({ name: "focus-stop", description: "Stop the focus timer" });
    return next(e);
  });

  on("command.run", { name: "focus-start" }, ($) => {
    clearInterval(ticker);
    endsAt = Date.now() + 25 * 60_000;
    $.ui.status(`Focus ${remaining()} min`);
    ticker = setInterval(() => {
      if (remaining() === 0) stop($, "Focus time is over.");
      else $.ui.status(`Focus ${remaining()} min`);
    }, 15_000);
  });

  on("command.run", { name: "focus-stop" }, ($) => stop($, "Focus timer stopped."));
}

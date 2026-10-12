// The closure queue: open increments whose tasks are all done or skipped,
// sorted by what stands between them and `specweave complete`. A ledger
// "done" is an agent's claim; a green `specweave verify` that ran after the
// last task finished is what makes an increment closable.
export function register(on) {
  const OPEN_ENDED = new Set(["completed", "abandoned", "archived", "cancelled", "closed"]);
  const FINISHED = new Set(["done", "skipped"]);
  let increments = [];
  let ready = null;

  const lastTaskAt = (increment) =>
    Math.max(
      0,
      ...increment.tasks.map((task) => (task.changedAt ? Date.parse(task.changedAt) : 0)),
    );

  const queue = () =>
    increments
      .filter(
        (increment) =>
          increment.readable &&
          !OPEN_ENDED.has(increment.status) &&
          increment.tasks.length > 0 &&
          increment.tasks.every((task) => FINISHED.has(task.status)),
      )
      .map((increment) => {
        const verify = increment.verify;
        if (verify === null)
          return { increment, tone: "warning", state: "Never verified", next: "specweave verify" };
        if (!verify.ok)
          return { increment, tone: "danger", state: "Verify failed", next: "specweave verify" };
        if (Date.parse(verify.ranAt) < lastTaskAt(increment)) {
          return {
            increment,
            tone: "warning",
            state: "Verify is older than the last task",
            next: "specweave verify",
          };
        }
        return {
          increment,
          tone: "success",
          state: "Ready",
          next: `specweave complete ${increment.id.split("-")[0]}`,
        };
      })
      .sort((a, b) => (a.state === "Ready" ? 0 : 1) - (b.state === "Ready" ? 0 : 1));

  const refresh = ($) => {
    const rows = queue();
    const closable = rows.filter((row) => row.state === "Ready");
    const blocked = rows.length - closable.length;
    const parts = [];
    if (closable.length > 0) parts.push(`${closable.length} ready to close`);
    if (blocked > 0) parts.push(`${blocked} ${blocked === 1 ? "needs" : "need"} verify`);
    $.ui.status(parts.length === 0 ? undefined : parts.join(" · "));
    const ids = new Set(closable.map((row) => row.increment.id));
    if (ready !== null) {
      const fresh = [...ids].filter((id) => !ready.has(id));
      if (fresh.length > 0) $.ui.toast(`Ready to close: ${fresh.join(", ")}`);
    }
    ready = ids;
  };

  on("app.start", ($, e, next) => {
    $.command.register({
      name: "close-queue",
      description: "Show increments waiting to be closed",
    });
    return next(e);
  });

  on("specweave.changed", ($, e, next) => {
    increments = e.increments;
    refresh($);
    return next(e);
  });

  on("command.run", { name: "close-queue" }, ($) =>
    $.ui.open({ id: "queue", title: "Ready to close" }),
  );

  on("ui.render", { component: "Pane", requestId: "queue" }, () => {
    const rows = queue();
    if (rows.length === 0) {
      return h("Text", { tone: "muted" }, "No open increment has all its tasks done yet.");
    }
    return h(
      "Box",
      { gap: 3 },
      rows
        .slice(0, 20)
        .map((row) =>
          h(
            "Box",
            { gap: 1 },
            h(
              "Box",
              { direction: "row", gap: 2 },
              h("Text", { tone: "strong" }, row.increment.id),
              h("Text", { tone: row.tone }, row.state),
            ),
            h(
              "Text",
              { tone: "muted" },
              `${row.increment.project} · ${row.increment.tasks.length} ${row.increment.tasks.length === 1 ? "task" : "tasks"} done${
                row.increment.verify
                  ? ` · last verify ${new Date(row.increment.verify.ranAt).toLocaleString([], {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}`
                  : ""
              }`,
            ),
            h("Text", { mono: true }, row.next),
          ),
        ),
    );
  });
}

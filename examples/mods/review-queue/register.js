// Shows how many sessions on this host wait for an approval, an answer or a
// plan review, and opens any of them from a pane.
export function register(on) {
  let threads = [];
  const waiting = () => threads.filter((thread) => thread.attention !== null);

  on("app.start", ($, e, next) => {
    $.command.register({ name: "review-queue", description: "Show sessions waiting on me" });
    return next(e);
  });

  on("threads.changed", ($, e, next) => {
    threads = e.threads;
    const count = waiting().length;
    $.ui.status(count === 0 ? undefined : `${count} waiting`);
    return next(e);
  });

  on("command.run", { name: "review-queue" }, ($) =>
    $.ui.open({ id: "queue", title: "Waiting on you" }),
  );

  on("ui.render", { component: "Pane", requestId: "queue" }, ($) => {
    const rows = waiting();
    if (rows.length === 0) return h("Text", { tone: "muted" }, "Nothing is waiting on you.");
    return h(
      "Box",
      { gap: 2 },
      rows.map((thread) =>
        h(
          "Box",
          { direction: "row", gap: 2 },
          h("Text", { tone: "strong" }, thread.title),
          h("Text", { tone: "muted" }, `${thread.project ?? "No project"} · ${thread.state}`),
          h("Button", { onPress: () => $.threads.open(thread.id) }, "Open"),
        ),
      ),
    );
  });
}

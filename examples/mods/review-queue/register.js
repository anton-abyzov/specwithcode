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
    $.ui.status([
      {
        glyph: "waiting",
        count: waiting().length,
        label: "Waiting on you",
        detail: "Sessions waiting for an approval, an answer or a plan review. Press to see them.",
        onPress: () => $.ui.open({ id: "queue", title: "Waiting on you" }),
      },
    ]);
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
      // The host draws at most 400 nodes and 8000 characters per pane.
      rows
        .slice(0, 40)
        .map((thread) =>
          h(
            "Box",
            { direction: "row", gap: 2 },
            h("Text", { tone: "strong" }, thread.title.slice(0, 80)),
            h("Text", { tone: "muted" }, `${thread.project ?? "No project"} · ${thread.state}`),
            h("Button", { onPress: () => $.threads.open(thread.id) }, "Open"),
          ),
        ),
      rows.length > 40 ? h("Text", { tone: "muted" }, `${rows.length - 40} more waiting.`) : null,
    );
  });
}

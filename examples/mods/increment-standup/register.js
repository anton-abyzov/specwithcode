// A standup written from the SpecWeave ledger instead of chat history: per
// increment, what got done in the window you pick, what is claimed, what is
// blocked (with the reason) and which claims went stale.
export function register(on) {
  const CLOSED = new Set(["completed", "abandoned", "archived", "cancelled", "closed"]);
  const FINISHED = new Set(["done", "skipped"]);
  let increments = [];
  let windowHours = 24;

  const since = (iso, from) => {
    const at = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(at) && at >= from;
  };

  const acProgress = (increment) => {
    const met = increment.criteria.filter((criterion) => {
      const covering = increment.tasks.filter((task) => task.criteria.includes(criterion.id));
      return covering.length > 0 && covering.every((task) => FINISHED.has(task.status));
    }).length;
    return `${met}/${increment.criteria.length} ACs met`;
  };

  const report = () => {
    const from = Date.now() - windowHours * 3_600_000;
    return increments
      .map((increment) => {
        // A closed increment has no work left to do; leftover claims are noise.
        const open = !CLOSED.has(increment.status);
        const live = (status) =>
          open ? increment.tasks.filter((task) => task.status === status) : [];
        return {
          increment,
          closed: !open && since(increment.updatedAt, from),
          done: increment.tasks.filter(
            (task) => FINISHED.has(task.status) && since(task.changedAt, from),
          ),
          doing: live("claimed"),
          blocked: live("blocked"),
          stale: live("stale"),
        };
      })
      .filter(
        (row) =>
          row.closed ||
          row.done.length + row.doing.length + row.blocked.length + row.stale.length > 0,
      );
  };

  // One pane per stat: the same open tasks, without the rest of the standup.
  const LISTS = {
    "standup-blocked": {
      key: "blocked",
      title: "Blocked tasks",
      tone: "danger",
      empty: "Nothing is blocked.",
    },
    "standup-stale": {
      key: "stale",
      title: "Stale claims",
      tone: "warning",
      empty: "No claim went stale.",
    },
  };

  const status = ($) => {
    const rows = report();
    const count = (key) => rows.reduce((sum, row) => sum + row[key].length, 0);
    $.ui.status([
      {
        glyph: "blocked",
        count: count("blocked"),
        label: "Blocked",
        detail: "Tasks in open increments marked blocked. Press to see each one and why.",
        onPress: () => $.ui.open({ id: "standup-blocked", title: LISTS["standup-blocked"].title }),
      },
      {
        glyph: "stale",
        count: count("stale"),
        label: "Stale claims",
        detail: "Tasks claimed over two hours ago with no update since. Press to see them.",
        onPress: () => $.ui.open({ id: "standup-stale", title: LISTS["standup-stale"].title }),
      },
    ]);
  };

  on("app.start", ($, e, next) => {
    $.command.register({
      name: "standup",
      description: "Show the standup from SpecWeave increments",
    });
    // The window slides with the clock, so an open pane redraws every minute.
    setInterval(() => $.ui.redraw("standup"), 60_000);
    return next(e);
  });

  on("specweave.changed", ($, e, next) => {
    increments = e.increments;
    status($);
    return next(e);
  });

  on("command.run", { name: "standup" }, ($) => $.ui.open({ id: "standup", title: "Standup" }));

  for (const [id, list] of Object.entries(LISTS)) {
    on("ui.render", { component: "Pane", requestId: id }, () => {
      const rows = report().filter((row) => row[list.key].length > 0);
      if (rows.length === 0) return h("Text", { tone: "muted" }, list.empty);
      // The host draws at most 8000 characters of text and 400 nodes per pane.
      let budget = 6000;
      let nodes = 390;
      let hidden = 0;
      const blocks = [];
      for (const row of rows) {
        const lines = [];
        for (const task of row[list.key]) {
          const text = `${task.id} ${task.title.slice(0, 80)}${task.note ? ` (${task.note.slice(0, 120)})` : ""}`;
          // A line is two nodes; the first in an increment also needs its heading's three.
          const cost = lines.length === 0 ? 5 : 2;
          if (budget < text.length + 100 || nodes < cost) {
            hidden += 1;
            continue;
          }
          budget -= text.length;
          nodes -= cost;
          lines.push(h("Text", { tone: list.tone }, text));
        }
        if (lines.length === 0) continue;
        const heading = `${row.increment.id} · ${row.increment.project}`;
        budget -= heading.length;
        blocks.push(h("Box", { gap: 1 }, h("Text", { tone: "strong" }, heading), lines));
      }
      return h(
        "Box",
        { gap: 3 },
        blocks,
        hidden > 0 ? h("Text", { tone: "muted" }, `${hidden} more not shown.`) : null,
      );
    });
  }

  on("ui.render", { component: "Pane", requestId: "standup" }, () => {
    const rows = report();
    const pick = (hours, label) =>
      h(
        "Button",
        {
          variant: windowHours === hours ? "default" : "ghost",
          onPress: () => {
            windowHours = hours;
          },
        },
        label,
      );
    const titles = (tasks) =>
      tasks
        .slice(0, 6)
        .map(
          (task) =>
            `${task.id} ${task.title.length > 80 ? `${task.title.slice(0, 79)}…` : task.title}`,
        )
        .join("; ") + (tasks.length > 6 ? `; and ${tasks.length - 6} more` : "");
    const line = (tone, label, text) =>
      h("Box", { direction: "row", gap: 2 }, h("Text", { tone }, label), h("Text", {}, text));
    const total = (key) => rows.reduce((sum, row) => sum + row[key].length, 0);
    const doneCount = total("done");

    return h(
      "Box",
      { gap: 3 },
      h(
        "Box",
        { direction: "row", gap: 1 },
        pick(24, "Since yesterday"),
        pick(72, "Last 3 days"),
        pick(168, "Last week"),
      ),
      h(
        "Text",
        { tone: "strong" },
        `${doneCount} ${doneCount === 1 ? "task" : "tasks"} done · ${total("doing")} in progress · ${total("blocked")} blocked · ${total("stale")} stale`,
      ),
      rows.length === 0
        ? h("Text", { tone: "muted" }, "Nothing moved in the ledger in this window.")
        : rows.slice(0, 8).map((row) =>
            h(
              "Box",
              { gap: 1 },
              h(
                "Text",
                { tone: "strong" },
                `${row.increment.id} · ${row.increment.project}${row.closed ? " · closed" : ""}`,
              ),
              h(
                "Text",
                { tone: "muted" },
                `${row.increment.title ?? "Untitled"} · ${acProgress(row.increment)}`,
              ),
              row.done.length > 0 ? line("success", "Done", titles(row.done)) : null,
              row.doing.length > 0 ? line("default", "Doing", titles(row.doing)) : null,
              row.blocked
                .slice(0, 3)
                .map((task) =>
                  line(
                    "danger",
                    "Blocked",
                    `${task.id} ${task.title.slice(0, 80)}${task.note ? ` (${task.note.slice(0, 120)})` : ""}`,
                  ),
                ),
              row.stale.length > 0 ? line("warning", "Stale claim", titles(row.stale)) : null,
            ),
          ),
      rows.length > 8
        ? h("Text", { tone: "muted" }, `${rows.length - 8} more increments moved.`)
        : null,
    );
  });
}

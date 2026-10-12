// Spec Kit's /analyze, live: checks that every acceptance criterion of an
// open SpecWeave increment is traced to a task before anyone runs closure.
// SpecWeave counts an AC as met when every task citing it is done, so an AC
// that no task cites, or one that only skipped tasks cite, slips through.
export function register(on) {
  const CLOSED = new Set(["completed", "abandoned", "archived", "cancelled", "closed"]);
  let increments = [];
  let known = null;
  // The host draws at most 8000 characters of text per pane.
  const TEXT_BUDGET = 6000;
  const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  const lint = (increment) => {
    const issues = [];
    const ids = new Set(increment.criteria.map((criterion) => criterion.id));
    // An AC list the reader cannot see would flag every citation; say so once.
    if (ids.size === 0) {
      return increment.tasks.some((task) => task.criteria.length > 0)
        ? [{ kind: "warning", text: "Tasks cite ACs, but the spec's AC list could not be read" }]
        : [];
    }
    for (const criterion of increment.criteria) {
      const covering = increment.tasks.filter((task) => task.criteria.includes(criterion.id));
      if (covering.length === 0) {
        issues.push({
          kind: "danger",
          text: `${criterion.id} has no task: ${clip(criterion.text, 120)}`,
        });
      } else if (covering.every((task) => task.status === "skipped")) {
        issues.push({ kind: "warning", text: `${criterion.id} is covered only by skipped tasks` });
      }
    }
    for (const task of increment.tasks) {
      if (task.criteria.length === 0) {
        issues.push({ kind: "warning", text: `${task.id} cites no AC: ${clip(task.title, 120)}` });
      }
      for (const id of task.criteria) {
        if (!ids.has(id))
          issues.push({
            kind: "danger",
            text: `${task.id} cites ${id}, which the spec does not define`,
          });
      }
    }
    return issues;
  };

  const findings = () =>
    increments
      .filter((increment) => increment.readable && !CLOSED.has(increment.status))
      .map((increment) => ({ increment, issues: lint(increment) }))
      .filter((entry) => entry.issues.length > 0);

  const refresh = ($) => {
    const list = findings();
    const total = list.reduce((sum, entry) => sum + entry.issues.length, 0);
    const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
    $.ui.status(
      total === 0
        ? undefined
        : `${plural(total, "trace gap")} in ${plural(list.length, "increment")}`,
    );
    // Toast only for gaps that appear after the first read.
    const keys = new Set(
      list.flatMap((entry) => entry.issues.map((issue) => `${entry.increment.id} ${issue.text}`)),
    );
    if (known !== null) {
      const fresh = [...keys].filter((key) => !known.has(key));
      if (fresh.length === 1) $.ui.toast(`New trace gap: ${fresh[0]}`);
      else if (fresh.length > 1)
        $.ui.toast(`${fresh.length} new trace gaps. Run "Show trace gaps".`);
    }
    known = keys;
  };

  on("app.start", ($, e, next) => {
    $.command.register({
      name: "trace-gaps",
      description: "Show trace gaps between ACs and tasks",
    });
    return next(e);
  });

  on("specweave.changed", ($, e, next) => {
    increments = e.increments;
    refresh($);
    return next(e);
  });

  on("command.run", { name: "trace-gaps" }, ($) => $.ui.open({ id: "gaps", title: "Trace gaps" }));

  on("ui.render", { component: "Pane", requestId: "gaps" }, () => {
    const list = findings();
    if (increments.length === 0)
      return h("Text", { tone: "muted" }, "No SpecWeave increments found in this host's projects.");
    if (list.length === 0)
      return h(
        "Text",
        { tone: "success" },
        "Every acceptance criterion of every open increment is traced to a task.",
      );
    let budget = TEXT_BUDGET;
    let hidden = 0;
    const blocks = [];
    for (const { increment, issues } of list) {
      const heading = `${increment.id} · ${increment.project}`;
      if (blocks.length >= 12 || budget < heading.length + 200) {
        hidden += issues.length;
        continue;
      }
      budget -= heading.length;
      const lines = [];
      for (const issue of issues) {
        if (lines.length >= 8 || budget < issue.text.length + 100) break;
        budget -= issue.text.length;
        lines.push(h("Text", { tone: issue.kind }, issue.text));
      }
      blocks.push(
        h(
          "Box",
          { gap: 1 },
          h("Text", { tone: "strong" }, heading),
          lines,
          issues.length > lines.length
            ? h("Text", { tone: "muted" }, `and ${issues.length - lines.length} more`)
            : null,
        ),
      );
    }
    return h(
      "Box",
      { gap: 3 },
      blocks,
      hidden > 0 ? h("Text", { tone: "muted" }, `${hidden} more gaps in other increments.`) : null,
    );
  });
}

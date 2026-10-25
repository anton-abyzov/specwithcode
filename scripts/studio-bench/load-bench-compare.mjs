#!/usr/bin/env node
// Compares two load benchmark results (apps/web/tests/load-bench/run.mjs) and prints
// a markdown table of medians: base, head, delta and the regression budget.
//
//   node scripts/studio-bench/load-bench-compare.mjs <base.json> <head.json> [--fail-on-regression]
//   node scripts/studio-bench/load-bench-compare.mjs <head.json>   (one result: medians only,
//                                                                    no regression verdict)
//
// A metric regresses when its head median is worse than base by more than 10% and by
// more than the absolute floor of its unit (50 ms, 5 KiB, 2 requests or frames), so
// small absolute wobble on tiny values never flags. Exit code is 0 unless
// --fail-on-regression is given and something regressed.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const RELATIVE = 0.1;
const FLOOR = { ms: 50, bytes: 5 * 1024, count: 2 };
const LABELS = {
  cold_connect_ms: "Cold connect",
  big_thread_open_ms: "Big thread open",
  reconnect_ms: "Reconnect",
  cold_wire_bytes: "Cold wire",
  cold_json_bytes: "Cold JSON parsed",
  cold_wire_ws_bytes: "Cold WebSocket wire",
  cold_asset_bytes: "Cold assets (decoded)",
  open_wire_bytes: "Open wire",
  open_json_bytes: "Open JSON parsed",
  reconnect_wire_bytes: "Reconnect wire",
  reconnect_json_bytes: "Reconnect JSON parsed",
  cold_http_requests: "Cold HTTP requests",
  cold_ws_frames: "Cold WebSocket frames",
  open_ws_frames: "Open WebSocket frames",
  reconnect_ws_frames: "Reconnect WebSocket frames",
};

function format(value, unit) {
  if (value === null || value === undefined) return "n/a";
  if (unit === "ms") return `${Math.round(value).toLocaleString("en-US")} ms`;
  if (unit === "count") return Math.round(value).toLocaleString("en-US");
  const bytes = Math.abs(value);
  if (bytes < 1024) return `${Math.round(value)} B`;
  if (bytes >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

function delta(base, head, unit) {
  if (base === null || head === null || base === undefined || head === undefined) return "n/a";
  const change = head - base;
  const sign = change > 0 ? "+" : change < 0 ? "-" : "";
  const percent = base === 0 ? "" : ` (${sign}${Math.abs((change / base) * 100).toFixed(1)}%)`;
  return `${sign}${format(Math.abs(change), unit)}${percent}`;
}

export function verdict(base, head, unit) {
  if (base === null || head === null || base === undefined || head === undefined) return "n/a";
  const change = head - base;
  const floor = FLOOR[unit] ?? 0;
  if (change > floor && change > base * RELATIVE) return "REGRESSION";
  if (-change > floor && -change > base * RELATIVE) return "better";
  return "ok";
}

const CONTEXT = [
  ["profile", (result) => result.profile],
  ["fixture", (result) => `${result.fixture?.scale} (${result.fixture?.big_thread_items} items)`],
  ["shaper", (result) => result.config?.shaper],
  ["machine", (result) => `${result.machine?.cpu} x${result.machine?.cpu_count}`],
  ["chromium", (result) => result.chromium],
  ["runs", (result) => `${result.config?.runs} (+${result.config?.warmup} warmup)`],
  ["server entry", (result) => result.config?.server_entry],
  ["seeder", (result) => result.config?.seeder],
  ["reconnect resync detected", (result) => result.reconnect_resync_detected],
];

export function compare(base, head) {
  for (const result of [base, head])
    if (result.schema !== "loadBench.v1") throw new Error(`Unsupported schema ${result.schema}`);
  const mismatches = CONTEXT.filter(([, read]) => read(base) !== read(head)).map(
    ([name, read]) => `${name}: ${read(base)} vs ${read(head)}`,
  );
  const names = [...new Set([...Object.keys(base.metrics), ...Object.keys(head.metrics)])];
  const rows = [];
  let regressions = 0;
  for (const name of names) {
    const unit = (head.metrics[name] ?? base.metrics[name]).unit;
    const before = base.metrics[name]?.median ?? null;
    const after = head.metrics[name]?.median ?? null;
    const result = verdict(before, after, unit);
    if (result === "REGRESSION") regressions += 1;
    const budget = `+${RELATIVE * 100}% and +${format(FLOOR[unit], unit)}`;
    const spread =
      unit === "ms" && head.metrics[name]?.min !== null && head.metrics[name]?.min !== undefined
        ? `${format(head.metrics[name].min, unit)} to ${format(head.metrics[name].max, unit)}`
        : "";
    rows.push(
      `| ${LABELS[name] ?? name} | ${format(before, unit)} | ${format(after, unit)} | ${delta(before, after, unit)} | ${budget} | ${result} | ${spread} |`,
    );
  }
  const title = (result) => `${result.version} \`${result.sha}\`${result.dirty ? " (dirty)" : ""}`;
  const loads = [base, head]
    .map((result) => result.load_avg_1m?.before)
    .filter((value) => typeof value === "number");
  const busy = loads.some((value) => value > (head.machine?.cpu_count ?? Infinity));
  const lines = [
    `## Load benchmark: ${title(base)} -> ${title(head)} (${head.profile})`,
    "",
    regressions > 0
      ? `**${regressions} metric(s) regressed beyond budget.**`
      : "No metric regressed beyond budget.",
    "",
    "| Metric | Base median | Head median | Delta | Budget | Result | Head range |",
    "| --- | ---: | ---: | ---: | --- | --- | --- |",
    ...rows,
    "",
    `Context: ${CONTEXT.map(([name, read]) => `${name} ${read(head)}`).join(" · ")}`,
  ];
  if (mismatches.length > 0)
    lines.push(
      "",
      `> The two runs differ, so deltas are not like for like: ${mismatches.join("; ")}.`,
    );
  if (busy)
    lines.push(
      "",
      `> The machine was overloaded (1-minute load ${loads.join(" / ")} on ${head.machine.cpu_count} cores); treat timing deltas as noise.`,
    );
  return { markdown: lines.join("\n"), regressions };
}

/** One result on its own: medians and spread, with no verdict, since nothing was compared. */
export function summarize(head) {
  if (head.schema !== "loadBench.v1") throw new Error(`Unsupported schema ${head.schema}`);
  const rows = Object.entries(head.metrics).map(
    ([name, metric]) =>
      `| ${LABELS[name] ?? name} | ${format(metric.median, metric.unit)} | ${format(metric.p90, metric.unit)} | ${format(metric.min, metric.unit)} to ${format(metric.max, metric.unit)} |`,
  );
  return [
    `## Load benchmark: ${head.version} \`${head.sha}\`${head.dirty ? " (dirty)" : ""} (${head.profile})`,
    "",
    "No base result, so there is no comparison and no regression verdict.",
    "",
    "| Metric | Median | p90 | Range |",
    "| --- | ---: | ---: | --- |",
    ...rows,
    "",
    `Context: ${CONTEXT.map(([name, read]) => `${name} ${read(head)}`).join(" · ")}`,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (files.length === 1) {
    console.log(summarize(JSON.parse(NodeFS.readFileSync(files[0], "utf8"))));
    process.exit(0);
  }
  if (files.length !== 2) {
    console.error(
      "Usage: load-bench-compare.mjs <base.json> <head.json> [--fail-on-regression] | <head.json>",
    );
    process.exit(2);
  }
  const [base, head] = files.map((file) => JSON.parse(NodeFS.readFileSync(file, "utf8")));
  const { markdown, regressions } = compare(base, head);
  console.log(markdown);
  if (args.includes("--fail-on-regression") && regressions > 0) process.exit(1);
}

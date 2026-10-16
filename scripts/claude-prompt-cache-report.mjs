#!/usr/bin/env node
// Prompt-cache report over Claude Code transcripts (~/.claude/projects).
//
//   node scripts/claude-prompt-cache-report.mjs [hours=72] [entrypoint=sdk-ts]
//
// Reads main-conversation requests only (subagent files are counted apart),
// de-duplicated by request. Costs are in base-input-token units at Anthropic's
// ratios: cache read 0.1, 5-minute write 1.25, 1-hour write 2, output 5.
// "Breaks" are requests whose cache read fell below half the previous prompt
// while the prompt did not shrink (a compaction shrinks it). The 5-minute and
// idle-compaction figures are counterfactuals replayed over the same requests.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const hours = Number(process.argv[2] ?? 72);
const entrypoint = process.argv[3] ?? "sdk-ts";
const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const cutoff = Date.now() - hours * 3_600_000;
const READ = 0.1;
const W5 = 1.25;
const W1 = 2;
const OUT = 5;
const SUMMARY_TOKENS = 5_000; // median /compact summary in recorded sessions
const IDLE_AFTER_MS = 54 * 60_000;

function requests(file, sidechain = false) {
  const seen = new Set();
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = record.message?.usage;
    const id = record.requestId ?? record.message?.id;
    if (record.type !== "assistant" || Boolean(record.isSidechain) !== sidechain) continue;
    if (!usage || seen.has(id)) continue;
    if (entrypoint !== "all" && record.entrypoint !== entrypoint) continue;
    const t = Date.parse(record.timestamp);
    if (!(t >= cutoff)) continue;
    seen.add(id);
    out.push({
      t,
      input: usage.input_tokens ?? 0,
      read: usage.cache_read_input_tokens ?? 0,
      write: usage.cache_creation_input_tokens ?? 0,
      write1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

function* transcripts(dir, depth = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) yield* transcripts(path, depth + 1);
    else if (entry.name.endsWith(".jsonl") && statSync(path).mtimeMs >= cutoff) yield path;
  }
}

const totals = { sessions: 0, requests: 0, input: 0, read: 0, write: 0, write1h: 0 };
const subagents = { requests: 0, write: 0, write1h: 0 };
const breaks = { under5m: 0, from5to60m: 0, over60m: 0, rewrittenOver60m: 0 };
let actual = 0;
let fiveMinute = 0;
let writesAt5mRate = 0;
const idle = Object.fromEntries(
  [100_000, 200_000].map((min) => [min, { fires: 0, returned: 0, saved: 0, wasted: 0 }]),
);

for (const file of transcripts(root)) {
  const isSubagent = file.includes("/subagents/");
  const reqs = requests(file, isSubagent);
  if (reqs.length === 0) continue;
  if (isSubagent) {
    for (const r of reqs) {
      subagents.requests += 1;
      subagents.write += r.write;
      subagents.write1h += r.write1h;
    }
    continue;
  }
  totals.sessions += 1;
  reqs.forEach((r, i) => {
    totals.requests += 1;
    for (const key of ["input", "read", "write", "write1h"]) totals[key] += r[key];
    actual += r.input + r.read * READ + (r.write - r.write1h) * W5 + r.write1h * W1;
    writesAt5mRate += r.input + r.read * READ + r.write * W5;
    const prev = reqs[i - 1];
    const gap = prev ? r.t - prev.t : 0;
    fiveMinute +=
      r.input + (gap >= 300_000 ? (r.read + r.write) * W5 : r.read * READ + r.write * W5);
    if (prev) {
      const before = prev.input + prev.read + prev.write;
      const now = r.input + r.read + r.write;
      if (before > 20_000 && r.read < before / 2 && now >= before / 2) {
        if (gap < 300_000) breaks.under5m += 1;
        else if (gap < 3_600_000) breaks.from5to60m += 1;
        else {
          breaks.over60m += 1;
          breaks.rewrittenOver60m += r.write;
        }
      }
    }
    const context = r.input + r.read + r.write + r.output;
    const next = reqs[i + 1];
    if ((next?.t ?? Date.now()) - r.t < IDLE_AFTER_MS) return;
    for (const [min, s] of Object.entries(idle)) {
      if (context < Number(min)) continue;
      const compact = context * READ + SUMMARY_TOKENS * OUT;
      s.fires += 1;
      if (next) {
        s.returned += 1;
        s.saved += context * W1 - compact - SUMMARY_TOKENS * W1;
      } else s.wasted += compact;
    }
  });
}

const prompt = totals.input + totals.read + totals.write;
const pct = (a, b) => `${((a / b - 1) * 100).toFixed(1)}%`;
console.log(
  JSON.stringify(
    {
      window: `${hours}h`,
      entrypoint,
      ...totals,
      cacheHitRate: prompt ? Number((totals.read / prompt).toFixed(4)) : null,
      oneHourShareOfWrites: totals.write
        ? Number((totals.write1h / totals.write).toFixed(4))
        : null,
      subagents,
      breaks,
      cost: {
        actual: Math.round(actual),
        allWritesAt5mRate: Math.round(writesAt5mRate),
        underReportedBy5mPricing: pct(actual, writesAt5mRate),
        ifCacheWere5m: Math.round(fiveMinute),
        fiveMinuteExtra: pct(fiveMinute, actual),
      },
      idleCompaction: Object.fromEntries(
        Object.entries(idle).map(([k, v]) => [
          k,
          { ...v, saved: Math.round(v.saved), wasted: Math.round(v.wasted) },
        ]),
      ),
    },
    null,
    1,
  ),
);

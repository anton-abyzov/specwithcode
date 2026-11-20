#!/usr/bin/env node
// Reports usage window notes whose vendor page was read more than maxAgeDays
// ago (packages/shared/src/subscriptionWindowRules.json). Plain Node, no
// install. Prints a Markdown body listing the old notes, or nothing when all
// are fresh; it always exits 0 unless the file cannot be read. The weekly
// workflow usage-rules-age.yml turns a non-empty body into an issue comment.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
export const ISSUE_TITLE = "Usage window notes need a re-read";

/** The rules read more than `maxAgeDays` before `now`, oldest first. */
export function staleRules(data, now) {
  const maxAgeDays = Number.isFinite(data.maxAgeDays) ? data.maxAgeDays : 90;
  return data.rules
    .map((rule) => ({ rule, ageDays: Math.floor((now - Date.parse(`${rule.readOn}T00:00:00Z`)) / DAY_MS) }))
    .filter(({ ageDays }) => !Number.isFinite(ageDays) || ageDays > maxAgeDays)
    .toSorted((left, right) => right.ageDays - left.ageDays);
}

export function staleReport(data, now) {
  const stale = staleRules(data, now);
  if (stale.length === 0) return "";
  const lines = [
    `These usage window notes were last checked against their source more than ${data.maxAgeDays ?? 90} days ago.`,
    "Read each page again, update the note if the vendor changed it, and set `readOn` in `packages/shared/src/subscriptionWindowRules.json`.",
    "",
  ];
  for (const { rule, ageDays } of stale) {
    lines.push(
      `- \`${rule.id}\` (${rule.provider}), read ${rule.readOn}, ${Number.isFinite(ageDays) ? `${ageDays} days ago` : "date unreadable"}: ${rule.source ?? "the reading itself"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL("../packages/shared/src/subscriptionWindowRules.json", import.meta.url));
  const nowArg = process.argv.find((arg) => arg.startsWith("--now="));
  const now = nowArg ? Date.parse(nowArg.slice("--now=".length)) : Date.now();
  process.stdout.write(staleReport(JSON.parse(readFileSync(file, "utf8")), now));
}

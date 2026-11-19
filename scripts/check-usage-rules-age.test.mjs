// Runs under `node --test` (the weekly workflow, with no install) and under the
// repository's Vitest run alike: both provide `it`, so the file takes whichever loads it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { staleReport, staleRules } from "./check-usage-rules-age.mjs";

const { describe, it } = process.env.VITEST
  ? await import("vite-plus/test")
  : await import("node:test");

const data = {
  maxAgeDays: 90,
  rules: [
    { id: "fresh", provider: "cursor", readOn: "2026-11-18", source: "https://cursor.com/x" },
    { id: "old", provider: "grok", readOn: "2026-08-01", source: "https://docs.x.ai/grok/faq" },
    { id: "reading", provider: "codex", readOn: "2026-07-01", source: null },
  ],
};
const now = Date.parse("2026-11-19T12:00:00Z");

describe("check-usage-rules-age", () => {
  it("lists only notes older than the limit, oldest first", () => {
    assert.deepEqual(
      staleRules(data, now).map(({ rule, ageDays }) => [rule.id, ageDays]),
      [
        ["reading", 141],
        ["old", 110],
      ],
    );
  });

  it("a note exactly at the limit is not old", () => {
    const atLimit = Date.parse("2026-10-30T12:00:00Z");
    assert.deepEqual(staleRules(data, atLimit).map(({ rule }) => rule.id), ["reading"]);
  });

  it("prints nothing when every note is fresh, and a body naming each old one otherwise", () => {
    assert.equal(staleReport(data, Date.parse("2026-11-20T00:00:00Z")).includes("`fresh`"), false);
    assert.equal(staleReport({ ...data, rules: [data.rules[0]] }, now), "");
    const body = staleReport(data, now);
    assert.match(body, /`old` \(grok\), read 2026-08-01, 110 days ago: https:\/\/docs\.x\.ai\/grok\/faq/);
    assert.match(body, /`reading` \(codex\), read 2026-07-01, 141 days ago: the reading itself/);
  });

  it("the shipped rules are fresh on the day they were read", () => {
    const shipped = JSON.parse(
      readFileSync(new URL("../packages/shared/src/subscriptionWindowRules.json", import.meta.url), "utf8"),
    );
    assert.equal(staleReport(shipped, Date.parse("2026-11-19T00:00:00Z")), "");
  });
});

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native CLI-shaped fixture files independently verify folder-session ingestion.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { nodePath as NodePath } from "../nodePath.ts";

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import {
  aggregateFolderUsage,
  claudeDirMayMatch,
  encodeClaudeProjectDir,
  firstCwdIn,
  grokSessionCwd,
  isWithinRoot,
  parseCopilotEvents,
  readCopilotFolderSessions,
  readLogCwd,
  type FolderSessionFile,
} from "./projectFolderSessions.ts";
import { parseRateTable } from "./usagePricing.ts";

const totals = (input: number, cached: number, write: number, output: number) => ({
  uncachedInputTokens: input,
  cachedInputTokens: cached,
  cacheCreationTokens: write,
  outputTokens: output,
  reasoningTokens: 0,
});

describe("folder matching", () => {
  it("treats a root and its children as inside, siblings as outside", () => {
    expect(isWithinRoot("/work/app", "/work/app")).toBe(true);
    expect(isWithinRoot("/work/app/web/", "/work/app")).toBe(true);
    expect(isWithinRoot("/work/app-old", "/work/app")).toBe(false);
    expect(isWithinRoot("/work", "/work/app")).toBe(false);
  });

  it("encodes Claude Code session folders and gates children and look-alikes", () => {
    expect(encodeClaudeProjectDir("/Users/a/Projects/acme-app")).toBe(
      "-Users-a-Projects-acme-app",
    );
    const roots = ["/Users/a/Projects/acme-app"];
    expect(claudeDirMayMatch("-Users-a-Projects-acme-app", roots)).toBe(true);
    expect(claudeDirMayMatch("-Users-a-Projects-acme-app-web-ui", roots)).toBe(true);
    expect(claudeDirMayMatch("-Users-a-Projects-acme-app2", roots)).toBe(false);
    expect(claudeDirMayMatch("-Users-a-Projects-other", roots)).toBe(false);
  });

  it("decodes Grok's url-encoded session folder", () => {
    expect(
      grokSessionCwd(
        "/h/.grok/sessions/%2FUsers%2Fa%2Fapp/019e/updates.jsonl",
        "/h/.grok/sessions",
      ),
    ).toBe("/Users/a/app");
    expect(grokSessionCwd("/h/.grok/sessions/prompt.jsonl", "/h/.grok/sessions")).toBe(null);
  });

  it("reads the first cwd even when the line is cut short", () => {
    const head =
      '{"type":"session_meta","payload":{"id":"s1","cwd":"/Users/a/app \\"x\\"","base_instructions":"' +
      "x".repeat(200);
    expect(firstCwdIn(head)).toBe('/Users/a/app "x"');
    expect(firstCwdIn('{"cwd":"relative/path"}')).toBe(null);
    expect(firstCwdIn("{}")).toBe(null);
  });
});

describe("Copilot logs", () => {
  const events = [
    {
      type: "session.start",
      data: { sessionId: "c1", context: { cwd: "/work/app" } },
      id: "e0",
      timestamp: "2026-10-10T18:09:55.585Z",
    },
    {
      type: "session.usage_record",
      data: {
        usage: {
          model: "gpt-6-luna",
          inputTokens: 16132,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 16129,
          reasoningTokens: 0,
          cost: 1,
        },
      },
      id: "e1",
      timestamp: "2026-10-10T18:09:58.000Z",
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");

  it("reads cwd and per-request usage, input including cache", () => {
    const parsed = parseCopilotEvents(events);
    expect(parsed.cwd).toBe("/work/app");
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.totals).toEqual(totals(3, 0, 16129, 5));
    expect(parsed.records[0]?.sessionId).toBe("c1");
    expect(parsed.records[0]?.reportedCostUsd).toBe(null);
  });

  let dir = "";
  beforeAll(async () => {
    dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "copilot-folder-"));
    await NodeFSP.mkdir(NodePath.join(dir, "c1"));
    await NodeFSP.writeFile(NodePath.join(dir, "c1", "events.jsonl"), events);
    await NodeFSP.mkdir(NodePath.join(dir, "c2"));
    await NodeFSP.writeFile(
      NodePath.join(dir, "c2", "events.jsonl"),
      events.replace("/work/app", "/elsewhere"),
    );
  });
  afterAll(async () => {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  });

  it("keeps only sessions started in the project", async () => {
    const files = await readCopilotFolderSessions(
      dir,
      (cwd) => cwd !== null && isWithinRoot(cwd, "/work/app"),
      0,
    );
    expect(files.map((file) => NodePath.basename(NodePath.dirname(file.path)))).toEqual(["c1"]);
    expect(await readLogCwd(NodePath.join(dir, "c1", "events.jsonl"))).toBe("/work/app");
  });
});

describe("aggregateFolderUsage", () => {
  const record = (sessionId: string, dedupeKey: string | null, model = "fixture-model") => ({
    timestampMs: Date.parse("2026-10-09T10:00:00Z"),
    model,
    sessionId,
    totals: totals(10, 60, 30, 20),
    reportedCostUsd: null,
    speed: "standard" as const,
    dedupeKey,
  });
  const rates = parseRateTable({
    "fixture-model": {
      input_cost_per_token: 1,
      output_cost_per_token: 5,
      cache_read_input_token_cost: 0.1,
      cache_creation_input_token_cost: 2,
    },
  });

  it("dedupes repeated records, skips Studio-owned sessions and groups by provider", () => {
    const files: FolderSessionFile[] = [
      { provider: "claude", path: "/a.jsonl", records: [record("s1", "k1"), record("s1", "k1")] },
      {
        provider: "claude",
        path: "/b.jsonl",
        records: [record("s1", "k1"), record("owned", "k2")],
      },
      { provider: "codex", path: "/c.jsonl", records: [record("s2", null, "unknown-model")] },
    ];
    const result = aggregateFolderUsage({
      hostLabel: "m4",
      windowDays: 90,
      roots: ["/work/app"],
      files,
      studioSessionIds: new Set(["owned"]),
      rates,
    });
    expect(result.sessions).toBe(2);
    expect(result.studioOwnedSessions).toBe(1);
    expect(result.totals.totalTokens).toBe(240);
    expect(result.totals.inputTokens).toBe(200);
    expect(result.totals.cachedInputTokens).toBe(120);
    expect(result.providers.map((row) => [row.provider, row.sessions])).toEqual([
      ["claude", 1],
      ["codex", 1],
    ]);
    // 10*1 + 60*0.1 + 30*2 + 20*5 = 176 for the priced record; the unknown model adds nothing.
    expect(result.totals.equivalentCostUsd).toBeCloseTo(176);
    expect(result.providers[1]?.totals.equivalentCostUsd).toBe(null);
    expect(result.providers[0]?.lastActiveAt).toBe("2026-10-09T10:00:00.000Z");
  });

  it("leaves out Claude Code's zero-token synthetic messages", () => {
    const synthetic = { ...record("s3", "k9", "<synthetic>"), totals: totals(0, 0, 0, 0) };
    const result = aggregateFolderUsage({
      hostLabel: "m4",
      windowDays: 90,
      roots: ["/work/app"],
      files: [{ provider: "claude", path: "/d.jsonl", records: [record("s1", "k1"), synthetic] }],
      studioSessionIds: new Set(),
      rates,
    });
    expect(result.models.map((row) => row.model)).toEqual(["fixture-model"]);
    expect(result.sessions).toBe(1);
  });

  it("reports nothing for an empty folder", () => {
    const result = aggregateFolderUsage({
      hostLabel: "m4",
      windowDays: 90,
      roots: ["/work/app"],
      files: [],
      studioSessionIds: new Set(),
    });
    expect(result.sessions).toBe(0);
    expect(result.totals.totalTokens).toBe(0);
    expect(result.providers).toEqual([]);
  });
});

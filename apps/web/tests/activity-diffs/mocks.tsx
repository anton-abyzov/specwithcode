/* Synthetic threads, a fake RPC server and the store stand-ins vite.config.ts routes here. */
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CheckpointId,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import {
  formatStructuredPatch,
  structuredEditResultPatch,
} from "@specweave-studio/shared/structuredPatch";
import * as DateTime from "effect/DateTime";

// The server's own wire and detail projection and Codex patch conversion run in the page.
// The projection measures strings with Node's Buffer; this is the part of it that it uses.
class FixtureBuffer {
  constructor(private readonly bytes: Uint8Array) {}
  static byteLength(value: string) {
    return new TextEncoder().encode(value).length;
  }
  static from(value: string) {
    return new FixtureBuffer(new TextEncoder().encode(value));
  }
  subarray(start: number, end: number) {
    return new FixtureBuffer(this.bytes.subarray(start, end));
  }
  toString() {
    return new TextDecoder().decode(this.bytes);
  }
}
(globalThis as any).Buffer ??= FixtureBuffer;
const { projectTurnItemForDetail, projectTurnItemForWire } =
  await import("../../../server/src/orchestration-v2/WireProjection");
const { projectCodexFileChanges } =
  await import("../../../server/src/orchestration-v2/Adapters/codexFileChanges");

declare global {
  interface Window {
    __fixture: Record<string, any>;
  }
}
window.__fixture ??= {};
const record = (key: string, value: unknown) => {
  (window.__fixture[key] ??= []).push(value);
};

export const HOST = EnvironmentId.make("fixture-host");
export const OTHER_HOST = EnvironmentId.make("mini-2");
const MACHINE_NAMES: Record<string, string> = {
  [HOST]: "MacBook M4",
  [OTHER_HOST]: "Mac mini 2",
};
export const REPO = "/Users/anton/Projects/atlas";
const MOVED_WORKTREE = "/Users/anton/.worktrees/atlas-flush";
const BRANCH = "feat/stream-flush";
const HEAD = "4f1c2e9a7b3d5e8f9a0b1c2d3e4f5a6b7c8d9e0f";
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claudeAgent");

const provider = (
  instanceId: ProviderInstanceId,
  driver: string,
  displayName: string,
  model: { slug: string; name: string; shortName: string },
) => ({
  instanceId,
  driver,
  displayName,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: new Date().toISOString(),
  models: [{ ...model, isCustom: false, isDefault: true, capabilities: null }],
  slashCommands: [],
  skills: [],
});
export const providerStatuses = [
  provider(CODEX, "codex", "Codex", { slug: "gpt-5.5", name: "GPT-5.5", shortName: "GPT-5.5" }),
  provider(CLAUDE, "claudeAgent", "Claude", {
    slug: "opus-5",
    name: "Opus 5",
    shortName: "Opus 5",
  }),
] as never[];

// Times are relative to page load, so a live turn reads "Working for 1m", not hours.
const T0 = Date.now() - 50 * 60_000;
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const utc = (seconds: number) => DateTime.makeUnsafe(iso(seconds));

/** Every stored item, whole, by thread and item id: what getTurnItem reads from. */
const storedItems = new Map<string, OrchestrationV2TurnItem>();
/** The full text a check compares Copy full against, by item id and field. */
export const sources: Record<string, string> = {};

type RunStatus = "running" | "completed" | "interrupted" | "failed";
type FileSummary = { path: string; kind: string; additions: number; deletions: number };
type TurnDiff = {
  readonly diff?: string;
  readonly whitespaceDiff?: string;
  readonly truncated?: boolean;
  readonly error?: string;
};

export interface FixtureThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly worktreePath: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly rows: OrchestrationV2ProjectedTurnItem[];
  readonly runs: Array<{
    id: RunId;
    ordinal: number;
    status: RunStatus;
    providerInstanceId: ProviderInstanceId;
    modelSelection: { instanceId: ProviderInstanceId; model: string };
    startedAt: string;
    completedAt: string | null;
  }>;
  readonly checkpoints: any[];
  readonly messages: Array<{ id: MessageId; runId: RunId | null; role: "assistant" | "user" }>;
  readonly subagents: OrchestrationV2Subagent[];
  readonly turnDiffs: Map<number, TurnDiff>;
  /** Runs left out of the projection: their rows name a run nothing recorded. */
  readonly unrecordedRunIds: Set<RunId>;
}

class ThreadBuilder {
  readonly thread: FixtureThread;
  private seconds: number;
  private run: FixtureThread["runs"][number] | null = null;
  private ordinal = 0;

  constructor(id: string, title: string, startMinute: number, worktreePath = REPO) {
    this.seconds = startMinute * 60;
    this.thread = {
      id: ThreadId.make(id),
      title,
      worktreePath,
      providerInstanceId: CLAUDE,
      rows: [],
      runs: [],
      checkpoints: [],
      messages: [],
      subagents: [],
      turnDiffs: new Map(),
      unrecordedRunIds: new Set(),
    };
  }

  startRun(provider: ProviderInstanceId, status: RunStatus = "completed", recorded = true) {
    const ordinal = this.nextRunOrdinal();
    const run = {
      id: RunId.make(`${this.thread.id}:run-${ordinal}`),
      ordinal,
      status,
      providerInstanceId: provider,
      modelSelection: { instanceId: provider, model: provider === CODEX ? "gpt-5.5" : "opus-5" },
      startedAt: iso(this.seconds),
      completedAt: null as string | null,
    };
    this.run = run;
    if (recorded) this.thread.runs.push(run);
    else this.thread.unrecordedRunIds.add(run.id);
    return run;
  }

  endRun() {
    if (this.run && this.run.status !== "running") this.run.completedAt = iso(this.seconds);
    this.seconds += 40;
    return this.run!;
  }

  item<T extends Record<string, unknown>>(
    fields: T & { type: OrchestrationV2TurnItem["type"]; status?: string },
    options: { runless?: boolean; seconds?: number } = {},
  ): OrchestrationV2TurnItem {
    this.seconds += options.seconds ?? 7;
    const id = TurnItemId.make(`${this.thread.id}:item-${this.ordinal}`);
    const status = fields.status ?? "completed";
    const live = status === "running" || status === "pending";
    const item = {
      id,
      threadId: this.thread.id,
      runId: options.runless ? null : (this.run?.id ?? null),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: this.ordinal++,
      title: null,
      startedAt: utc(this.seconds - 3),
      completedAt: live ? null : utc(this.seconds),
      updatedAt: utc(this.seconds),
      ...fields,
      status,
    } as unknown as OrchestrationV2TurnItem;
    storedItems.set(`${this.thread.id}:${id}`, item);
    this.thread.rows.push({
      position: this.thread.rows.length,
      visibility: "local",
      sourceThreadId: this.thread.id,
      sourceItemId: id,
      item: projectTurnItemForWire(item),
    });
    return item;
  }

  /** The prompt that starts the next run; it belongs to that run, as the server records it. */
  user(text: string) {
    const messageId = MessageId.make(`${this.thread.id}:user-${this.ordinal}`);
    const item = this.item(
      {
        type: "user_message",
        messageId,
        text,
        inputIntent: "turn_start",
        attachments: [],
        createdBy: { kind: "user" },
        creationSource: "composer",
      },
      { runless: true, seconds: 20 },
    );
    const nextRun = RunId.make(`${this.thread.id}:run-${this.nextRunOrdinal()}`);
    this.restamp(item, { runId: nextRun });
  }

  private nextRunOrdinal() {
    return this.thread.runs.length + this.thread.unrecordedRunIds.size + 1;
  }

  /** Changes a stored item and its wire row together. */
  private restamp(item: OrchestrationV2TurnItem, fields: Record<string, unknown>) {
    const updated = { ...item, ...fields } as OrchestrationV2TurnItem;
    storedItems.set(`${this.thread.id}:${item.id}`, updated);
    const row = this.thread.rows.find((candidate) => candidate.sourceItemId === item.id)!;
    (row as { item: unknown }).item = projectTurnItemForWire(updated);
  }

  /** Moves the clock to `minutesAgo` before page load; later items follow from there. */
  at(minutesAgo: number) {
    this.seconds = Math.max(this.seconds, (Date.now() - minutesAgo * 60_000 - T0) / 1000);
  }

  assistant(text: string, options: { runless?: boolean } = {}) {
    const messageId = MessageId.make(`${this.thread.id}:assistant-${this.ordinal}`);
    this.item({ type: "assistant_message", messageId, text, streaming: false }, options);
    this.thread.messages.push({
      id: messageId,
      runId: options.runless ? null : (this.run?.id ?? null),
      role: "assistant",
    });
  }

  thought(text: string, status = "completed") {
    this.item({ type: "reasoning", text, streaming: status === "running", status });
  }

  command(
    input: string,
    output: string | undefined,
    extra: Record<string, unknown> = {},
    options: { runless?: boolean } = {},
  ) {
    return this.item(
      {
        type: "command_execution",
        input,
        ...(output === undefined ? {} : { output }),
        ...extra,
      },
      options,
    );
  }

  read(path: string, output: string, options: { runless?: boolean } = {}) {
    return this.item(
      { type: "dynamic_tool", toolName: "Read", input: { file_path: path }, output },
      options,
    );
  }

  edit(fields: Record<string, unknown>, options: { runless?: boolean } = {}) {
    return this.item({ type: "file_change", ...fields } as never, options);
  }

  /** A Claude Edit result: hunks first, as the adapter converts it. */
  claudeEdit(
    path: string,
    hunks: ReadonlyArray<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
    }>,
    options: { runless?: boolean; status?: string } = {},
  ) {
    const converted = structuredEditResultPatch({ filePath: path, structuredPatch: hunks }, path);
    return this.edit(
      {
        fileName: path,
        status: options.status ?? "completed",
        ...(converted?.patch ? { diffStr: converted.patch } : {}),
      },
      options,
    );
  }

  checkpoint(
    files: FileSummary[],
    stamp: Record<string, unknown> | null = {},
    status = "ready",
    diff?: TurnDiff,
  ) {
    const run = this.run!;
    const ordinal = run.ordinal;
    this.thread.checkpoints.push({
      id: CheckpointId.make(`${run.id}:checkpoint`),
      threadId: this.thread.id,
      scopeId: CheckpointScopeId.make(`${this.thread.id}:scope`),
      runId: run.id,
      nodeId: NodeId.make(`${run.id}:root`),
      parentCheckpointId: null,
      ordinalWithinScope: ordinal,
      appRunOrdinal: ordinal,
      ref: `refs/specweave-studio/checkpoints/${this.thread.id}/${ordinal}`,
      status,
      files,
      capturedAt: utc(this.seconds + 2),
      ...(stamp === null
        ? {}
        : {
            cwd: this.thread.worktreePath,
            repoRoot: this.thread.worktreePath,
            branch: BRANCH,
            headOid: HEAD,
            capturedOnEnvironmentId: HOST,
            ...stamp,
          }),
    });
    if (diff) this.thread.turnDiffs.set(ordinal, diff);
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const rel = (path: string) => path.slice(REPO.length + 1);
const file = (path: string, additions: number, deletions: number, kind = "modified") => ({
  path,
  kind,
  additions,
  deletions,
});
/** Joins per-file patches the way the turn diff returns them. */
const joinPatches = (...patches: string[]) =>
  patches.map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`)).join("");
const gitPatch = (
  oldPath: string | null,
  newPath: string | null,
  hunks: Parameters<typeof formatStructuredPatch>[0]["hunks"],
) => formatStructuredPatch({ oldPath, newPath, hunks });

const STREAMING = `${REPO}/packages/core/src/chat/streaming.ts`;
const DOCS = `${REPO}/docs/streaming.md`;
const POLICY_OLD = `${REPO}/packages/core/src/chat/flushPolicy.ts`;
const POLICY = `${REPO}/packages/core/src/chat/policy/flushPolicy.ts`;
const LEGACY = `${REPO}/packages/core/src/chat/legacyFlush.ts`;
const WRITER = `${REPO}/packages/client-runtime/src/stream/bufferedWriter.ts`;
const TRACE_JSON = `${REPO}/packages/core/src/chat/__fixtures__/flush-trace.json`;
const LOCKFILE = `${REPO}/pnpm-lock.yaml`;
export const LONG_PATH = `${REPO}/apps/web/src/components/chat/streaming/indicators/StreamingFlushIntervalIndicatorWithBackpressureHint.tsx`;
const TIMER = `${REPO}/packages/core/src/chat/flushTimer.ts`;

const streamingSource = Array.from(
  { length: 40 },
  (_, index) =>
    `${String(index + 1).padStart(6)}→${
      [
        'import { FlushPolicy } from "./flushPolicy";',
        "",
        "export const FLUSH_INTERVAL_MS = 16;",
        "export const MAX_BUFFERED_CHUNKS = 64;",
      ][index] ?? `  // stream step ${index + 1}: buffer, measure, flush when the interval ends`
    }`,
).join("\n");

/** ASCII trace lines of exactly `bytes` bytes, some with ANSI color, ending in a newline. */
function traceBlock(bytes: number, startChunk: number, colored: boolean): string {
  const lines: string[] = [];
  let length = 0;
  for (let chunk = startChunk; ; chunk += 1) {
    const flushed = chunk % 7 === 0;
    const status = colored && flushed ? "\u001b[32mflushed\u001b[0m" : flushed ? "flushed" : "held";
    const line = `2026-10-24T14:02:${String(chunk % 60).padStart(2, "0")}.${String(chunk % 1000).padStart(3, "0")}Z chunk=${chunk} bytes=${3600 + (chunk % 211)} buffered=${chunk % 64} ${status}\n`;
    if (length + line.length > bytes) {
      const rest = bytes - length;
      if (rest > 0) lines.push(`${"#".repeat(rest - 1)}\n`);
      break;
    }
    lines.push(line);
    length += line.length;
  }
  return lines.join("");
}

// 256 KiB pages: an emoji sits where a byte cut would split the first page from the next
// and the last page from the one before it, and the middle has multibyte text and ANSI.
const PAGE = 256 * 1024;
const TRACE_LOG =
  traceBlock(PAGE - 2, 1, false) +
  "🚀 flush window opened\n" +
  Array.from(
    { length: 160 },
    (_, index) =>
      `\u001b[33mwarn\u001b[0m chunk=${index} écrit 漢字 buffered=${index % 64} — backpressure\n`,
  ).join("") +
  "🌊" +
  traceBlock(PAGE - 2, 5000, true);

/** A ranged hunk of `lines` changed JSON lines: over one page, under the inline line cap. */
function largeJsonPatchBody(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => {
    const value = `{ "chunk": ${index}, "bytes": ${3600 + (index % 211)}, "reason": "interval", "flushAfterMs": `;
    return index % 2 === 0 ? `-  ${value}16 },` : `+  ${value}32 },`;
  });
  const removed = body.filter((line) => line.startsWith("-")).length;
  const added = body.length - removed;
  return `@@ -1,${removed} +1,${added} @@\n${body.join("\n")}\n`;
}

function lockfilePatchBody(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) =>
    index % 2 === 0
      ? `-  /stream-tools@${index}.0.0: resolution: {integrity: sha512-${"a".repeat(8)}}`
      : `+  /stream-tools@${index}.1.0: resolution: {integrity: sha512-${"b".repeat(8)}}`,
  );
  return `@@ -1,${lines / 2} +1,${lines / 2} @@\n${body.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Thread: activity (three turns, a subagent, every row kind)
// ---------------------------------------------------------------------------

const activity = new ThreadBuilder("thread-activity", "Tune the stream flush interval", 0);

// Turn 1: read-only. Its checkpoint lists no files, so it has no card.
activity.user("Where does the stream flush its buffer?");
activity.startRun(CLAUDE);
activity.read(STREAMING, streamingSource);
activity.command(
  'rg -n "FLUSH_INTERVAL_MS" packages docs',
  "packages/core/src/chat/streaming.ts:3:export const FLUSH_INTERVAL_MS = 16;\ndocs/streaming.md:12:Chunks flush every FLUSH_INTERVAL_MS (16 ms).",
  { exitCode: 0 },
);
activity.assistant(
  "The buffer flushes in `packages/core/src/chat/streaming.ts` every `FLUSH_INTERVAL_MS` (16 ms); nothing else reads the value.",
);
activity.checkpoint([], {});
activity.endRun();

// Turn 2: Codex edits three files in one item (headed patches), a shell edit, failures.
const nativeCodexChanges = [
  {
    path: STREAMING,
    kind: { type: "update" },
    diff: "@@\n-export const FLUSH_INTERVAL_MS = 16;\n+export const FLUSH_INTERVAL_MS = 32;\n",
  },
  {
    path: DOCS,
    kind: { type: "add" },
    diff: "# Streaming\n\nChunks flush every `FLUSH_INTERVAL_MS` (32 ms), or sooner when the buffer holds `MAX_BUFFERED_CHUNKS` chunks.\n",
  },
  {
    path: POLICY_OLD,
    kind: { type: "update", move_path: POLICY },
    diff: '@@\n-import { FLUSH_INTERVAL_MS } from "./streaming";\n+import { FLUSH_INTERVAL_MS } from "../streaming";\n',
  },
  {
    path: LEGACY,
    kind: { type: "delete" },
    diff: "export const legacyFlush = () => {};\n",
  },
];
const codexEdit = projectCodexFileChanges(nativeCodexChanges as never)!;
activity.user("Raise the flush interval to 32 ms, keep the docs in step and run the tests.");
const turn2 = activity.startRun(CODEX);
activity.thought("The interval and the docs move together; the policy belongs in its own folder.");
export const codexEditItem = activity.edit({ ...codexEdit });
activity.command(
  `sed -i '' 's/MAX_BUFFERED_CHUNKS = 64/MAX_BUFFERED_CHUNKS = 128/' ${rel(WRITER)}`,
  "",
  { exitCode: 0 },
);
const largePatch = projectCodexFileChanges([
  { path: TRACE_JSON, kind: { type: "update" }, diff: largeJsonPatchBody(4_000) },
] as never)!;
export const largePatchItem = activity.edit({ ...largePatch });
sources.largePatch = largePatch.changes![0]!.diffStr!;
const lockPatch = projectCodexFileChanges([
  { path: LOCKFILE, kind: { type: "update" }, diff: lockfilePatchBody(6_000) },
] as never)!;
activity.edit({ ...lockPatch });
export const failedCommand = activity.command(
  "pnpm test --filter @atlas/core streaming",
  "FAIL packages/core/test/streaming.test.ts > flushes on the interval\nExpected FLUSH_INTERVAL_MS to be 16, received 32\n\nTest Files  1 failed (1)\n     Tests  1 failed | 41 passed (42)",
  { exitCode: 1, status: "failed" },
);
activity.command('rg -n "legacyFlush" packages docs', "No files found");
activity.command("git push --force-with-lease origin feat/stream-flush", undefined, {
  status: "cancelled",
  declined: true,
});
activity.assistant(
  "Raised the interval to 32 ms, moved the policy into `policy/` and documented it. One test still expects 16 ms.",
);
activity.checkpoint(
  [
    file(rel(STREAMING), 1, 1),
    file(rel(DOCS), 3, 0, "added"),
    file(rel(POLICY), 1, 1, "renamed"),
    file(rel(LEGACY), 0, 1, "deleted"),
    file(rel(WRITER), 1, 1),
    file(rel(TRACE_JSON), 2_000, 2_000),
    file(rel(LOCKFILE), 3_000, 3_000),
  ],
  {},
  "ready",
  {
    diff: joinPatches(
      gitPatch(rel(STREAMING), rel(STREAMING), [
        {
          oldStart: 1,
          oldLines: 4,
          newStart: 1,
          newLines: 4,
          lines: [
            ' import { FlushPolicy } from "./flushPolicy";',
            " ",
            "-export const FLUSH_INTERVAL_MS = 16;",
            "+export const FLUSH_INTERVAL_MS = 32;",
            " export const MAX_BUFFERED_CHUNKS = 64;",
          ],
        },
      ]),
      gitPatch(null, rel(DOCS), [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          lines: [
            "+# Streaming",
            "+",
            "+Chunks flush every `FLUSH_INTERVAL_MS` (32 ms), or sooner when the buffer holds `MAX_BUFFERED_CHUNKS` chunks.",
          ],
        },
      ]),
      gitPatch(rel(POLICY_OLD), rel(POLICY), [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            '-import { FLUSH_INTERVAL_MS } from "./streaming";',
            '+import { FLUSH_INTERVAL_MS } from "../streaming";',
            " export const defaultPolicy = { intervalMs: FLUSH_INTERVAL_MS };",
          ],
        },
      ]),
      gitPatch(rel(LEGACY), null, [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          lines: ["-export const legacyFlush = () => {};"],
        },
      ]),
      gitPatch(rel(WRITER), rel(WRITER), [
        {
          oldStart: 8,
          oldLines: 3,
          newStart: 8,
          newLines: 3,
          lines: [
            " // Chunks wait here until the policy flushes them.",
            "-export const MAX_BUFFERED_CHUNKS = 64;",
            "+export const MAX_BUFFERED_CHUNKS = 128;",
            " export class BufferedWriter {",
          ],
        },
      ]),
      `diff --git a/${rel(TRACE_JSON)} b/${rel(TRACE_JSON)}\n--- a/${rel(TRACE_JSON)}\n+++ b/${rel(TRACE_JSON)}\n${largeJsonPatchBody(4_000)}`,
      `diff --git a/${rel(LOCKFILE)} b/${rel(LOCKFILE)}\n--- a/${rel(LOCKFILE)}\n+++ b/${rel(LOCKFILE)}\n${lockfilePatchBody(6_000)}`,
    ),
  },
);
activity.endRun();

// Turn 3: Claude, stopped. Structured hunks on a long path, large paged output, a subagent.
activity.user("Show the flush trace, then make the indicator respect the new interval.");
const turn3 = activity.startRun(CLAUDE, "interrupted");
export const traceCommand = activity.command("cat logs/stream-trace.log", TRACE_LOG, {
  exitCode: 0,
});
sources.traceLog = TRACE_LOG;
export const claudeEditItem = activity.claudeEdit(LONG_PATH, [
  {
    oldStart: 12,
    oldLines: 4,
    newStart: 12,
    newLines: 5,
    lines: [
      " export function FlushIndicator({ intervalMs }: Props) {",
      "-  const label = `every ${16} ms`;",
      "+  const label = `every ${intervalMs} ms`;",
      "+  const late = intervalMs > FLUSH_INTERVAL_MS;",
      "   return <span title={label}>{label}</span>;",
      " }",
    ],
  },
]);
const SUBAGENT_TITLE = "Explore the flush timer";
const subagentNode = NodeId.make("thread-activity:subagent-node");
activity.item({
  type: "subagent",
  subagentId: subagentNode,
  origin: "provider_native",
  driver: "claudeAgent",
  providerInstanceId: CLAUDE,
  childThreadId: ThreadId.make("thread-flush-timer"),
  prompt: "Explore the flush timer and make it read FLUSH_INTERVAL_MS.",
  title: SUBAGENT_TITLE,
  result: "Moved the timer onto FLUSH_INTERVAL_MS.",
});
activity.assistant("The trace shows chunks held for 16 ms. Updating the indicator now.");
activity.command("pnpm dev --filter web", "  VITE v7.1.4  ready in 412 ms\n", {
  status: "interrupted",
});
activity.checkpoint([file(rel(LONG_PATH), 2, 1), file(rel(TIMER), 1, 1)], {}, "ready", {
  diff: joinPatches(
    gitPatch(rel(LONG_PATH), rel(LONG_PATH), [
      {
        oldStart: 12,
        oldLines: 4,
        newStart: 12,
        newLines: 5,
        lines: [
          " export function FlushIndicator({ intervalMs }: Props) {",
          "-  const label = `every ${16} ms`;",
          "+  const label = `every ${intervalMs} ms`;",
          "+  const late = intervalMs > FLUSH_INTERVAL_MS;",
          "   return <span title={label}>{label}</span>;",
          " }",
        ],
      },
    ]),
    gitPatch(rel(TIMER), rel(TIMER), [
      {
        oldStart: 4,
        oldLines: 2,
        newStart: 4,
        newLines: 2,
        lines: ["-const TICK_MS = 16;", "+const TICK_MS = FLUSH_INTERVAL_MS;", " export {};"],
      },
    ]),
  ),
});
activity.endRun();
activity.thread.subagents.push({
  id: subagentNode,
  threadId: activity.thread.id,
  runId: turn3.id,
  parentNodeId: NodeId.make(`${turn3.id}:root`),
  origin: "provider_native",
  createdBy: { kind: "provider" },
  driver: "claudeAgent",
  providerInstanceId: CLAUDE,
  providerThreadId: null,
  childThreadId: ThreadId.make("thread-flush-timer"),
  nativeTaskRef: null,
  prompt: "Explore the flush timer and make it read FLUSH_INTERVAL_MS.",
  title: SUBAGENT_TITLE,
  model: "opus-5",
  status: "completed",
  result: "Moved the timer onto FLUSH_INTERVAL_MS.",
  startedAt: utc(1800),
  completedAt: utc(1860),
  updatedAt: utc(1860),
} as never);

// ---------------------------------------------------------------------------
// Thread: the provider-native subagent's own thread (runless rows)
// ---------------------------------------------------------------------------

const subagent = new ThreadBuilder("thread-flush-timer", SUBAGENT_TITLE, 29);
subagent.assistant("Reading the flush timer.", { runless: true });
subagent.read(TIMER, "     1→export {};\n     4→const TICK_MS = 16;", { runless: true });
export const subagentEditItem = subagent.claudeEdit(
  TIMER,
  [
    {
      oldStart: 4,
      oldLines: 2,
      newStart: 4,
      newLines: 2,
      lines: ["-const TICK_MS = 16;", "+const TICK_MS = FLUSH_INTERVAL_MS;", " export {};"],
    },
  ],
  { runless: true },
);
subagent.assistant("Moved the timer onto `FLUSH_INTERVAL_MS`.", { runless: true });

// ---------------------------------------------------------------------------
// Thread: a fork whose first turns are inherited from the activity thread
// ---------------------------------------------------------------------------

const fork = new ThreadBuilder("thread-fork", "Try a longer flush interval", 40);
for (const row of activity.thread.rows) {
  if (row.item.runId !== null && row.item.runId !== turn2.id) continue;
  if (row.item.runId === null && row.position > 8) continue;
  fork.thread.rows.push({ ...row, position: fork.thread.rows.length, visibility: "inherited" });
}
fork.user("Try 48 ms instead and compare.");
fork.startRun(CODEX);
fork.edit({
  ...projectCodexFileChanges([
    {
      path: STREAMING,
      kind: { type: "update" },
      diff: "@@\n-export const FLUSH_INTERVAL_MS = 32;\n+export const FLUSH_INTERVAL_MS = 48;\n",
    },
  ] as never)!,
});
fork.assistant("At 48 ms the trace holds 3 chunks more per flush.");
fork.checkpoint([file(rel(STREAMING), 1, 1)], {}, "ready", {
  diff: gitPatch(rel(STREAMING), rel(STREAMING), [
    {
      oldStart: 3,
      oldLines: 1,
      newStart: 3,
      newLines: 1,
      lines: ["-export const FLUSH_INTERVAL_MS = 32;", "+export const FLUSH_INTERVAL_MS = 48;"],
    },
  ]),
});
fork.endRun();

// ---------------------------------------------------------------------------
// Thread: one turn per diff state (AC-05), the last one still running
// ---------------------------------------------------------------------------

const states = new ThreadBuilder("thread-states", "Diff states", 10);
const statePath = (name: string, root = REPO) => `${root}/src/states/${name}.ts`;
const stateEdit = (name: string, status = "completed", root = REPO) =>
  states.claudeEdit(
    statePath(name, root),
    [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [`-// ${name}`, `+// ${name}, done`],
      },
    ],
    { status },
  );
const statePatch = (name: string) =>
  gitPatch(`src/states/${name}.ts`, `src/states/${name}.ts`, [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [`-// ${name}`, `+// ${name}, done`],
    },
  ]);
export const stateRuns: Record<string, RunId> = {};
function stateTurn(
  name: string,
  setup: (run: ReturnType<ThreadBuilder["startRun"]>) => void,
  runStatus: RunStatus = "completed",
  recorded = true,
  root = REPO,
) {
  if (runStatus === "running") states.at(1.5);
  states.user(`State: ${name}`);
  const run = states.startRun(CLAUDE, runStatus, recorded);
  stateRuns[name] = run.id;
  stateEdit(name, "completed", root);
  setup(run);
  if (runStatus !== "running") states.assistant(`Recorded the ${name} turn.`);
  states.endRun();
}
stateTurn("snapshot-error", () => states.checkpoint([], {}, "error"));
stateTurn("snapshot-missing", () => states.checkpoint([], {}, "missing"));
stateTurn("snapshot-stale", () => states.checkpoint([], {}, "stale"));
stateTurn("not-git", () => states.checkpoint([], { notGitRepository: true }, "missing"));
stateTurn("unrecorded-run", () => {}, "completed", false);
stateTurn("other-machine", () =>
  states.checkpoint(
    [file("src/states/other-machine.ts", 1, 1)],
    { capturedOnEnvironmentId: OTHER_HOST },
    "ready",
    {
      error: "Checkpoint refs/specweave-studio/checkpoints/thread-states/6 is not on this machine.",
    },
  ),
);
stateTurn("failed-turn", () => {}, "failed");
stateTurn("after-failed", () =>
  states.checkpoint(
    [file("src/states/after-failed.ts", 1, 1), file("src/states/failed-turn.ts", 1, 1)],
    {},
    "ready",
    {
      diff: joinPatches(statePatch("after-failed"), statePatch("failed-turn")),
    },
  ),
);
export const OUTSIDE_PATH = "/tmp/atlas-notes/outside.md";
stateTurn("missing-paths", () => {
  states.claudeEdit(statePath("whitespace-only"), [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-const a = 1;", "+const a  = 1;"],
    },
  ]);
  states.edit({ fileName: OUTSIDE_PATH, diffStr: "", additions: 1, deletions: 0 });
  states.claudeEdit(`${REPO}/.env.local`, [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-FLUSH=16", "+FLUSH=32"] },
  ]);
  states.checkpoint(
    [file("src/states/missing-paths.ts", 1, 1), file("src/states/whitespace-only.ts", 1, 1)],
    {},
    "ready",
    {
      diff: statePatch("missing-paths"),
      whitespaceDiff: joinPatches(
        statePatch("missing-paths"),
        gitPatch("src/states/whitespace-only.ts", "src/states/whitespace-only.ts", [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-const a = 1;", "+const a  = 1;"],
          },
        ]),
      ),
    },
  );
});
stateTurn("size-limit", () => {
  states.claudeEdit(statePath("beyond-limit"), [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-// beyond", "+// beyond, done"],
    },
  ]);
  states.checkpoint(
    [file("src/states/size-limit.ts", 1, 1), file("src/states/beyond-limit.ts", 1, 1)],
    {},
    "ready",
    { diff: statePatch("size-limit"), truncated: true },
  );
});
// An old checkpoint has no stamp. Its patch paths are relative to the repository, which here
// is one folder above the thread's workspace, so a link matches only by its unique suffix.
const OLD_PREFIX = "atlas/src/states";
stateTurn("old-checkpoint", () => {
  states.claudeEdit(statePath("legacy-shim"), [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-// shim", "+// shim, done"] },
  ]);
  const oldPatch = (name: string) =>
    gitPatch(`${OLD_PREFIX}/${name}.ts`, `${OLD_PREFIX}/${name}.ts`, [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [`-// ${name}`, `+// ${name}, done`],
      },
    ]);
  states.checkpoint(
    [file(`${OLD_PREFIX}/old-checkpoint.ts`, 1, 1), file(`${OLD_PREFIX}/legacy-shim.ts`, 1, 1)],
    null,
    "ready",
    { diff: joinPatches(oldPatch("old-checkpoint"), oldPatch("legacy-shim")) },
  );
});
// The turn ran in a worktree that has since moved; the thread's folder is the repository now.
stateTurn(
  "moved-worktree",
  () =>
    states.checkpoint(
      [file("src/states/moved-worktree.ts", 1, 1)],
      { cwd: MOVED_WORKTREE, repoRoot: MOVED_WORKTREE },
      "ready",
      { diff: statePatch("moved-worktree") },
    ),
  "completed",
  true,
  MOVED_WORKTREE,
);
stateTurn(
  "running",
  () => {
    states.command("pnpm test --watch", undefined, { status: "running" });
  },
  "running",
);

// ---------------------------------------------------------------------------
// AC-14 reference rows, each the last row of its own thread
// ---------------------------------------------------------------------------

function referenceThread(id: string, title: string, build: (thread: ThreadBuilder) => void) {
  const thread = new ThreadBuilder(id, title, 20);
  thread.user(title);
  thread.startRun(CLAUDE);
  build(thread);
  thread.checkpoint([], {});
  thread.endRun();
  return thread;
}
const refSed = referenceThread("thread-ref-sed", "Read the flush code", (thread) => {
  thread.assistant("Reading the flush window of the stream.");
  thread.command(
    "sed -n 240,500p packages/core/src/chat/streaming.ts",
    streamingSource.replaceAll("→", " "),
    { exitCode: 0 },
  );
});
export const SKILL_PATH =
  "/Users/anton/.claude/plugins/marketplaces/specweave/plugins/sw/skills/streaming-flush-tuning/references/SKILL.md";
const refRead = referenceThread("thread-ref-read", "Check the tuning skill", (thread) => {
  thread.assistant("Reading the tuning skill first.");
  thread.read(
    SKILL_PATH,
    "     1→# Streaming flush tuning\n     2→Raise the interval in steps of 8 ms.",
  );
});
export const BRIEF_PATH = "/tmp/sk-cost-arch/brief.md";
const refBrief = referenceThread("thread-ref-brief", "Write the cost brief", (thread) => {
  thread.assistant("Writing the brief outside the repository.");
  thread.claudeEdit(BRIEF_PATH, [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      lines: ["+# Cost architecture brief", "+Flush cost falls 40% at 32 ms."],
    },
  ]);
});
const refGroup = referenceThread("thread-ref-group", "Survey the flush call sites", (thread) => {
  thread.assistant("Surveying every flush call site.");
  for (let index = 0; index < 24; index += 1) {
    thread.command(
      `rg -n "flush\\(" packages/${["core", "client-runtime", "web"][index % 3]} --max-count ${index + 1}`,
      `match ${index}`,
      {
        exitCode: 0,
      },
    );
  }
  thread.edit({
    ...projectCodexFileChanges(
      [STREAMING, WRITER, TIMER].map((path) => ({
        path,
        kind: { type: "update" },
        diff: '@@\n-flush();\n+flush({ reason: "interval" });\n',
      })) as never,
    )!,
  });
  for (let index = 0; index < 5; index += 1) {
    thread.read(`${REPO}/packages/core/src/chat/flushSite${index}.ts`, `     1→flush();`);
  }
});
const refThinking = referenceThread("thread-ref-thinking", "Plan the flush change", (thread) => {
  thread.assistant("Planning the change.");
  thread.thought(
    "The interval change touches the policy, the writer and the indicator; the writer cap should move with it so a burst still flushes before the interval ends.",
  );
});

export const threads: Record<string, FixtureThread> = Object.fromEntries(
  [activity, subagent, fork, states, refSed, refRead, refBrief, refGroup, refThinking].map(
    (builder) => [builder.thread.id, builder.thread],
  ),
);
export const ids = {
  activity: activity.thread.id,
  subagent: subagent.thread.id,
  fork: fork.thread.id,
  states: states.thread.id,
  refSed: refSed.thread.id,
  refRead: refRead.thread.id,
  refBrief: refBrief.thread.id,
  refGroup: refGroup.thread.id,
  refThinking: refThinking.thread.id,
  turn2: turn2.id,
  turn3: turn3.id,
  subagentTitle: SUBAGENT_TITLE,
};

/** The projection DiffPanel and the checkpoint cards read. */
export function threadProjection(thread: FixtureThread) {
  return {
    checkpoints: thread.checkpoints,
    messages: thread.messages,
    runs: thread.runs.map((run) => ({ id: run.id, status: run.status })),
  } as never;
}

/** Whether the subagent's thread counts as loaded: `?subagents=unloaded` says no. */
export const subagentsLoaded = new URLSearchParams(location.search).get("subagents") !== "unloaded";

// ---------------------------------------------------------------------------
// Fake RPC server
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const bump = () => {
  version += 1;
  for (const listener of listeners) listener();
};
const responses = new Map<string, unknown>();
const pending = new Set<string>();
const latencyMs = 40;

function useServerValue<T>(key: string | null, answer: () => T): T | undefined {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (key === null || responses.has(key) || pending.has(key)) return;
    pending.add(key);
    window.setTimeout(() => {
      pending.delete(key);
      responses.set(key, answer());
      bump();
    }, latencyMs);
  }, [key]);
  return key === null ? undefined : (responses.get(key) as T | undefined);
}

function turnItemRead(target: Record<string, any>): OrchestrationV2GetTurnItemResult {
  const item = storedItems.get(`${target.threadId}:${target.itemId}`);
  if (!item) return { item: null } as never;
  const { field, changeIndex, offset, before, anchor, limit } = target;
  return projectTurnItemForDetail(item, {
    ...(field === undefined ? {} : { field }),
    ...(changeIndex === undefined ? {} : { changeIndex }),
    ...(offset === undefined ? {} : { offset }),
    ...(before === undefined ? {} : { before }),
    ...(anchor === undefined ? {} : { anchor }),
    ...(limit === undefined ? {} : { limit }),
  }) as never;
}

/** `state/queries`: one getTurnItem read while a row is open. */
export function useTurnItemDetail(target: Record<string, any> | null) {
  const key = target === null ? null : `item:${JSON.stringify(target)}`;
  const data = useServerValue(key, () => {
    record("turnItemReads", target);
    return turnItemRead(target!);
  });
  return { data, isPending: key !== null && data === undefined, error: null };
}

/** `state/queries`: a fresh page read for Load more, Load earlier and Copy full. */
export async function fetchTurnItemDetail(
  target: Record<string, any>,
): Promise<OrchestrationV2GetTurnItemResult> {
  await new Promise((resolve) => window.setTimeout(resolve, 10));
  const result = turnItemRead(target);
  const page = (result as { page?: { offset: number; end: number; text: string } }).page;
  // Where each page starts and ends, with the characters on both sides of the cut.
  record("turnItemPageReads", {
    ...target,
    ...(page
      ? {
          offset: page.offset,
          end: page.end,
          head: Array.from(page.text.slice(0, 2))[0] ?? "",
          tail: Array.from(page.text.slice(-2)).at(-1) ?? "",
        }
      : {}),
  });
  return result;
}

/** `state/queries`: the turn-diff RPC, from the canned patch of the turn's checkpoint. */
export function useCheckpointDiff(target: Record<string, any>, options?: { enabled?: boolean }) {
  const enabled =
    options?.enabled !== false &&
    target.environmentId !== null &&
    target.threadId !== null &&
    target.fromTurnCount !== null &&
    target.toTurnCount !== null;
  const key = enabled ? `diff:${JSON.stringify(target)}` : null;
  const response = useServerValue(key, () => {
    record("turnDiffReads", target);
    const turn = threads[target.threadId]?.turnDiffs.get(target.toTurnCount);
    if (!turn || turn.error) return { error: turn?.error ?? "No checkpoint diff for this turn." };
    return {
      data: {
        diff: !target.ignoreWhitespace && turn.whitespaceDiff ? turn.whitespaceDiff : turn.diff,
        ...(turn.truncated ? { truncated: true } : {}),
      },
    };
  }) as { data?: { diff: string; truncated?: boolean }; error?: string } | undefined;
  return {
    data: response?.data,
    error: response?.error ?? null,
    isPending: key !== null && response === undefined,
  };
}

// ---------------------------------------------------------------------------
// Store stand-ins (`state/entities`, DiffPanel's I/O hooks)
// ---------------------------------------------------------------------------

export function useThreadShell(ref: { environmentId: string; threadId: string } | null) {
  const thread = ref ? threads[ref.threadId] : undefined;
  return thread
    ? {
        id: thread.id,
        environmentId: HOST,
        projectId: null,
        title: thread.title,
        worktreePath: thread.worktreePath,
        providerInstanceId: thread.providerInstanceId,
      }
    : null;
}
const projections = new Map<string, unknown>();
export function useThreadProjection(ref: { environmentId: string; threadId: string } | null) {
  const thread = ref ? threads[ref.threadId] : undefined;
  if (!thread) return null;
  let projection = projections.get(thread.id);
  if (!projection) {
    projection = { projection: threadProjection(thread) };
    projections.set(thread.id, projection);
  }
  return projection;
}
export const useProject = () => null;
const NO_LINK_TARGETS: never[] = [];
export const useThreadLinkTargets = () => NO_LINK_TARGETS;
export const useFilesystemReadAccess = () => ({
  canReadFiles: true,
  isPending: false,
  error: null,
});
export const useOpenInPreferredEditor = () => async (path: string) => {
  record("editorOpens", path);
  return { _tag: "Success", value: undefined };
};
export const useFileContextMenuHandler = () => () => {};
export const useMachineNicknames = () => (environmentId: string) =>
  MACHINE_NAMES[environmentId] ?? environmentId;
const refresh = () => {};
export function useEnvironmentQuery(query: { kind?: string } | null) {
  return {
    data: query?.kind === "status" ? { isRepo: true } : undefined,
    isPending: false,
    error: null,
    refresh,
  };
}
export const useAtomCommand = () => async () => ({ _tag: "Success", value: undefined });
export const useAtomValue = () => ({ availableEditors: [] });
export const serverEnvironment = { configValueAtom: (environmentId: unknown) => environmentId };
export const reviewEnvironment = {
  diffFileContents: "diffFileContents",
  diffPreview: (input: object) => ({ kind: "diff", ...input }),
};
export const vcsEnvironment = {
  status: (input: object) => ({ kind: "status", ...input }),
  listRefs: (input: object) => ({ kind: "refs", ...input }),
};

/** Keeps a component mounted state in sync with a value the page sets later. */
export function useLatest<T>(value: T): T {
  const [state, setState] = useState(value);
  useEffect(() => setState(value), [value]);
  return state;
}

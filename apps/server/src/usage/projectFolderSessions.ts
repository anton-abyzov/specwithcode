/**
 * Usage of native CLI sessions that ran inside a project's folders.
 *
 * Work on a project often happens in a terminal rather than in a Studio
 * thread: `claude`, `codex`, `grok` or `copilot` started in the checkout. Those
 * sessions never become provider turns, so the project's recorded usage
 * misses them. Each CLI writes a log that names the directory it ran in, which
 * is enough to attribute the session to the project whose folder holds it.
 *
 * Reading is local and read-only. Sessions a Studio thread owns are left out,
 * because the thread already records their turns.
 *
 * @module usage/projectFolderSessions
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const nativeFiles = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer));
import { nodePath as NodePath } from "../nodePath.ts";

import type {
  ProjectFolderUsage,
  ProjectFolderUsageModel,
  ProjectFolderUsageProvider,
  ProjectUsageTotals,
} from "@specweave-studio/contracts";

import * as DateTime from "effect/DateTime";

import { priceUsage, type RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

/** Native CLIs whose logs are attributed by folder. */
export type FolderSessionProvider = "claude" | "codex" | "grok" | "copilot";

/** One folder session's usage records, whichever CLI wrote them. */
export interface FolderSessionFile {
  readonly provider: FolderSessionProvider;
  readonly path: string;
  readonly records: readonly FolderUsageRecord[];
}

export type FolderUsageRecord = Pick<
  UsageRecord,
  | "timestampMs"
  | "model"
  | "rateModel"
  | "sessionId"
  | "totals"
  | "reportedCostUsd"
  | "speed"
  | "dedupeKey"
>;

const HEAD_BYTES = 64 * 1024;

function trimSeparators(value: string): string {
  return value.length > 1 ? value.replace(/[\\/]+$/, "") : value;
}

/** True when `candidate` is `root` or a directory below it. */
export function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = trimSeparators(NodePath.resolve(root));
  const normalized = trimSeparators(NodePath.resolve(candidate));
  if (normalized === normalizedRoot) return true;
  const relative = NodePath.relative(normalizedRoot, normalized);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(".." + NodePath.sep) &&
    !NodePath.isAbsolute(relative)
  );
}

export function isWithinAnyRoot(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithinRoot(candidate, root));
}

/** Claude Code names a session folder after its cwd with every other character as `-`. */
export function encodeClaudeProjectDir(directory: string): string {
  return trimSeparators(NodePath.resolve(directory)).replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Cheap gate on a Claude Code session folder name. A child of a root encodes
 * as the root's name plus `-`, but so does a sibling such as `app-old`, so a
 * match still needs the folder's recorded cwd.
 */
export function claudeDirMayMatch(dirName: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const encoded = encodeClaudeProjectDir(root);
    return dirName === encoded || dirName.startsWith(encoded + "-");
  });
}

/** Grok keeps sessions under `sessions/<url-encoded cwd>/<id>/updates.jsonl`. */
export function grokSessionCwd(filePath: string, sessionsDir: string): string | null {
  const relative = NodePath.relative(sessionsDir, filePath);
  const first = relative.split(NodePath.sep)[0];
  if (!first || first === ".." || first === relative) return null;
  try {
    const decoded = decodeURIComponent(first);
    return NodePath.isAbsolute(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

async function readHead(filePath: string, bytes = HEAD_BYTES): Promise<string | null> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* nativeFiles.open(filePath, { flag: "r" });
    const buffer = new Uint8Array(bytes);
    const bytesRead = yield* handle.read(buffer);
    return Buffer.from(buffer.subarray(0, bytesRead)).toString("utf8");
  }),
    ).pipe(Effect.orElseSucceed(() => null)),
  );
}

/**
 * The first `"cwd":"…"` value in a log's head. Codex puts it on the opening
 * `session_meta` line, which can carry long instructions, so the value is
 * decoded on its own rather than by parsing a possibly truncated line.
 */
export function firstCwdIn(text: string): string | null {
  const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" && NodePath.isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

/** Most logs name their cwd in the first lines; a long opening summary can push it later. */
export async function readLogCwd(filePath: string): Promise<string | null> {
  const head = await readHead(filePath, 16 * 1024);
  if (head === null) return null;
  const early = firstCwdIn(head);
  if (early !== null || Buffer.byteLength(head) < 16 * 1024) return early;
  const longer = await readHead(filePath, 256 * 1024);
  return longer === null ? null : firstCwdIn(longer);
}

/** Copilot CLI: `session-state/<id>/events.jsonl`, cwd on `session.start`, usage per request. */
export function parseCopilotEvents(text: string): {
  readonly cwd: string | null;
  readonly sessionId: string | null;
  readonly records: readonly FolderUsageRecord[];
} {
  let cwd: string | null = null;
  let sessionId: string | null = null;
  const records: FolderUsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"session.start"') && !line.includes('"session.usage_record"')) continue;
    let event: { type?: unknown; data?: unknown; id?: unknown; timestamp?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    const data = (
      typeof event.data === "object" && event.data !== null ? event.data : {}
    ) as Record<string, unknown>;
    if (event.type === "session.start") {
      const context = data["context"] as Record<string, unknown> | undefined;
      if (typeof context?.["cwd"] === "string") cwd = context["cwd"];
      if (typeof data["sessionId"] === "string") sessionId = data["sessionId"];
      continue;
    }
    if (event.type !== "session.usage_record") continue;
    const usage = data["usage"] as Record<string, unknown> | undefined;
    if (!usage) continue;
    const n = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
    const input = n(usage["inputTokens"]);
    const cachedInputTokens = n(usage["cacheReadTokens"]);
    const cacheCreationTokens = n(usage["cacheWriteTokens"]);
    const outputTokens = n(usage["outputTokens"]);
    const timestampMs = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    const model = typeof usage["model"] === "string" ? usage["model"] : "";
    if (!Number.isFinite(timestampMs) || model.length === 0) continue;
    records.push({
      timestampMs,
      model,
      sessionId: sessionId ?? "",
      totals: {
        // Copilot's input already contains the cached part.
        uncachedInputTokens: Math.max(0, input - cachedInputTokens - cacheCreationTokens),
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens: Math.min(outputTokens, n(usage["reasoningTokens"])),
      },
      // Copilot's `cost` counts premium requests, not dollars.
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: typeof event.id === "string" ? `copilot:${event.id}` : null,
    });
  }
  return { cwd, sessionId, records };
}

/** Copilot sessions in the folders, newest logs first, skipping logs older than `sinceMs`. */
export async function readCopilotFolderSessions(
  sessionStateDir: string,
  inProject: (cwd: string | null) => boolean,
  sinceMs: number,
): Promise<readonly FolderSessionFile[]> {
  let entries: string[];
  try {
    entries = await Effect.runPromise(nativeFiles.readDirectory(sessionStateDir));
  } catch {
    return [];
  }
  const files: FolderSessionFile[] = [];
  for (const entry of entries) {
    const filePath = NodePath.join(sessionStateDir, entry, "events.jsonl");
    try {
      const stats = await Effect.runPromise(nativeFiles.stat(filePath));
      if (
        Option.getOrElse(
          Option.map(stats.mtime, (time) => time.valueOf()),
          () => 0,
        ) < sinceMs
      )
        continue;
      const head = await readHead(filePath);
      const startCwd = head === null ? null : parseCopilotEvents(head).cwd;
      if (!inProject(startCwd)) continue;
      const parsed = parseCopilotEvents(
        await Effect.runPromise(nativeFiles.readFileString(filePath)),
      );
      files.push({ provider: "copilot", path: filePath, records: parsed.records });
    } catch {
      // Missing or unreadable logs are skipped; a folder scan is best effort.
    }
  }
  return files;
}

const zeroTotals = (): ProjectUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  equivalentCostUsd: null,
});

function add(target: ProjectUsageTotals, record: FolderUsageRecord, cost: number | null) {
  const input =
    record.totals.uncachedInputTokens +
    record.totals.cachedInputTokens +
    record.totals.cacheCreationTokens;
  return {
    inputTokens: target.inputTokens + input,
    outputTokens: target.outputTokens + record.totals.outputTokens,
    totalTokens: target.totalTokens + input + record.totals.outputTokens,
    cachedInputTokens: (target.cachedInputTokens ?? 0) + record.totals.cachedInputTokens,
    cacheCreationTokens: (target.cacheCreationTokens ?? 0) + record.totals.cacheCreationTokens,
    reasoningTokens: (target.reasoningTokens ?? 0) + record.totals.reasoningTokens,
    equivalentCostUsd:
      cost === null ? target.equivalentCostUsd : (target.equivalentCostUsd ?? 0) + cost,
  } satisfies ProjectUsageTotals;
}

const PROVIDER_ORDER: Record<FolderSessionProvider, number> = {
  claude: 0,
  codex: 1,
  copilot: 2,
  grok: 3,
};

/**
 * Folds folder sessions into project totals. Records repeated across files
 * count once; sessions a Studio thread owns are skipped and counted apart.
 */
export function aggregateFolderUsage(input: {
  readonly hostLabel: string;
  readonly windowDays: number;
  readonly roots: readonly string[];
  readonly files: readonly FolderSessionFile[];
  readonly studioSessionIds: ReadonlySet<string>;
  readonly rates?: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
}): ProjectFolderUsage {
  const rates = input.rates ?? new Map();
  const seen = new Set<string>();
  const sessions = new Set<string>();
  const owned = new Set<string>();
  const providers = new Map<
    FolderSessionProvider,
    { sessions: Set<string>; totals: ProjectUsageTotals; lastActiveMs: number }
  >();
  const models = new Map<string, ProjectFolderUsageModel>();
  let totals = zeroTotals();
  for (const file of input.files) {
    for (const record of file.records) {
      // A session without an id is still one session: its file names it.
      const session = `${file.provider}:${record.sessionId || file.path}`;
      if (record.sessionId && input.studioSessionIds.has(record.sessionId)) {
        owned.add(session);
        continue;
      }
      if (record.dedupeKey !== null) {
        const key = `${file.provider}\0${record.dedupeKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      // Claude Code logs local messages (interrupts, API errors) as model
      // "<synthetic>" with no tokens; they are not usage.
      const { uncachedInputTokens, cachedInputTokens, cacheCreationTokens, outputTokens } =
        record.totals;
      if (uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens <= 0) {
        continue;
      }
      const model = input.modelAliases?.get(record.model) ?? record.model;
      const priced = priceUsage(
        rates,
        {
          model,
          ...(record.rateModel ? { rateModel: record.rateModel } : {}),
          speed: record.speed,
          reportedCostUsd: record.reportedCostUsd,
          totals: record.totals,
        },
        input.priceOverrides,
      );
      const cost = priced.costSource === "unpriced" ? null : priced.costUsd;
      sessions.add(session);
      totals = add(totals, record, cost);
      const entry = providers.get(file.provider) ?? {
        sessions: new Set<string>(),
        totals: zeroTotals(),
        lastActiveMs: 0,
      };
      entry.sessions.add(session);
      entry.totals = add(entry.totals, record, cost);
      entry.lastActiveMs = Math.max(entry.lastActiveMs, record.timestampMs);
      providers.set(file.provider, entry);
      const modelKey = `${file.provider}\0${model}`;
      const current = models.get(modelKey);
      models.set(modelKey, {
        provider: file.provider,
        model: model.trim() || null,
        totals: add(current?.totals ?? zeroTotals(), record, cost),
      });
    }
  }
  const providerRows: ProjectFolderUsageProvider[] = [...providers]
    .sort(([left], [right]) => PROVIDER_ORDER[left] - PROVIDER_ORDER[right])
    .map(([provider, entry]) => ({
      provider,
      sessions: entry.sessions.size,
      totals: entry.totals,
      lastActiveAt:
        entry.lastActiveMs > 0 ? DateTime.formatIso(DateTime.makeUnsafe(entry.lastActiveMs)) : null,
    }));
  return {
    hostLabel: input.hostLabel,
    windowDays: input.windowDays,
    roots: [...input.roots],
    sessions: sessions.size,
    studioOwnedSessions: [...owned].filter((session) => !sessions.has(session)).length,
    totals,
    providers: providerRows,
    models: [...models.values()].sort((a, b) => b.totals.totalTokens - a.totals.totalTokens),
  };
}

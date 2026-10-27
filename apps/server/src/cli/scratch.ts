// @effect-diagnostics nodeBuiltinImport:off -- moves folders with the same node:fs calls as scratchPrune.
/**
 * `specweave-studio scratch prune`: the supported way to clear old folders
 * from `<baseDir>/scratch`, which holds the Scratch project's chat-thread
 * folders as well as agents' probes and run logs.
 *
 * It reads the live database read-only, as `worktree owners` does, and keeps
 * every folder a project, a thread (open, archived, or deleted at any time),
 * or a live agent session uses, plus anything whose age it cannot read. By
 * default it only prints what it would do. `--apply` moves folders into
 * `--archive-to`; deleting needs `--delete` as well.
 *
 * Exit codes: 0 done, 1 some folder could not be moved or deleted (or the
 * run stopped after acting on one), 2 refused (no readable database, bad
 * flags). Nothing is removed when it exits 2.
 *
 * Owners are read again right before `--apply` acts, and each folder's age
 * right before it moves. A thread bound to an old folder in the moments
 * between that read and the move is not seen.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  decodeWorktreeBindings,
  pathSpellings,
  WORKTREE_OWNER_PROJECTS_SQL,
  WORKTREE_OWNER_SESSIONS_SQL,
  WORKTREE_OWNER_THREADS_SQL,
  type WorktreeOwnerRows,
  worktreeThreadState,
} from "../git/worktreeOwnership.ts";
import { openLiveDatabaseReadOnly } from "../persistence/liveDatabaseSnapshot.ts";
import {
  archiveFolder,
  casesFoldOn,
  DAY_MS,
  decideScratchPrune,
  errorText,
  newestTreeMtime,
  parseAge,
  pathInside,
  readScratchEntries,
  SCRATCH_PRUNE_DEFAULT_AGE_MS,
  SCRATCH_PRUNE_MIN_AGE_MS,
  type ScratchDecision,
  type ScratchEntry,
  type ScratchLivePath,
  SourcePartlyRemovedError,
} from "../scratchPrune.ts";
import { baseDirFlag } from "./config.ts";
import { resolveHome } from "./db.ts";

export class ScratchPruneError extends Schema.TaggedError<ScratchPruneError>()(
  "ScratchPruneError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Exit code when the command refused to run. Nothing was removed. */
export const SCRATCH_PRUNE_REFUSED = 2;

// Every thread that ever recorded a folder, deleted ones included: a Scratch
// chat thread's folder cannot be recreated, so any record of it keeps it.
const ALL_THREAD_FOLDERS_SQL = `
  SELECT thread_id, payload_json, deleted_at, archived_at FROM orchestration_v2_projection_threads
`;

interface StoreRows extends WorktreeOwnerRows {
  readonly allThreads: ReadonlyArray<{
    readonly thread_id: string;
    readonly payload_json: string;
    readonly deleted_at: string | null;
    readonly archived_at: string | null;
  }>;
}

const decodeThreadFolder = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ worktreePath: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
);

const refuse = (reason: string) => new ScratchPruneError({ reason });

/** One read-only snapshot of every owner. Any failure refuses the whole run. */
const readStore = (dbPath: string) =>
  Effect.try({
    try: (): StoreRows => {
      if (!NodeFS.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
      const database = openLiveDatabaseReadOnly(dbPath);
      try {
        const all = <Row>(sql: string) => database.prepare(sql).all() as unknown as Array<Row>;
        return {
          projects: all(WORKTREE_OWNER_PROJECTS_SQL),
          threads: all(WORKTREE_OWNER_THREADS_SQL),
          sessions: all(WORKTREE_OWNER_SESSIONS_SQL),
          allThreads: all(ALL_THREAD_FOLDERS_SQL),
        };
      } finally {
        database.close();
      }
    },
    catch: (cause) => refuse(`cannot read the database, so nothing is pruned: ${errorText(cause)}`),
  });

const livePathsOf = Effect.fn("cli.scratch.live_paths")(function* (rows: StoreRows) {
  const bindings = yield* decodeWorktreeBindings(rows);
  const live: Array<ScratchLivePath> = [
    ...bindings.projects.map((owner) => ({
      paths: owner.paths,
      owner: `project ${owner.workspaceRoot}`,
    })),
    ...bindings.threads.map((owner) => ({
      paths: owner.paths,
      owner: `thread ${owner.threadId} (${worktreeThreadState(owner)})`,
    })),
    ...bindings.sessions.map((owner) => ({
      paths: owner.paths,
      owner: `agent session${owner.threadId === null ? "" : ` of thread ${owner.threadId}`}`,
    })),
  ];
  for (const row of rows.allThreads) {
    const folder = (yield* decodeThreadFolder(row.payload_json)).worktreePath ?? null;
    if (folder === null) continue;
    const state =
      row.deleted_at !== null ? "deleted" : row.archived_at !== null ? "archived" : "recorded";
    live.push({ paths: yield* pathSpellings(folder), owner: `thread ${row.thread_id} (${state})` });
  }
  return live;
});

/**
 * The real path `target` would have: the real path of its nearest existing
 * parent plus the rest, so it can be checked before anything is created.
 */
function realPathToBe(target: string): string {
  let existing = target;
  while (!NodeFS.existsSync(existing)) {
    const parent = NodePath.dirname(existing);
    if (parent === existing) return target;
    existing = parent;
  }
  return NodePath.join(NodeFS.realpathSync(existing), NodePath.relative(existing, target));
}

const iso = (ms: number | null) =>
  ms === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));

const pruneCommand = Command.make("prune", {
  baseDir: baseDirFlag,
  olderThan: Flag.String("older-than").pipe(
    Flag.withDescription(
      "Only folders with nothing modified for this long, as 14d, 2w or 336h. At least 7d; the default is 14d.",
    ),
    Flag.optional,
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Act on the folders instead of only listing them."),
    Flag.withDefault(false),
  ),
  archiveTo: Flag.String("archive-to").pipe(
    Flag.withDescription(
      "Move folders into this directory. Required with --apply unless --delete.",
    ),
    Flag.optional,
  ),
  delete: Flag.Boolean("delete").pipe(
    Flag.withDescription("With --apply and no --archive-to: delete folders permanently."),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print one JSON line per folder, then a summary line."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "List, archive or delete old folders in <base-dir>/scratch that no project, thread or live agent session uses. Prints a dry run unless --apply is given.",
  ),
  Command.withHandler(
    Effect.fn("cli.scratch.prune")(
      function* (flags) {
        // Folders acted on so far: a stop after the first one is not "nothing removed".
        progress.acted = 0;
        const olderThanMs = Option.match(flags.olderThan, {
          onNone: () => SCRATCH_PRUNE_DEFAULT_AGE_MS,
          onSome: parseAge,
        });
        if (olderThanMs === null)
          return yield* refuse("--older-than takes a number and a unit: 14d, 2w or 336h.");
        if (olderThanMs < SCRATCH_PRUNE_MIN_AGE_MS)
          return yield* refuse("--older-than must be at least 7d.");
        const archiveDir = Option.getOrNull(flags.archiveTo);
        if (archiveDir !== null && flags.delete)
          return yield* refuse("pass --archive-to or --delete, not both.");
        if (flags.apply && archiveDir === null && !flags.delete)
          return yield* refuse(
            "--apply needs --archive-to DIR, or --delete to remove folders permanently.",
          );

        const { home, paths } = yield* resolveHome(flags.baseDir);
        const rows = yield* readStore(paths.dbPath);
        const scratch = NodePath.resolve(home, "scratch");
        if (!NodeFS.existsSync(scratch)) {
          yield* Console.log(
            flags.json
              ? // @effect-diagnostics-next-line preferSchemaOverJson:off - one output line, like `worktree owners --json`.
                JSON.stringify({ kind: "summary", scratch, applied: flags.apply, removable: 0 })
              : `No scratch folder at ${scratch}.`,
          );
          return;
        }
        const scratchReal = NodeFS.realpathSync(scratch);
        const scratchRoots = scratchReal === scratch ? [scratchReal] : [scratchReal, scratch];
        const foldCase = casesFoldOn(yield* HostProcessPlatform);
        let archiveReal: string | null = null;
        if (flags.apply && archiveDir !== null) {
          const resolved = NodePath.resolve(archiveDir);
          const inside = (target: string) => pathInside(scratchReal, target, foldCase);
          // Checked before mkdir, so a refused run leaves nothing behind.
          if (inside(realPathToBe(resolved)))
            return yield* refuse("--archive-to must be outside the scratch folder.");
          NodeFS.mkdirSync(resolved, { recursive: true });
          archiveReal = NodeFS.realpathSync(resolved);
          if (inside(archiveReal))
            return yield* refuse("--archive-to must be outside the scratch folder.");
        }

        const livePaths = yield* livePathsOf(rows);
        const now = yield* Clock.currentTimeMillis;
        const entries = readScratchEntries(scratchReal, scratchRoots.slice(1));
        const decisions = decideScratchPrune({
          scratchRoots,
          entries,
          livePaths,
          now,
          olderThanMs,
          foldCase,
        });

        // The walk can take a while: a thread bound to an old folder meanwhile
        // keeps it. A database that stopped being readable refuses as before.
        const latestLivePaths =
          flags.apply && decisions.some((decision) => decision.action === "remove")
            ? yield* livePathsOf(yield* readStore(paths.dbPath))
            : livePaths;
        const entryByName = new Map(entries.map((entry) => [entry.name, entry]));

        let failed = 0;
        const results = { archived: 0, deleted: 0, skipped: 0 };
        for (const decision of decisions) {
          let outcome: ScratchOutcome | null = null;
          if (flags.apply && decision.action === "remove") {
            outcome = actOnFolder({
              decision,
              entry: entryByName.get(decision.name),
              scratchRoots,
              livePaths: latestLivePaths,
              archiveDir: archiveReal,
              olderThanMs,
              now: yield* Clock.currentTimeMillis,
              foldCase,
            });
            if (outcome.result !== "skipped") progress.acted += 1;
            if (outcome.result === "failed" || outcome.result === "partial") failed += 1;
            else results[outcome.result] += 1;
          }
          yield* Console.log(line(decision, outcome, flags.apply, flags.json));
        }
        const removable = decisions.filter((decision) => decision.action === "remove").length;
        if (flags.json)
          yield* Console.log(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - one output line, like `worktree owners --json`.
            JSON.stringify({
              kind: "summary",
              scratch: scratchReal,
              applied: flags.apply,
              olderThanDays: olderThanMs / DAY_MS,
              removable,
              kept: decisions.length - removable,
              ...results,
              failed,
            }),
          );
        else
          yield* Console.log(
            flags.apply
              ? `${results.archived} archived, ${results.deleted} deleted, ${results.skipped} skipped, ${failed} failed; ${decisions.length - removable} kept.`
              : `Dry run: ${removable} of ${decisions.length} folders would go. Pass --apply --archive-to DIR to move them.`,
          );
        if (failed > 0) process.exitCode = 1;
      },
      Effect.catchCause((cause) => {
        // Ctrl-C stays an interrupt, not a refusal.
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        return Console.error(
          `scratch prune: ${error instanceof Error ? error.message : String(error)}`,
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = progress.acted > 0 ? 1 : SCRATCH_PRUNE_REFUSED;
            }),
          ),
        );
      }),
    ),
  ),
);

/** How many folders this run has acted on, for the exit code when it stops early. */
const progress = { acted: 0 };

export interface ScratchOutcome {
  readonly result: "archived" | "deleted" | "skipped" | "failed" | "partial";
  readonly detail?: string;
}

/**
 * Acts on one folder decided removable, after checking again that no live
 * path in `livePaths` (read just before) overlaps it and that nothing in it
 * changed since the walk.
 */
export function actOnFolder(input: {
  readonly decision: ScratchDecision;
  readonly entry: ScratchEntry | undefined;
  readonly scratchRoots: ReadonlyArray<string>;
  readonly livePaths: ReadonlyArray<ScratchLivePath>;
  readonly archiveDir: string | null;
  readonly olderThanMs: number;
  readonly now: number;
  readonly foldCase: boolean;
}): ScratchOutcome {
  const { decision } = input;
  if (input.entry === undefined) return { result: "skipped", detail: "no longer listed" };
  const age = newestTreeMtime(decision.path);
  const [recheck] = decideScratchPrune({
    scratchRoots: input.scratchRoots,
    entries: [{ ...input.entry, age }],
    livePaths: input.livePaths,
    now: input.now,
    olderThanMs: input.olderThanMs,
    foldCase: input.foldCase,
  });
  if (recheck === undefined || recheck.action !== "remove")
    return { result: "skipped", detail: `changed since the check: ${recheck?.reason ?? "gone"}` };
  try {
    if (input.archiveDir !== null)
      return { result: "archived", detail: archiveFolder(decision.path, input.archiveDir) };
    NodeFS.rmSync(decision.path, { recursive: true });
    return { result: "deleted" };
  } catch (cause) {
    if (cause instanceof SourcePartlyRemovedError)
      return { result: "partial", detail: cause.message };
    return { result: "failed", detail: errorText(cause) };
  }
}

function line(
  decision: ScratchDecision,
  outcome: ScratchOutcome | null,
  apply: boolean,
  json: boolean,
): string {
  if (json)
    return JSON.stringify({
      kind: "folder",
      name: decision.name,
      path: decision.path,
      action: decision.action,
      reason: decision.reason,
      newest: iso(decision.newestMs),
      ...(outcome === null ? {} : { result: outcome.result }),
      ...(outcome?.detail === undefined ? {} : { detail: outcome.detail }),
    });
  const label =
    decision.action === "keep"
      ? "keep"
      : outcome !== null
        ? outcome.result
        : apply
          ? "remove"
          : "would go";
  const detail = outcome?.detail === undefined ? "" : ` -> ${outcome.detail}`;
  return `${label.padEnd(9)} ${decision.path}  ${decision.reason}${detail}`;
}

export const scratchCommand = Command.make("scratch").pipe(
  Command.withDescription(
    "Clear old folders from <base-dir>/scratch safely. Chat-thread folders there cannot be recreated.",
  ),
  Command.withSubcommands([pruneCommand]),
);

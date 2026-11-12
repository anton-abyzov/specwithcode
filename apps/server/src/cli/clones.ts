// @effect-diagnostics nodeBuiltinImport:off -- checks the database file exists before the read-only open, as scratch prune does.
/**
 * `specweave-studio clones sweep`: list, and with `--apply` remove, review
 * and scratch clones of registered projects' repositories whose work is
 * merged. A copy that stays loses its dependency installs once it sat unused
 * for a day. The rules are in mergedCloneSweep.ts; the running service applies
 * the same sweep hourly (Settings: `storageCleanup.removeMergedClones`).
 *
 * It reads the live database read-only, as `scratch prune` and `worktree
 * owners` do. By default it only prints the plan.
 *
 * Exit codes: 0 done, 1 some clone could not be removed, 2 refused (no
 * readable database, bad flags). Nothing is removed when it exits 2.
 */
import * as NodeFS from "node:fs";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  decodeWorktreeBindings,
  WORKTREE_OWNER_PROJECTS_SQL,
  WORKTREE_OWNER_SESSIONS_SQL,
  WORKTREE_OWNER_THREADS_SQL,
  type WorktreeOwnerRows,
} from "../git/worktreeOwnership.ts";
import { listProcessCwds } from "../homeUsage/processCwds.ts";
import {
  CLONE_SWEEP_PROJECTS_SQL,
  type CloneDecision,
  type CloneRemoval,
  type CloneSweepContext,
  cloneSweepLivePaths,
  cloneSweepRoots,
  decideDependencyPrune,
  type DependencyPruneDecision,
  type DependencyPruneResult,
  ghMergedPullRequest,
  MERGED_CLONE_GRACE_MS,
  planCloneSweep,
  pruneDependencies,
  registeredRepositories,
  removeClone,
} from "../mergedCloneSweep.ts";
import { openLiveDatabaseReadOnly } from "../persistence/liveDatabaseSnapshot.ts";
import { casesFoldOn, errorText } from "../scratchPrune.ts";
import { baseDirFlag } from "./config.ts";
import { resolveHome } from "./db.ts";
import { parseWaitTimeout } from "./heavyCheckLock.ts";

export class ClonesSweepError extends Schema.TaggedError<ClonesSweepError>()("ClonesSweepError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** Exit code when the command refused to run. Nothing was removed. */
export const CLONES_SWEEP_REFUSED = 2;
/** Below this a clone someone just stepped away from could go. */
export const CLONES_SWEEP_MIN_GRACE_MS = 10 * 60_000;

const refuse = (reason: string) => new ClonesSweepError({ reason });

interface StoreRows extends WorktreeOwnerRows {
  readonly registered: ReadonlyArray<{
    readonly workspace_root: string;
    readonly workspace_settings_json: string | null;
  }>;
}

/** One read-only snapshot of every owner and project. Any failure refuses the whole run. */
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
          registered: all(CLONE_SWEEP_PROJECTS_SQL),
        };
      } finally {
        database.close();
      }
    },
    catch: (cause) =>
      refuse(`cannot read the database, so nothing is removed: ${errorText(cause)}`),
  });

function line(
  decision: CloneDecision,
  removal: CloneRemoval | null,
  apply: boolean,
  json: boolean,
): string {
  if (json)
    return JSON.stringify({
      kind: decision.kind,
      path: decision.path,
      action: decision.action,
      reason: decision.reason,
      origin: decision.origin,
      branch: decision.branch,
      head: decision.head,
      ...(removal === null ? {} : { result: removal.result }),
      ...(removal?.detail === undefined ? {} : { detail: removal.detail }),
      ...(removal?.removedParent === undefined ? {} : { removedParent: removal.removedParent }),
    });
  const label =
    removal !== null
      ? removal.result
      : decision.action === "remove"
        ? apply
          ? "remove"
          : "would go"
        : decision.action;
  const detail = removal?.detail === undefined ? "" : ` -> ${removal.detail}`;
  return `${label.padEnd(9)} ${decision.path}  ${decision.reason}${detail}`;
}

/** The line for a kept copy whose dependency installs would go, went or stay for a stated reason. */
function dependencyLine(
  prune: DependencyPruneDecision,
  result: DependencyPruneResult | null,
  apply: boolean,
  json: boolean,
): string {
  const installs = result?.result === "pruned" ? result.removed : prune.installs;
  if (json)
    return JSON.stringify({
      kind: "dependencies",
      path: prune.path,
      action: prune.action,
      reason: prune.reason,
      installs,
      ...(result === null ? {} : { result: result.result }),
      ...(result?.detail === undefined ? {} : { detail: result.detail }),
    });
  const label =
    result !== null
      ? result.result
      : prune.action === "prune"
        ? apply
          ? "prune"
          : "would go"
        : "keep";
  const detail = result?.detail === undefined ? "" : ` -> ${result.detail}`;
  const count = `${installs.length} dependency install${installs.length === 1 ? "" : "s"}`;
  return `${label.padEnd(9)}   ${count} in it: ${prune.reason}${detail}`;
}

/** Reasons without their per-clone details, for the summary. */
const reasonKind = (reason: string) =>
  reason
    .replace(/ \(\d+\)$/, "")
    .replace(/^in use by (project checkout|project|thread|agent session).*$/, "in use by a $1")
    .replace(/^changed \d+ min ago, inside.*$/, "inside the grace period")
    .replace(/^a process is working in .*$/, "a process is working in it")
    .replace(/^merged: .*$/, "merged, clean and unused")
    .replace(/^not merged: .*$/, "not merged")
    .replace(/^cannot read it: .*$/, "cannot read it");

const sweepCommand = Command.make("sweep", {
  baseDir: baseDirFlag,
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Remove the clones instead of only listing them."),
    Flag.withDefault(false),
  ),
  grace: Flag.String("grace").pipe(
    Flag.withDescription(
      "Only clones whose .git has not changed for this long, as 30m or 2h. At least 10m; the default is 2h.",
    ),
    Flag.optional,
  ),
  root: Flag.String("root").pipe(
    Flag.withDescription(
      "Look only under this folder instead of the app's scratch folder, the system temp folders and each project's scratch and .artifacts.",
    ),
    Flag.optional,
  ),
  noPullRequests: Flag.Boolean("no-pull-requests").pipe(
    Flag.withDescription(
      "Do not ask gh for merged pull requests: only a HEAD contained in the remote default branch counts as merged.",
    ),
    Flag.withDefault(false),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print one JSON line per clone, then a summary line."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "List clones of registered projects' repositories in scratch and temp folders whose work is merged, and with --apply remove them. A clone goes only when it is clean, has nothing unpushed and no stash, is not used by a project, thread, agent session or process, and has been idle for the grace period. Prints a dry run unless --apply is given.",
  ),
  Command.withHandler(
    Effect.fn("cli.clones.sweep")(
      function* (flags) {
        progress.removed = 0;
        const graceMs = Option.match(flags.grace, {
          onNone: () => MERGED_CLONE_GRACE_MS,
          onSome: parseWaitTimeout,
        });
        if (graceMs === null) return yield* refuse("--grace takes a number and a unit: 30m or 2h.");
        if (graceMs < CLONES_SWEEP_MIN_GRACE_MS)
          return yield* refuse("--grace must be at least 10m.");

        const { home, paths } = yield* resolveHome(flags.baseDir);
        const firstRows = yield* readStore(paths.dbPath);
        const platform = yield* HostProcessPlatform;
        const foldCase = casesFoldOn(platform);
        const registered = yield* Effect.promise(async () =>
          registeredRepositories(firstRows.registered),
        );
        const readContext = Effect.gen(function* () {
          const bindings = yield* decodeWorktreeBindings(yield* readStore(paths.dbPath));
          return {
            registeredRemotes: registered.remotes,
            sourceTreeNames: registered.sourceTreeNames,
            livePaths: cloneSweepLivePaths(bindings, registered.checkouts),
            processCwds: yield* listProcessCwds(platform),
            now: yield* Clock.currentTimeMillis,
            graceMs,
            foldCase,
            mergedPullRequest: flags.noPullRequests ? undefined : ghMergedPullRequest,
          } satisfies CloneSweepContext;
        });
        const context = yield* readContext;
        const decisions = yield* Effect.promise(() =>
          planCloneSweep(
            Option.match(flags.root, {
              onNone: () => cloneSweepRoots(home, registered.projectRoots),
              onSome: (root) => [root],
            }),
            context,
            { sourceTreeNames: registered.sourceTreeNames },
          ),
        );
        const run = { decisions, removed: 0, skipped: 0, failed: 0 };
        const dependencies = { prunable: 0, pruned: 0, skipped: 0, failed: 0 };
        for (const decision of decisions) {
          let removal: CloneRemoval | null = null;
          if (flags.apply && decision.action === "remove") {
            // Owners and processes are read again: a database that stopped being
            // readable refuses, and a clone bound or entered meanwhile stays.
            const fresh = yield* readContext;
            removal = yield* Effect.promise(() => removeClone(decision, fresh));
            run[removal.result] += 1;
            if (removal.result === "removed") progress.removed += 1;
          }
          yield* Console.log(line(decision, removal, flags.apply, flags.json));
          // A copy that stays may still lose its dependency installs.
          const prune = yield* Effect.promise(() => decideDependencyPrune(decision, context));
          if (prune === null) continue;
          let pruned: DependencyPruneResult | null = null;
          if (prune.action === "prune") {
            dependencies.prunable += 1;
            if (flags.apply) {
              const fresh = yield* readContext;
              pruned = yield* Effect.promise(() => pruneDependencies(decision, fresh));
              dependencies[pruned.result] += 1;
              if (pruned.result === "failed") run.failed += 1;
            }
          }
          yield* Console.log(dependencyLine(prune, pruned, flags.apply, flags.json));
        }

        const removable = run.decisions.filter((decision) => decision.action === "remove").length;
        const kept: Record<string, number> = {};
        for (const decision of run.decisions)
          if (decision.action !== "remove")
            kept[reasonKind(decision.reason)] = (kept[reasonKind(decision.reason)] ?? 0) + 1;
        if (flags.json)
          yield* Console.log(
            // @effect-diagnostics-next-line preferSchemaOverJson:off - one output line, like `scratch prune --json`.
            JSON.stringify({
              kind: "summary",
              applied: flags.apply,
              graceMinutes: graceMs / 60_000,
              candidates: run.decisions.length,
              removable,
              removed: run.removed,
              skipped: run.skipped,
              failed: run.failed,
              kept,
              dependenciesPrunable: dependencies.prunable,
              dependenciesPruned: dependencies.pruned,
              dependenciesSkipped: dependencies.skipped,
              dependenciesFailed: dependencies.failed,
            }),
          );
        else
          yield* Console.log(
            [
              flags.apply
                ? `${run.removed} removed, ${run.skipped} skipped, ${run.failed} failed; ${run.decisions.length - removable} kept.`
                : `Dry run: ${removable} of ${run.decisions.length} would be removed. Pass --apply to remove them.`,
              ...(dependencies.prunable === 0
                ? []
                : [
                    flags.apply
                      ? `Dependency installs removed from ${dependencies.pruned} of ${dependencies.prunable} kept ${dependencies.prunable === 1 ? "copy" : "copies"} that had idle ones.`
                      : `Dependency installs would be removed from ${dependencies.prunable} kept ${dependencies.prunable === 1 ? "copy" : "copies"}.`,
                  ]),
              ...Object.entries(kept)
                .toSorted(([, left], [, right]) => right - left)
                .map(([reason, count]) => `  kept ${count}: ${reason}`),
            ].join("\n"),
          );
        if (run.failed > 0) process.exitCode = 1;
      },
      Effect.catchCause((cause) => {
        // Ctrl-C stays an interrupt, not a refusal.
        if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
        const error = Cause.squash(cause);
        return Console.error(
          `clones sweep: ${error instanceof Error ? error.message : String(error)}`,
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = progress.removed > 0 ? 1 : CLONES_SWEEP_REFUSED;
            }),
          ),
        );
      }),
    ),
  ),
);

/** How many clones this run has removed, for the exit code when it stops early. */
const progress = { removed: 0 };

export const clonesCommand = Command.make("clones").pipe(
  Command.withDescription(
    "Remove review and scratch clones of registered projects' repositories once their work is merged.",
  ),
  Command.withSubcommands([sweepCommand]),
);

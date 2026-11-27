// @effect-diagnostics nodeBuiltinImport:off - Reads SpecWeave's per-thread binding files, like ThreadIncrementProgress.
/**
 * The SpecWeave ledger writes (1497): claim, release and block, on the calling
 * thread's own increment only (ownership.ts), as the agent the thread's own
 * shell is (identity.ts).
 *
 * Each call folds the ledger first (`task list --json`) under a per-increment
 * lock, and writes only when the task is not already where the caller asked:
 * a retried claim, a repeated block with the same reason or a release of a
 * task nobody holds returns `changed: false` and appends nothing. A task held
 * by another agent is refused with the holder named. Two live threads in one
 * checkout can write as the same agent (two Claude threads on one machine, a
 * delegated child in its parent's checkout); then a hold under that id counts
 * as the caller's only with proof (holdOwner), and is refused otherwise. The CLI's own checks (earliest
 * live claim wins, Files overlap, unmet dependencies, template tasks) still
 * run on every write.
 *
 * Fixed argument lists, always `--no-commit` and `--json`, never `--force`,
 * `--all-mine` or `--run`: the CLI writes the ledger, metadata.json (and on a
 * planned-to-active move spec.md and `.specweave/state/active-increment.json`)
 * and SpecWeave's binding file for this thread, and nothing else. Every one of
 * those paths in the worktree is checked again under the lock, just before
 * the write (ownership.ts).
 */
import * as NodeFSP from "node:fs/promises";

import { OrchestratorMcpFailure, type ThreadId } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { specweaveStudioThreadBindingPath } from "../../../project/ThreadIncrementProgress.ts";
import * as IncrementProgress from "../../../project/ThreadIncrementProgressService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { runSpecweave, specweaveRunsWithoutShell, type SpecweaveRunResult } from "./cli.ts";
import { ledgerWriteEnvironment, specweaveToolForInstance } from "./identity.ts";
import { decideOwnership, recheckTarget, type LedgerTarget } from "./ownership.ts";

const WRITE_TIMEOUT = Duration.minutes(1);
/** Sibling threads whose binding files are read to name a holder; more is not a real checkout. */
const SIBLINGS_READ = 50;

const failure = (
  code: "capability_denied" | "invalid_request" | "thread_not_found",
  message: string,
) => new OrchestratorMcpFailure({ code, message });

/** One task as `task list --json` prints it. */
export interface FoldedTask {
  readonly id: string;
  readonly status: string;
  readonly by?: string | undefined;
  readonly since?: string | undefined;
  readonly note?: string | undefined;
}

export interface Folded {
  /** The agent id the CLI wrote the list as: who this call writes as. */
  readonly agent: string;
  readonly tasks: ReadonlyArray<FoldedTask>;
}

/** Reads `task list --json`; null when it is not the shape SpecWeave prints. */
export function foldedFromList(data: unknown): Folded | null {
  if (data === null || typeof data !== "object") return null;
  const { agent, tasks } = data as { readonly agent?: unknown; readonly tasks?: unknown };
  if (typeof agent !== "string" || agent.trim() === "" || !Array.isArray(tasks)) return null;
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  return {
    agent,
    tasks: tasks.flatMap((task: unknown) => {
      if (task === null || typeof task !== "object") return [];
      const entry = task as Record<string, unknown>;
      if (typeof entry.id !== "string" || typeof entry.status !== "string") return [];
      return [
        {
          id: entry.id,
          status: entry.status,
          by: text(entry.by),
          since: text(entry.since),
          note: text(entry.note),
        },
      ];
    }),
  };
}

export type LedgerAction = "claim" | "release" | "block";

/** What a call does, decided from the folded state before anything is written. */
export type LedgerPlan =
  | { readonly kind: "write" }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "refuse";
      readonly code: "capability_denied" | "invalid_request";
      readonly message: string;
    };

const HELD = new Set(["claimed", "blocked"]);

/** A block reason as it is written: one line, single spaces. */
export const normalizeReason = (reason: string | undefined) =>
  (reason ?? "").replace(/\s+/gu, " ").trim();

/**
 * Whether two block reasons are the same reason. SpecWeave fixes a reason's
 * spacing as it writes it (3.2 adds a space after `,` and `;`), so reasons
 * are compared with all whitespace removed.
 */
export const sameReason = (left: string | undefined, right: string | undefined) =>
  (left ?? "").replace(/\s+/gu, "") === (right ?? "").replace(/\s+/gu, "");

const describeHold = (task: FoldedTask) =>
  `${task.status} by ${task.by ?? "someone"}${task.since === undefined ? "" : ` since ${task.since}`}${task.status === "blocked" && task.note ? ` (${task.note})` : ""}`;

/**
 * Who among the threads in the caller's checkout holds a task held under the
 * caller's own agent id: the caller, a named thread, or nobody can tell.
 */
export type HoldOwner =
  | { readonly kind: "caller" }
  | { readonly kind: "thread"; readonly name: string }
  | { readonly kind: "unknown"; readonly names: ReadonlyArray<string> };

/** The decision table. `owner` matters only for a task held under the caller's agent id. */
export function planLedgerCall(input: {
  readonly action: LedgerAction;
  readonly task: FoldedTask;
  readonly agent: string;
  readonly reason?: string | undefined;
  readonly owner: HoldOwner;
}): LedgerPlan {
  const { action, task, agent } = input;
  if (action !== "release" && (task.status === "done" || task.status === "skipped")) {
    return {
      kind: "refuse",
      code: "invalid_request",
      message: `${task.id} is already ${task.status}${task.by ? ` by ${task.by}` : ""}; there is nothing to ${action}.`,
    };
  }
  if (
    action === "release" &&
    (task.status === "open" || task.status === "done" || task.status === "skipped")
  ) {
    return { kind: "unchanged" };
  }
  const mine = task.by === agent;
  // A stale claim of someone else's is takeable (the CLI's rule), but not releasable.
  const heldByOther =
    !mine && (HELD.has(task.status) || (action === "release" && task.status === "stale"));
  if (heldByOther) {
    return {
      kind: "refuse",
      code: "capability_denied",
      message: `${task.id} is held by another agent: ${describeHold(task)}. Pick another task, or ask its holder to release it.`,
    };
  }
  if (mine && HELD.has(task.status) && input.owner.kind === "thread") {
    return {
      kind: "refuse",
      code: "capability_denied",
      message: `${task.id} is held by another thread, ${input.owner.name}, which writes as the same agent (${agent}): ${describeHold(task)}. Pick another task, or ask that thread to release it.`,
    };
  }
  if (mine && HELD.has(task.status) && input.owner.kind === "unknown") {
    return {
      kind: "refuse",
      code: "capability_denied",
      message: `${task.id} is ${describeHold(task)}, this thread's agent id, but other threads work in this checkout under the same id (${input.owner.names.join(", ")}) and SpecWithCode cannot tell which of them took it. If it is this thread's, run \`specweave task ${input.action} ${task.id}\` in your shell; otherwise pick another task.`,
    };
  }
  if (action === "claim" && mine && task.status === "claimed") return { kind: "unchanged" };
  if (
    action === "block" &&
    mine &&
    task.status === "blocked" &&
    sameReason(task.note, input.reason)
  ) {
    return { kind: "unchanged" };
  }
  return { kind: "write" };
}

/** The fixed command line of one write. Only validated values reach it. */
export function ledgerWriteArgs(input: {
  readonly action: LedgerAction;
  readonly taskId: string;
  readonly incrementId: string;
  readonly reason?: string | undefined;
}): ReadonlyArray<string> {
  const base = ["task", input.action, input.taskId, input.incrementId];
  switch (input.action) {
    case "claim":
      return [...base, "--no-commit", "--json"];
    case "release":
      return [...base, "--no-commit", "--json"];
    case "block":
      // `=` keeps a reason that starts with a dash a value, not a flag.
      return [...base, `--reason=${normalizeReason(input.reason)}`, "--no-commit", "--json"];
  }
}

interface SiblingBinding {
  readonly root?: unknown;
  readonly incrementId?: unknown;
  readonly taskId?: unknown;
  readonly event?: unknown;
  readonly at?: unknown;
}

const readBinding = async (threadId: string, home: string | undefined) => {
  const text = await NodeFSP.readFile(
    specweaveStudioThreadBindingPath(threadId, home),
    "utf8",
  ).catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as SiblingBinding;
  } catch {
    return null;
  }
};

/** Whether a thread's binding file says its last SpecWeave write was this very claim or block. */
async function bindingNames(
  binding: SiblingBinding | null,
  target: LedgerTarget,
  task: FoldedTask,
): Promise<boolean> {
  if (
    binding === null ||
    binding.incrementId !== target.incrementId ||
    binding.taskId !== task.id ||
    (binding.event !== "claim" && binding.event !== "block") ||
    binding.at !== task.since ||
    typeof binding.root !== "string"
  ) {
    return false;
  }
  return (await NodeFSP.realpath(binding.root).catch(() => null)) === target.specweaveRoot;
}

/** Holds these tools wrote, by increment folder, task and time, so a retry knows its own. */
const writtenHolds = new Map<string, string>();
const WRITTEN_HOLDS_KEPT = 2_000;
const holdKey = (target: LedgerTarget, task: FoldedTask) =>
  `${target.incrementDir}\u0000${task.id}\u0000${task.since ?? ""}`;

/** Remembers that `threadId` wrote the hold `task` now shows. */
export function recordWrittenHold(target: LedgerTarget, task: FoldedTask, threadId: string): void {
  if (!HELD.has(task.status) || task.since === undefined) return;
  writtenHolds.set(holdKey(target, task), threadId);
  if (writtenHolds.size > WRITTEN_HOLDS_KEPT) {
    const oldest = writtenHolds.keys().next().value;
    if (oldest !== undefined) writtenHolds.delete(oldest);
  }
}

/**
 * Which thread holds a task held under the caller's agent id. With no other
 * live thread in the checkout it is the caller. Otherwise it needs proof:
 * these tools wrote that hold for a thread, or a thread's binding file names
 * it (it records only the thread's last write). Without proof nobody can tell,
 * and the call is refused rather than taking a sibling's task.
 */
export async function holdOwner(input: {
  readonly target: LedgerTarget;
  readonly task: FoldedTask;
  readonly callerThreadId: string;
  readonly siblings: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
  readonly home?: string;
}): Promise<HoldOwner> {
  if (input.siblings.length === 0) return { kind: "caller" };
  const named = (sibling: { readonly threadId: string; readonly title: string }) =>
    `"${sibling.title}" (${sibling.threadId})`;
  const writer = writtenHolds.get(holdKey(input.target, input.task));
  if (writer === input.callerThreadId) return { kind: "caller" };
  const written = input.siblings.find((sibling) => sibling.threadId === writer);
  if (written !== undefined) return { kind: "thread", name: named(written) };
  if (
    await bindingNames(
      await readBinding(input.callerThreadId, input.home),
      input.target,
      input.task,
    )
  ) {
    return { kind: "caller" };
  }
  for (const sibling of input.siblings) {
    if (
      await bindingNames(await readBinding(sibling.threadId, input.home), input.target, input.task)
    ) {
      return { kind: "thread", name: named(sibling) };
    }
  }
  return { kind: "unknown", names: input.siblings.map(named) };
}

/** The calling thread, its checkout's other live threads, and its write identity. */
const callerContext = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return yield* failure(
      "capability_denied",
      "SpecWeave write tools change a SpecWithCode thread's own increment; this caller is not a thread.",
    );
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) {
    return yield* failure("thread_not_found", "The calling thread was not found.");
  }
  const settings = yield* ServerSettings.ServerSettingsService;
  const instanceId = scope.thread.providerInstanceId;
  const identity = yield* settings.getSettings.pipe(
    Effect.map((value) => ({
      tool: specweaveToolForInstance(value, instanceId),
      instanceEnvironment: value.providerInstances[instanceId]?.environment,
    })),
    Effect.orElseSucceed(() => ({ tool: null, instanceEnvironment: undefined })),
  );
  const tool = identity.tool;
  if (tool === null) {
    return yield* failure(
      "capability_denied",
      `SpecWithCode does not know which SpecWeave agent this thread's provider (${scope.thread.providerInstanceId}) writes as, so it will not write for it. Use \`specweave task claim|release|block\` in your shell instead.`,
    );
  }
  return {
    threadId: scope.thread.threadId,
    shell,
    tool,
    instanceEnvironment: identity.instanceEnvironment,
  };
});

const realPathOrNull = (path: string) => NodeFSP.realpath(path).catch(() => null);

/**
 * The project's other live threads in the caller's checkout, by recorded or
 * real path. When the list cannot be read the call is refused: an empty list
 * would make every hold under the caller's agent id look like its own.
 */
const siblingThreadsOf = (input: {
  readonly projectId: string;
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
  readonly workspace: string;
}) =>
  Effect.gen(function* () {
    if (input.worktreePath === null) return [];
    const threads = yield* ThreadManagement.ThreadManagementService;
    const all = yield* threads
      .listProjectThreads({ projectId: input.projectId as never, includeSubagents: true })
      .pipe(
        Effect.mapError(() =>
          failure(
            "capability_denied",
            "SpecWithCode could not list the other threads in this checkout, so it cannot tell whose hold is whose. Try again, or use `specweave task claim|release|block` in your shell.",
          ),
        ),
      );
    const candidates = all.filter(
      (thread) =>
        thread.id !== input.threadId && thread.deletedAt === null && thread.worktreePath !== null,
    );
    // Real paths, read once per recorded path: an alias of the checkout counts too.
    const recorded = [...new Set(candidates.map((thread) => thread.worktreePath!))];
    const reals = yield* Effect.forEach(
      recorded,
      (path) =>
        path === input.worktreePath
          ? Effect.succeed(input.workspace)
          : Effect.promise(() => realPathOrNull(path)),
      { concurrency: 8 },
    );
    const sharing = new Set(recorded.filter((_, index) => reals[index] === input.workspace));
    const same = candidates.map((thread) => sharing.has(thread.worktreePath!));
    return candidates
      .filter((_, index) => same[index])
      .slice(0, SIBLINGS_READ)
      .map((thread) => ({ threadId: thread.id as string, title: thread.title }));
  });

/** One lock per increment folder, for this server's lifetime. */
const locks = new Map<string, Semaphore.Semaphore>();
const lockFor = (key: string) => {
  let lock = locks.get(key);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(key, lock);
  }
  return lock;
};

const cliWords = (run: SpecweaveRunResult) => run.text.trim() || `specweave exited ${run.exitCode}`;

/** Runs one claim, release or block for the calling thread. */
export const runLedgerCall = Effect.fn("specweaveTools.ledger")(function* (input: {
  readonly action: LedgerAction;
  readonly increment: string;
  readonly task: string;
  readonly reason?: string | undefined;
  readonly folder?: string | undefined;
}) {
  const caller = yield* callerContext;
  const progress = yield* IncrementProgress.ThreadIncrementProgressService;
  const snapshot = yield* progress
    .read({ projectId: caller.shell.projectId, threadIds: [caller.threadId] })
    .pipe(Effect.orElseSucceed(() => null));
  const bound = snapshot?.threads.find((entry) => entry.threadId === caller.threadId);
  const owned = yield* Effect.promise(() =>
    decideOwnership({
      worktreePath: caller.shell.worktreePath,
      branch: caller.shell.branch,
      folder: input.folder,
      requested: input.increment,
      bound,
    }),
  );
  if (!owned.ok) return yield* failure(owned.code, owned.message);
  const target = owned.target;
  if (!(yield* specweaveRunsWithoutShell())) {
    return yield* failure(
      "capability_denied",
      "The specweave command on this machine is a .cmd or .bat script, which runs through cmd.exe, and SpecWeave write tools never start a shell. Use `specweave task claim|release|block` in your shell instead.",
    );
  }
  const writeAs = ledgerWriteEnvironment({
    threadId: caller.threadId,
    tool: caller.tool,
    instanceEnvironment: caller.instanceEnvironment,
  });
  const run = (args: ReadonlyArray<string>) =>
    runSpecweave({ specweaveRoot: target.specweaveRoot, args, timeout: WRITE_TIMEOUT, writeAs });
  const fold = Effect.gen(function* () {
    const listed = yield* run(["task", "list", target.incrementId, "--json"]);
    const folded = listed.ok ? foldedFromList(listed.data) : null;
    if (folded === null) {
      return yield* failure(
        "invalid_request",
        `Could not read the tasks of ${target.incrementId}: ${cliWords(listed)}`,
      );
    }
    return folded;
  });
  const siblings = yield* siblingThreadsOf({
    projectId: caller.shell.projectId,
    threadId: caller.threadId,
    worktreePath: caller.shell.worktreePath,
    workspace: target.workspace,
  });

  return yield* lockFor(target.incrementDir).withPermit(
    Effect.gen(function* () {
      const before = yield* fold;
      const task = before.tasks.find((entry) => entry.id === input.task);
      if (task === undefined) {
        return yield* failure(
          "invalid_request",
          `Task ${input.task} is not in ${target.incrementId}. Its tasks: ${before.tasks.map((entry) => entry.id).join(", ") || "none"}.`,
        );
      }
      const owner: HoldOwner =
        task.by === before.agent && HELD.has(task.status)
          ? yield* Effect.promise(() =>
              holdOwner({ target, task, callerThreadId: caller.threadId, siblings }),
            )
          : { kind: "caller" };
      const plan = planLedgerCall({
        action: input.action,
        task,
        agent: before.agent,
        reason: input.reason,
        owner,
      });
      if (plan.kind === "refuse") return yield* failure(plan.code, plan.message);
      let command: string | null = null;
      let text = "";
      if (plan.kind === "write") {
        const checked = yield* Effect.promise(() => recheckTarget(target));
        if (!checked.ok) return yield* failure(checked.code, checked.message);
        const wrote = yield* run(
          ledgerWriteArgs({
            action: input.action,
            taskId: task.id,
            incrementId: target.incrementId,
            reason: input.reason,
          }),
        );
        if (!wrote.ok) {
          // 3: lost the race to another claim; anything else is the CLI's own refusal.
          return yield* failure(
            wrote.exitCode === 3 ? "capability_denied" : "invalid_request",
            `${input.action} of ${task.id} was refused: ${cliWords(wrote)}`,
          );
        }
        command = wrote.command;
        text = wrote.text;
      }
      const after = plan.kind === "write" ? yield* fold : before;
      const now = after.tasks.find((entry) => entry.id === task.id) ?? task;
      if (plan.kind === "write" && now.by === before.agent) {
        recordWrittenHold(target, now, caller.threadId);
      }
      return {
        changed: plan.kind === "write",
        increment: target.incrementId,
        task: task.id,
        status: now.status,
        by: now.by ?? null,
        agent: before.agent,
        command,
        workspace: target.specweaveRoot,
        text:
          text ||
          (plan.kind === "write"
            ? ""
            : `${task.id} is already ${now.status}${now.by ? ` by ${now.by}` : ""}; nothing was written.`),
      };
    }),
  );
});

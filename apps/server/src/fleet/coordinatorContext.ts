/**
 * What a coordinator handoff carries. A project whose transcripts all fit moves
 * them as before; a larger one carries the coordinator's newest history, a
 * summary of each worker chat, and counts of what stayed where it was written.
 */
import {
  MACHINE_HANDOFF_MAX_BYTES,
  MACHINE_HANDOFF_RETENTION_MAX_MACHINES,
  MACHINE_HANDOFF_RETENTION_MAX_SEGMENTS,
  MACHINE_HANDOFF_SUMMARY_MAX_WORKERS,
  MachineHandoffContext,
  type EnvironmentId,
  type MachineHandoffBundle,
  type MachineHandoffRetentionSegment,
  type MachineHandoffUnmergedWorker,
  type MachineHandoffWorkerSummary,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { stringifyJson } from "../json.ts";
import type { ProjectionRecords } from "../orchestration-v2/ProjectionStore.ts";
import { contextWithinLimits } from "./handoffBundle.ts";

export type ContextThread = MachineHandoffContext["threads"][number];
type ContextMessage = ContextThread["messages"][number];
type ContextBase = Omit<MachineHandoffContext, "threads" | "retention">;
type Records = ProjectionRecords<"messages" | "runs">;

const MAX_THREADS = 100;
const MAX_MESSAGES = 2000;
/** Worker summaries take at most this much of the 2 MiB, so the coordinator keeps the rest. */
export const SUMMARY_BUDGET = 256 * 1024;
/** Workers whose code is not in the published commits take at most this much. */
export const UNMERGED_BUDGET = 64 * 1024;
/** Slack for the JSON around the measured parts. */
const HEADROOM = 16 * 1024;
/** A newest message too large to fit is shortened to at most this. */
const SHORTENED_MAX = 256 * 1024;
const EXCERPT = 280;
const TITLE = 200;
const NOTE = 2000;

const terminal = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const isHandoffContext = Schema.is(MachineHandoffContext);
const bytes = (value: unknown) => Buffer.byteLength(stringifyJson(value));
const key = (environmentId: string | undefined, threadId: string) =>
  stringifyJson([environmentId, threadId]);
/** A prefix that never ends inside a surrogate pair. */
const clip = (text: string, max: number) => {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
};

/** A run still going or a message still streaming: the chat cannot move yet. */
export const recordsBusy = (records: Records) =>
  records.runs.some((run) => !terminal.has(run.status)) ||
  records.messages.some((message) => message.streaming);

/** One chat's whole transcript, as a full handoff carries it. */
export function contextThread(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly coordinatorId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell;
  readonly records: Records;
}): ContextThread {
  const { thread, records } = input;
  return {
    environmentId: input.environmentId,
    projectId: input.projectId,
    ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
    threadId: thread.id,
    title: thread.title,
    branch: thread.branch ?? null,
    worktreePath: thread.worktreePath ?? null,
    kind: thread.id === input.coordinatorId ? ("coordinator" as const) : ("worker" as const),
    messages: records.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        ...(() => {
          const run = records.runs.find((r) => r.userMessageId === m.id || r.id === m.runId);
          return run?.modelSelection ? { runId: run.id, modelSelection: run.modelSelection } : {};
        })(),
        id: m.id,
        role: m.role as "user" | "assistant",
        text: m.text,
        createdAt: DateTime.formatIso(m.createdAt),
      })),
  };
}

/**
 * Every transcript, with the segments an earlier handoff left on this host;
 * threads read now replace the same chat from that bundle.
 */
export function fullContext(
  base: ContextBase,
  earlier: MachineHandoffBundle | null,
  threads: ReadonlyArray<ContextThread>,
): MachineHandoffContext {
  const segments = new Map<string, ContextThread>();
  for (const thread of earlier?.context.threads ?? [])
    segments.set(
      key(thread.environmentId ?? earlier?.sourceEnvironmentId, thread.threadId),
      thread,
    );
  for (const thread of threads) segments.set(key(thread.environmentId, thread.threadId), thread);
  return {
    ...base,
    threads: [...segments.values()],
    // A worker handoff keeps what an earlier coordinator handoff said stayed behind.
    ...(earlier?.context.retention ? { retention: earlier.context.retention } : {}),
  };
}

const excerpt = (role: "user" | "assistant", text: string, createdAt: string) => ({
  role,
  text: clip(text, EXCERPT),
  createdAt,
  truncated: text.length > EXCERPT,
});

/** Active before archived, most recent first, then by id. */
export const byRecency = (a: OrchestrationV2ThreadShell, b: OrchestrationV2ThreadShell) =>
  Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
  DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The worker chats a large handoff names, from the shell snapshot alone (no
 * transcript is read): active before archived, most recent first, then by id.
 */
export function workerSummaries(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  environmentId: EnvironmentId,
): MachineHandoffWorkerSummary[] {
  return [...threads].sort(byRecency).map((thread) => {
    const latest = thread.latestVisibleMessage;
    return {
      environmentId,
      threadId: thread.id,
      title: clip(thread.title, TITLE),
      // A summary never fails the handoff: a value too long to carry is left out.
      branch: thread.branch && thread.branch.length <= 1024 ? thread.branch : null,
      worktreePath:
        thread.worktreePath && thread.worktreePath.length <= 4096 ? thread.worktreePath : null,
      status: clip(thread.status, 32),
      archived: thread.archivedAt !== null,
      lastActivityAt: DateTime.formatIso(thread.updatedAt),
      ...(latest && (latest.role === "user" || latest.role === "assistant")
        ? {
            lastMessage: excerpt(latest.role, latest.text, DateTime.formatIso(latest.updatedAt)),
          }
        : {}),
    };
  });
}

/** A worker an earlier bundle carried in full becomes a summary here. */
const inheritedWorker = (
  thread: ContextThread,
  environmentId: EnvironmentId | undefined,
): MachineHandoffWorkerSummary => {
  const last = thread.messages.at(-1);
  return {
    ...(environmentId ? { environmentId } : {}),
    threadId: thread.threadId,
    title: clip(thread.title, TITLE),
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    status: "unknown",
    archived: false,
    lastActivityAt: last?.createdAt ?? "",
    ...(last ? { lastMessage: excerpt(last.role, last.text, last.createdAt) } : {}),
  };
};

/** The newest message cut to `available` serialized bytes, or null when not even its frame fits. */
function shorten(message: ContextMessage, available: number): ContextMessage | null {
  const total = Buffer.byteLength(message.text);
  const marker = (n: number) =>
    `\n[... ${n} more bytes of this message stay on the source machine]`;
  const fits = (length: number) =>
    bytes({ ...message, text: message.text.slice(0, length) + marker(total) }) + 1 <= available;
  if (!fits(0)) return null;
  let low = 0;
  let high = message.text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  const kept = clip(message.text, low);
  return { ...message, text: kept + marker(total - Buffer.byteLength(kept)) };
}

const note = (counts: {
  readonly carried: number;
  readonly onHost: number;
  readonly total: number;
  readonly omitted: number;
  readonly summarized: number;
  readonly totalThreads: number;
  readonly omittedThreads: number;
  readonly truncated: boolean;
}) =>
  clip(
    `This handoff carries the coordinator's latest ${counts.carried} of ${counts.onHost} messages ` +
      `on this machine` +
      (counts.onHost < counts.total ? ` (${counts.total} in all)` : "") +
      `; ${counts.omitted} older messages stay on the machines they were written on. ` +
      `Worker chats did not move: ${counts.summarized} of ${counts.totalThreads} are summarized under ` +
      `retention.workers (title, branch, status, last activity, last message), and the other ` +
      `${counts.omittedThreads} stay on their machines with their full history. Worker branches and ` +
      `worktrees exist here only if the copy or the published commits include them. Open the project ` +
      `on the source machine to read a worker's full history.` +
      (counts.truncated
        ? " The newest message was shortened to fit; its full text stays on the source."
        : ""),
    NOTE,
  );

type MachineCounts = { totalThreads: number; omittedThreads: number; omittedMessages: number };

/**
 * A coordinator handoff too large to carry every transcript. Messages are kept
 * newest first by time as one unbroken run back from the latest, across the
 * current coordinator and every coordinator segment an earlier handoff left here
 * (after a round trip they interleave), then regrouped into their segments;
 * workers travel as summaries. The coordinator's share is fixed (any summaries
 * get all of SUMMARY_BUDGET, counts are framed at their widest), so a worker
 * changing between a preview and its publish never moves the cut. Live chats on
 * this machine replace whatever an earlier retention said about it. Null when
 * even this does not fit.
 */
export function fitCoordinatorContext(input: {
  readonly base: ContextBase;
  readonly coordinator: ContextThread;
  readonly workers: ReadonlyArray<MachineHandoffWorkerSummary>;
  readonly earlier: MachineHandoffBundle | null;
}): MachineHandoffContext | null {
  const { base, coordinator, earlier } = input;
  const earlierEnvironment = earlier?.sourceEnvironmentId;
  const here = coordinator.environmentId ?? earlierEnvironment;
  const previous = earlier?.context.retention;
  const currentKey = key(coordinator.environmentId, coordinator.threadId);
  const inherited = (earlier?.context.threads ?? []).filter(
    (t) =>
      t.kind === "coordinator" &&
      key(t.environmentId ?? earlierEnvironment, t.threadId) !== currentKey,
  );
  // What the earlier retention left on other machines. This machine's chats are counted live,
  // and so is the live coordinator's whole history, so only its own share of this machine's
  // omitted messages is taken out; those of a coordinator it replaced still stay here. A
  // retention without per-chat counts can only tell whether it carried the live coordinator.
  const previousSegments = new Map(
    (previous?.segments ?? []).map((s) => [key(s.environmentId, s.threadId), s.omittedMessages]),
  );
  const carriedLive = (earlier?.context.threads ?? []).some(
    (t) =>
      t.kind === "coordinator" &&
      key(t.environmentId ?? earlierEnvironment, t.threadId) === currentKey,
  );
  const perChat = previous === undefined || previous.segments !== undefined;
  const leftHere = (omitted: number) =>
    previous?.segments
      ? Math.max(0, omitted - (previousSegments.get(currentKey) ?? 0))
      : carriedLive
        ? 0
        : omitted;
  const elsewhere = new Map<string, MachineCounts>();
  const previousMachines =
    previous?.machines ??
    (previous && earlierEnvironment
      ? [
          {
            environmentId: earlierEnvironment,
            totalThreads: previous.totalThreads,
            omittedThreads: previous.omittedThreads,
            omittedMessages: previous.omittedMessages,
          },
        ]
      : []);
  for (const machine of previousMachines)
    if (machine.environmentId !== here)
      elsewhere.set(machine.environmentId, {
        totalThreads: 0,
        omittedThreads: machine.omittedThreads,
        omittedMessages: machine.omittedMessages,
      });
    else if (leftHere(machine.omittedMessages) > 0)
      elsewhere.set(machine.environmentId, {
        totalThreads: 0,
        omittedThreads: 0,
        omittedMessages: leftHere(machine.omittedMessages),
      });
  const known = new Map<string, MachineHandoffWorkerSummary>();
  for (const worker of [
    ...input.workers,
    ...[
      ...(earlier?.context.threads ?? [])
        .filter((t) => t.kind === "worker")
        .map((t) => inheritedWorker(t, t.environmentId ?? earlierEnvironment)),
      ...(previous?.workers ?? []),
    ].filter((w) => (w.environmentId ?? earlierEnvironment) !== here),
  ]) {
    const id = key(worker.environmentId ?? earlierEnvironment, worker.threadId);
    if (id !== currentKey && !known.has(id)) known.set(id, worker);
  }
  const workers: MachineHandoffWorkerSummary[] = [];
  let workerBytes = 0;
  for (const worker of known.values()) {
    const cost = bytes(worker) + 1;
    if (
      workers.length >= MACHINE_HANDOFF_SUMMARY_MAX_WORKERS ||
      workerBytes + cost > SUMMARY_BUDGET
    )
      break;
    workers.push(worker);
    workerBytes += cost;
  }
  const earlierOmitted = [...elsewhere.values()];
  const totalThreads =
    known.size + earlierOmitted.reduce((sum, machine) => sum + machine.omittedThreads, 0);
  const onHost =
    coordinator.messages.length + inherited.reduce((sum, t) => sum + t.messages.length, 0);
  const total = onHost + earlierOmitted.reduce((sum, machine) => sum + machine.omittedMessages, 0);
  const environmentOf = (environmentId: EnvironmentId | undefined) =>
    environmentId ?? earlierEnvironment ?? here;
  const machineIds = [
    ...new Set([
      ...(here ? [here] : []),
      ...[
        ...elsewhere.keys(),
        ...[...known.values()].map((w) => environmentOf(w.environmentId)),
        ...inherited.map((t) => environmentOf(t.environmentId)),
      ]
        .filter((id): id is EnvironmentId => id !== undefined)
        .toSorted(),
    ]),
  ].slice(0, MACHINE_HANDOFF_RETENTION_MAX_MACHINES) as EnvironmentId[];
  const environmentOfSegment = (t: ContextThread) => environmentOf(t.environmentId) ?? here;
  // Each coordinator chat's omitted messages so far: an inherited chat's earlier count travels
  // on, the live one's is counted live, and a chat an earlier cut dropped keeps its entry.
  const segmentKeys = [
    currentKey,
    ...inherited.toReversed().map((t) => key(environmentOfSegment(t), t.threadId)),
    ...previousSegments.keys(),
  ];
  const segmentIds = [...new Set(segmentKeys)]
    .filter((id) => typeof (JSON.parse(id) as unknown[])[0] === "string")
    .slice(0, MACHINE_HANDOFF_RETENTION_MAX_SEGMENTS);
  const widest = Number.MAX_SAFE_INTEGER;
  const frame = bytes({
    ...base,
    notes: [],
    threads: [],
    retention: {
      note: "x".repeat(NOTE),
      coordinatorMessages: widest,
      omittedMessages: widest,
      truncatedMessages: 1,
      totalThreads: widest,
      workers: [],
      omittedThreads: widest,
      machines: machineIds.map((environmentId) => ({
        environmentId,
        totalThreads: widest,
        omittedThreads: widest,
        omittedMessages: widest,
      })),
      segments: segmentIds.map((id) => {
        const [environmentId, threadId] = JSON.parse(id) as [string, string];
        return { environmentId, threadId, omittedMessages: widest };
      }),
    },
  });
  // A project with no worker chat has nothing to summarize; a first one appearing is a real change.
  const reserved = known.size > 0 ? SUMMARY_BUDGET + UNMERGED_BUDGET : 0;
  let budget = MACHINE_HANDOFF_MAX_BYTES - frame - reserved - HEADROOM;
  // Every coordinator message on this host, newest first: segments overlap in time after a
  // round trip, so the cut runs across all of them. Ties go to the newer segment, then the later
  // message.
  const segments = [coordinator, ...inherited.toReversed()];
  const newestFirst = segments
    .flatMap((segment, rank) =>
      segment.messages.map((message, index) => ({ segment, rank, index, message })),
    )
    .map((entry) => ({ ...entry, at: Date.parse(entry.message.createdAt) || 0 }))
    .sort((a, b) => b.at - a.at || a.rank - b.rank || b.index - a.index);
  for (let attempt = 0; attempt < 4 && budget > 0; attempt += 1, budget = Math.floor(budget / 2)) {
    // The current coordinator always travels; an earlier segment only with a message kept.
    let remaining = budget - (bytes({ ...coordinator, messages: [] }) + 1);
    if (remaining < 0) continue;
    let truncated = 0;
    const picked = new Map<ContextThread, Map<number, ContextMessage>>([[coordinator, new Map()]]);
    let count = 0;
    for (const { segment, index, message } of newestFirst) {
      let chosen = picked.get(segment);
      const shell = chosen ? 0 : bytes({ ...segment, messages: [] }) + 1;
      // At most 100 segments and 2000 messages a segment travel; the run stops at either.
      if ((!chosen && picked.size >= MAX_THREADS) || (chosen?.size ?? 0) >= MAX_MESSAGES) break;
      const cost = bytes(message) + 1;
      if (shell + cost <= remaining) {
        if (!chosen) picked.set(segment, (chosen = new Map()));
        chosen.set(index, message);
        remaining -= shell + cost;
        count += 1;
        continue;
      }
      // The latest intent reaches the destination even when its text alone is too large.
      const shortened =
        count === 0 && shell <= remaining
          ? shorten(message, Math.min(remaining - shell, SHORTENED_MAX))
          : null;
      if (shortened) {
        if (!chosen) picked.set(segment, (chosen = new Map()));
        chosen.set(index, shortened);
        truncated = 1;
      }
      break;
    }
    // Kept messages go back into their segments, oldest segment first, in their own order.
    const kept = new Map<ContextThread, ContextThread>();
    for (const [segment, chosen] of picked)
      kept.set(segment, {
        ...segment,
        messages: segment.messages.flatMap((_, index) => {
          const value = chosen.get(index);
          return value ? [value] : [];
        }),
      });
    const threads = [...inherited, coordinator].flatMap((t) => {
      const value = kept.get(t);
      return value ? [value] : [];
    });
    const carried = threads.reduce((sum, t) => sum + t.messages.length, 0);
    const counts = {
      carried,
      onHost,
      total,
      omitted: total - carried,
      summarized: workers.length,
      totalThreads,
      omittedThreads: totalThreads - workers.length,
      truncated: truncated > 0,
    };
    const perMachine = new Map<string, MachineCounts>(
      machineIds.map((id) => [
        id,
        {
          totalThreads: 0,
          omittedThreads: elsewhere.get(id)?.omittedThreads ?? 0,
          omittedMessages: elsewhere.get(id)?.omittedMessages ?? 0,
        },
      ]),
    );
    const add = (environmentId: EnvironmentId | undefined, change: Partial<MachineCounts>) => {
      const entry = perMachine.get(environmentOf(environmentId) ?? "");
      if (!entry) return;
      entry.totalThreads += change.totalThreads ?? 0;
      entry.omittedThreads += change.omittedThreads ?? 0;
      entry.omittedMessages += change.omittedMessages ?? 0;
    };
    for (const entry of elsewhere.entries())
      perMachine.get(entry[0])!.totalThreads += entry[1].omittedThreads;
    const summarized = new Set(workers);
    for (const worker of known.values())
      add(worker.environmentId, {
        totalThreads: 1,
        omittedThreads: summarized.has(worker) ? 0 : 1,
      });
    for (const segment of [coordinator, ...inherited])
      add(segment.environmentId, {
        omittedMessages: segment.messages.length - (kept.get(segment)?.messages.length ?? 0),
      });
    const omittedBySegment = new Map<string, number>();
    for (const [id, omitted] of previousSegments)
      if (id !== currentKey) omittedBySegment.set(id, omitted);
    for (const segment of [coordinator, ...inherited.toReversed()]) {
      const id = key(environmentOfSegment(segment), segment.threadId);
      omittedBySegment.set(
        id,
        (omittedBySegment.get(id) ?? 0) +
          segment.messages.length -
          (kept.get(segment)?.messages.length ?? 0),
      );
    }
    const segmentCounts: MachineHandoffRetentionSegment[] = segmentIds.flatMap((id) => {
      const omitted = omittedBySegment.get(id) ?? 0;
      if (omitted === 0) return [];
      const [environmentId, threadId] = JSON.parse(id) as [EnvironmentId, ThreadId];
      return [{ environmentId, threadId, omittedMessages: omitted }];
    });
    const machines = machineIds.flatMap((environmentId, index) => {
      const entry = perMachine.get(environmentId)!;
      return index === 0 || entry.totalThreads > 0 || entry.omittedMessages > 0
        ? [{ environmentId, ...entry }]
        : [];
    });
    const result: MachineHandoffContext = {
      ...base,
      threads,
      retention: {
        note: note(counts),
        coordinatorMessages: carried,
        omittedMessages: counts.omitted,
        truncatedMessages: truncated,
        totalThreads,
        workers,
        omittedThreads: counts.omittedThreads,
        machines,
        // Counted only from a chain that counted them from its start: a retention without
        // them never said whose messages its machine counts held.
        ...(perChat ? { segments: segmentCounts } : {}),
      },
    };
    if (contextWithinLimits(result) && isHandoffContext(result)) return result;
  }
  return null;
}

/**
 * Names, in a summarized Git handoff, the source's workers whose branch or
 * worktree holds commits or changes the published heads do not include, or could
 * not be checked: newest first, as many as UNMERGED_BUDGET holds, with the count
 * of them all and a line in the note.
 */
export function withUnmergedWorkers(
  context: MachineHandoffContext,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  environmentId: EnvironmentId,
): MachineHandoffContext {
  const retention = context.retention;
  if (!retention) return context;
  const listed: MachineHandoffUnmergedWorker[] = [];
  let used = 0;
  for (const thread of [...threads].sort(byRecency)) {
    const entry = {
      environmentId,
      threadId: thread.id,
      title: clip(thread.title, TITLE),
      branch: thread.branch && thread.branch.length <= 1024 ? thread.branch : null,
      worktreePath:
        thread.worktreePath && thread.worktreePath.length <= 4096 ? thread.worktreePath : null,
    };
    const cost = bytes(entry) + 1;
    if (listed.length >= MACHINE_HANDOFF_SUMMARY_MAX_WORKERS || used + cost > UNMERGED_BUDGET)
      break;
    listed.push(entry);
    used += cost;
  }
  const count = threads.length;
  return {
    ...context,
    retention: {
      ...retention,
      ...(count > 0
        ? {
            note: clip(
              `${retention.note} ${count} worker ${count === 1 ? "chat has" : "chats have"} a ` +
                `branch or worktree on the source with commits or changes this handoff does not ` +
                `carry, or one it could not check, listed under retention.unmergedWorkers; that ` +
                `work stays only on the source until it is merged.`,
              NOTE,
            ),
          }
        : {}),
      unmergedWorkers: listed,
      unmergedWorkerCount: count,
    },
  };
}

/**
 * Whether a publish finds a worker with unmerged code that the reviewed preview did not count.
 * The preview records every such worker, not only the ones it listed, so a worker swapped for
 * another behind the list is caught whatever the count. A preview saved before that record
 * vouches only for the workers it named.
 */
export function newUnmergedWorkers(
  saved: {
    readonly bundle: { readonly context: MachineHandoffContext };
    readonly reviewedUnmerged?: ReadonlyArray<ThreadId> | undefined;
  },
  current: ReadonlyArray<OrchestrationV2ThreadShell>,
): boolean {
  const reviewed = new Set<string>(
    saved.reviewedUnmerged ??
      (saved.bundle.context.retention?.unmergedWorkers ?? []).map((w) => w.threadId),
  );
  return current.some((thread) => !reviewed.has(thread.id));
}

import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  MACHINE_HANDOFF_MAX_BYTES,
  MachineHandoffContext,
  ProjectId,
  ThreadId,
  type MachineHandoffBundle,
  type OrchestrationV2ThreadShell,
} from "@specweave-studio/contracts";
import { canonical, comparableContext, contextWithinLimits } from "./handoffBundle.ts";
import { stringifyJson } from "../json.ts";
import {
  type ContextThread,
  SUMMARY_BUDGET,
  fitCoordinatorContext,
  workerSummaries,
} from "./coordinatorContext.ts";

const env = EnvironmentId.make("source-env");
const base = { goal: "Ship 1145", instructions: "Keep it small", notes: [] };
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1) + minute * 60_000);
const coordinatorOf = (
  count: number,
  size = 1024,
  environmentId = env,
  start = 0,
): ContextThread => ({
  environmentId,
  projectId: ProjectId.make("p"),
  threadId: ThreadId.make("project-coordinator:p"),
  title: "Coordinator",
  branch: "main",
  worktreePath: null,
  kind: "coordinator",
  messages: Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: "x".repeat(size),
    createdAt: DateTime.formatIso(at(start + i)),
  })),
});
const shell = (
  index: number,
  overrides: Partial<Record<string, unknown>> = {},
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(`w${String(index).padStart(4, "0")}`),
    title: `Worker ${index}`,
    branch: `inc/${index}`,
    worktreePath: `/work/${index}`,
    status: "completed",
    updatedAt: at(index),
    archivedAt: null,
    latestVisibleMessage: {
      id: `w${index}-last`,
      role: "assistant",
      text: `Done ${index}`,
      updatedAt: at(index),
    },
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;
const isContext = Schema.is(MachineHandoffContext);
const bytes = (context: MachineHandoffContext) =>
  Buffer.byteLength(stringifyJson({ ...context, notes: [] }));

describe("fitCoordinatorContext", () => {
  it("keeps the newest unbroken run of 10,000 messages and summarizes 1,628 workers", () => {
    const workers = workerSummaries(
      Array.from({ length: 1628 }, (_, i) => shell(i)),
      env,
    );
    const result = fitCoordinatorContext({
      base,
      coordinator: coordinatorOf(10_000),
      workers,
      earlier: null,
    })!;
    expect(isContext(result)).toBe(true);
    expect(contextWithinLimits(result)).toBe(true);
    expect(bytes(result)).toBeLessThanOrEqual(MACHINE_HANDOFF_MAX_BYTES);
    const kept = result.threads[0]!.messages;
    expect(kept.length).toBeLessThanOrEqual(2000);
    expect(kept.at(-1)?.id).toBe("m9999");
    expect(kept.map((m) => m.id)).toEqual(
      Array.from({ length: kept.length }, (_, i) => `m${10_000 - kept.length + i}`),
    );
    const retention = result.retention!;
    expect(retention.coordinatorMessages + retention.omittedMessages).toBe(10_000);
    expect(retention.workers.length).toBeLessThanOrEqual(200);
    expect(retention.omittedThreads).toBe(1628 - retention.workers.length);
    expect(retention.totalThreads).toBe(1628);
  });
  it("stops worker summaries at the byte budget", () => {
    const workers = workerSummaries(
      Array.from({ length: 150 }, (_, i) =>
        shell(i, { worktreePath: "p".repeat(4000), branch: "b".repeat(1000) }),
      ),
      env,
    );
    const result = fitCoordinatorContext({
      base,
      coordinator: coordinatorOf(3),
      workers,
      earlier: null,
    })!;
    const summaryBytes = result.retention!.workers.reduce(
      (sum, w) => sum + Buffer.byteLength(stringifyJson(w)) + 1,
      0,
    );
    expect(result.retention!.workers.length).toBeLessThan(150);
    expect(summaryBytes).toBeLessThanOrEqual(SUMMARY_BUDGET);
    expect(result.retention!.omittedThreads).toBe(150 - result.retention!.workers.length);
  });
  it("shortens a newest message too large to fit, with a marker and a count", () => {
    const result = fitCoordinatorContext({
      base,
      coordinator: coordinatorOf(2, MACHINE_HANDOFF_MAX_BYTES),
      workers: [],
      earlier: null,
    })!;
    const [message] = result.threads[0]!.messages;
    expect(result.threads[0]!.messages).toHaveLength(1);
    expect(message?.id).toBe("m1");
    expect(message?.text).toMatch(
      /\n\[\.\.\. \d+ more bytes of this message stay on the source machine\]$/,
    );
    expect(Buffer.byteLength(message!.text)).toBeLessThanOrEqual(256 * 1024);
    expect(result.retention).toMatchObject({
      coordinatorMessages: 1,
      omittedMessages: 1,
      truncatedMessages: 1,
    });
    expect(contextWithinLimits(result) && isContext(result)).toBe(true);
  });
  it("drops a branch or worktree path longer than a bundle can carry", () => {
    const [summary] = workerSummaries(
      [shell(1, { branch: "b".repeat(1025), worktreePath: "p".repeat(4097) })],
      env,
    );
    expect(summary).toMatchObject({ branch: null, worktreePath: null });
  });
  it("orders workers active first, then newest, then by id, the same way every time", () => {
    const threads = [
      shell(5, { archivedAt: at(9), updatedAt: at(50) }),
      shell(2),
      shell(3, { updatedAt: at(2) }),
      shell(9),
    ];
    const first = workerSummaries(threads, env).map((w) => w.threadId);
    expect(first).toEqual(["w0009", "w0002", "w0003", "w0005"]);
    expect(workerSummaries([...threads].reverse(), env).map((w) => w.threadId)).toEqual(first);
    const input = {
      base,
      coordinator: coordinatorOf(2500),
      workers: workerSummaries(threads, env),
      earlier: null,
    };
    expect(canonical(fitCoordinatorContext(input))).toBe(canonical(fitCoordinatorContext(input)));
  });
  it("leaves out system messages, clips titles and marks clipped excerpts", () => {
    const [system, clipped] = workerSummaries(
      [
        shell(2, {
          latestVisibleMessage: { id: "s", role: "system", text: "hidden", updatedAt: at(2) },
        }),
        shell(1, {
          title: "t".repeat(500),
          latestVisibleMessage: { id: "a", role: "user", text: "z".repeat(400), updatedAt: at(1) },
        }),
      ],
      env,
    );
    expect(system?.lastMessage).toBeUndefined();
    expect(clipped?.title).toHaveLength(200);
    expect(clipped?.lastMessage).toMatchObject({ role: "user", truncated: true });
    expect(clipped?.lastMessage?.text).toHaveLength(280);
  });
  it("trims an inherited 1.9 MB segment after the current coordinator and adds up the chain", () => {
    const earlierEnv = EnvironmentId.make("earlier-env");
    const inheritedCoordinator = coordinatorOf(1800, 1024, earlierEnv);
    const inheritedWorker: ContextThread = {
      ...coordinatorOf(2, 10, earlierEnv),
      threadId: ThreadId.make("old-worker"),
      title: "Old worker",
      kind: "worker",
    };
    const earlier = {
      sourceEnvironmentId: earlierEnv,
      context: {
        ...base,
        threads: [inheritedCoordinator, inheritedWorker],
        retention: {
          note: "earlier",
          coordinatorMessages: 1800,
          omittedMessages: 700,
          truncatedMessages: 0,
          totalThreads: 9,
          workers: [
            {
              environmentId: EnvironmentId.make("first-env"),
              threadId: ThreadId.make("first-worker"),
              title: "First",
              branch: null,
              worktreePath: null,
              status: "completed",
              archived: false,
              lastActivityAt: "2026-09-01T00:00:00.000Z",
            },
          ],
          omittedThreads: 8,
        },
      },
    } as unknown as MachineHandoffBundle;
    // The current coordinator started after the earlier one handed off.
    const current = {
      ...coordinatorOf(1000, 1024, env, 2000),
      threadId: ThreadId.make("project-coordinator:next"),
    };
    const result = fitCoordinatorContext({
      base,
      coordinator: current,
      workers: workerSummaries([shell(1)], env),
      earlier,
    })!;
    expect(contextWithinLimits(result) && isContext(result)).toBe(true);
    const [older, newer] = result.threads;
    expect(newer?.messages).toHaveLength(1000);
    expect(older?.environmentId).toBe(earlierEnv);
    expect(older!.messages.length).toBeLessThan(1800);
    expect(older!.messages.at(-1)?.id).toBe("m1799");
    expect(result.retention!.workers.map((w) => w.threadId)).toEqual([
      "w0001",
      "old-worker",
      "first-worker",
    ]);
    expect(result.retention!.workers[1]).toMatchObject({
      environmentId: earlierEnv,
      status: "unknown",
      lastMessage: { createdAt: DateTime.formatIso(at(1)) },
    });
    expect(result.retention).toMatchObject({
      coordinatorMessages: 1000 + older!.messages.length,
      omittedMessages: 700 + 1800 - older!.messages.length,
      totalThreads: 3 + 8,
      omittedThreads: 8,
    });
  });
  it("keeps the same coordinator messages when worker summaries change before publish", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let run = 0; run < 20; run += 1) {
      const coordinator = coordinatorOf(1500);
      const messages = coordinator.messages.map((m) => ({
        ...m,
        text: "x".repeat(500 + (next() % 4000)),
      }));
      const threads = Array.from({ length: 300 }, (_, i) => shell(i));
      const preview = fitCoordinatorContext({
        base,
        coordinator: { ...coordinator, messages },
        workers: workerSummaries(threads, env),
        earlier: null,
      })!;
      const changed = [
        ...threads.slice(0, 299),
        shell(299, {
          title: "Renamed ".repeat(20),
          latestVisibleMessage: {
            id: "new",
            role: "assistant",
            text: "y".repeat(400),
            updatedAt: at(5000),
          },
          updatedAt: at(5000),
        }),
        ...Array.from({ length: 40 }, (_, i) => shell(1000 + i)),
      ];
      const publish = fitCoordinatorContext({
        base,
        coordinator: { ...coordinator, messages },
        workers: workerSummaries(changed, env),
        earlier: null,
      })!;
      expect(canonical(publish.retention)).not.toBe(canonical(preview.retention));
      expect(canonical(comparableContext(publish, preview))).toBe(canonical(preview));
    }
  });
  it("counts each chat and message once when a summarized coordinator comes back", () => {
    const m4 = EnvironmentId.make("m4");
    const ministorm = EnvironmentId.make("ministorm");
    const m4Workers = Array.from({ length: 1628 }, (_, i) => shell(i));
    const bundle = (sourceEnvironmentId: EnvironmentId, context: MachineHandoffContext) =>
      ({ sourceEnvironmentId, context }) as unknown as MachineHandoffBundle;
    const first = fitCoordinatorContext({
      base,
      coordinator: coordinatorOf(3000, 1024, m4),
      workers: workerSummaries(m4Workers, m4),
      earlier: null,
    })!;
    const there = {
      ...coordinatorOf(10, 100, ministorm),
      threadId: ThreadId.make("project-coordinator:ministorm"),
    };
    const ministormWorkers = [
      shell(9001, { updatedAt: at(9001) }),
      shell(9002, { updatedAt: at(9002) }),
    ];
    const second = fitCoordinatorContext({
      base,
      coordinator: there,
      workers: workerSummaries(ministormWorkers, ministorm),
      earlier: bundle(m4, first),
    })!;
    expect(second.retention).toMatchObject({ totalThreads: 1630 });
    expect(second.retention!.coordinatorMessages + second.retention!.omittedMessages).toBe(3010);
    expect(second.retention!.machines?.map((m) => m.environmentId)).toEqual([ministorm, m4]);
    const third = fitCoordinatorContext({
      base,
      coordinator: coordinatorOf(3005, 1024, m4),
      workers: workerSummaries(m4Workers, m4),
      earlier: bundle(ministorm, second),
    })!;
    const retention = third.retention!;
    expect(retention.totalThreads).toBe(1630);
    expect(retention.omittedThreads).toBe(1630 - retention.workers.length);
    expect(retention.coordinatorMessages + retention.omittedMessages).toBe(3015);
    expect(retention.machines?.[0]).toMatchObject({ environmentId: m4, totalThreads: 1628 });
    expect(retention.machines?.[1]).toMatchObject({
      environmentId: ministorm,
      totalThreads: 2,
      omittedMessages:
        10 - (third.threads.find((t) => t.environmentId === ministorm)?.messages.length ?? 0),
    });
    expect(retention.machines!.reduce((sum, m) => sum + m.omittedMessages, 0)).toBe(
      retention.omittedMessages,
    );
    expect(retention.machines!.reduce((sum, m) => sum + m.omittedThreads, 0)).toBe(
      retention.omittedThreads,
    );
  });
  it("cuts across every coordinator segment by time after a round trip", () => {
    const m4 = EnvironmentId.make("m4");
    const ministorm = EnvironmentId.make("ministorm");
    const bundle = (sourceEnvironmentId: EnvironmentId, context: MachineHandoffContext) =>
      ({ sourceEnvironmentId, context }) as unknown as MachineHandoffBundle;
    const before = coordinatorOf(3000, 1024, m4);
    const first = fitCoordinatorContext({ base, coordinator: before, workers: [], earlier: null })!;
    // Ministorm writes 10 messages after m2999; back on M4, the old thread gets 5 newer still.
    const there = {
      ...coordinatorOf(10, 1024, ministorm, 3000),
      threadId: ThreadId.make("project-coordinator:ministorm"),
      messages: coordinatorOf(10, 1024, ministorm, 3000).messages.map((m) => ({
        ...m,
        id: `ministorm-${m.id}`,
      })),
    };
    const second = fitCoordinatorContext({
      base,
      coordinator: there,
      workers: [],
      earlier: bundle(m4, first),
    })!;
    const back = {
      ...before,
      messages: [
        ...before.messages,
        ...coordinatorOf(5, 1024, m4, 3100).messages.map((m, i) => ({ ...m, id: `m${3000 + i}` })),
      ],
    };
    const third = fitCoordinatorContext({
      base,
      coordinator: back,
      workers: [],
      earlier: bundle(ministorm, second),
    })!;
    expect(contextWithinLimits(third) && isContext(third)).toBe(true);
    const visiting = third.threads.find((t) => t.environmentId === ministorm);
    expect(visiting?.messages.map((m) => m.id)).toEqual(there.messages.map((m) => m.id));
    expect(third.threads.at(-1)?.environmentId).toBe(m4);
    const home = third.threads.at(-1)!.messages;
    expect(home.slice(-5).map((m) => m.id)).toEqual(["m3000", "m3001", "m3002", "m3003", "m3004"]);
    // M4's older run is unbroken back from m2999.
    const older = home.slice(0, -5).map((m) => m.id);
    expect(older.at(-1)).toBe("m2999");
    expect(older).toEqual(
      Array.from({ length: older.length }, (_, i) => `m${3000 - older.length + i}`),
    );
    const retention = third.retention!;
    const carried = home.length + 10;
    expect(retention.coordinatorMessages).toBe(carried);
    expect(retention.coordinatorMessages + retention.omittedMessages).toBe(3015);
    expect(retention.note).toContain(`latest ${carried} of 3015 messages on this machine;`);
    expect(
      retention.machines?.find((m) => m.environmentId === ministorm)?.omittedMessages ?? 0,
    ).toBe(0);
  });
  it("still counts the messages a replaced coordinator left on this machine", () => {
    const m4 = EnvironmentId.make("m4");
    const ministorm = EnvironmentId.make("ministorm");
    const bundle = (sourceEnvironmentId: EnvironmentId, context: MachineHandoffContext) =>
      ({ sourceEnvironmentId, context }) as unknown as MachineHandoffBundle;
    const renamed = (thread: ContextThread, threadId: string): ContextThread => ({
      ...thread,
      threadId: ThreadId.make(threadId),
      messages: thread.messages.map((m) => ({ ...m, id: `${threadId}-${m.id}` })),
    });
    const first = fitCoordinatorContext({
      base,
      coordinator: coordinatorOf(3000, 1024, m4),
      workers: [],
      earlier: null,
    })!;
    const second = fitCoordinatorContext({
      base,
      coordinator: renamed(coordinatorOf(10, 1024, ministorm, 3000), "project-coordinator:b"),
      workers: [],
      earlier: bundle(m4, first),
    })!;
    expect(second.retention!.coordinatorMessages + second.retention!.omittedMessages).toBe(3010);
    // Back on M4 the project runs a new coordinator; the old thread keeps what never moved.
    const third = fitCoordinatorContext({
      base,
      coordinator: renamed(coordinatorOf(10, 1024, m4, 3100), "project-coordinator:a2"),
      workers: [],
      earlier: bundle(ministorm, second),
    })!;
    const retention = third.retention!;
    expect(retention.coordinatorMessages + retention.omittedMessages).toBe(3020);
    expect(retention.machines!.reduce((sum, m) => sum + m.omittedMessages, 0)).toBe(
      retention.omittedMessages,
    );
    expect(retention.machines?.[0]?.environmentId).toBe(m4);
    expect(retention.note).toContain(" (3020 in all); ");
    expect(retention.note).toContain(`; ${retention.omittedMessages} older messages stay`);
  });
  it("counts a coordinator once when a later cut dropped its whole segment", () => {
    const m4 = EnvironmentId.make("m4");
    const ministorm = EnvironmentId.make("ministorm");
    const bundle = (sourceEnvironmentId: EnvironmentId, context: MachineHandoffContext) =>
      ({ sourceEnvironmentId, context }) as unknown as MachineHandoffBundle;
    const a = coordinatorOf(3000, 1024, m4);
    const first = fitCoordinatorContext({ base, coordinator: a, workers: [], earlier: null })!;
    // Ministorm's 2,500 newer messages fill the budget, so M4's segment is dropped entirely.
    const b: ContextThread = {
      ...coordinatorOf(2500, 1024, ministorm, 5000),
      threadId: ThreadId.make("project-coordinator:b"),
    };
    const second = fitCoordinatorContext({
      base,
      coordinator: b,
      workers: [],
      earlier: bundle(m4, first),
    })!;
    expect(second.threads.map((t) => t.environmentId)).toEqual([ministorm]);
    expect(second.retention!.coordinatorMessages + second.retention!.omittedMessages).toBe(5500);
    const back = {
      ...a,
      messages: [
        ...a.messages,
        ...coordinatorOf(5, 1024, m4, 9000).messages.map((m, i) => ({ ...m, id: `m${3000 + i}` })),
      ],
    };
    const third = fitCoordinatorContext({
      base,
      coordinator: back,
      workers: [],
      earlier: bundle(ministorm, second),
    })!;
    const retention = third.retention!;
    expect(retention.coordinatorMessages + retention.omittedMessages).toBe(5505);
    expect(retention.machines!.reduce((sum, m) => sum + m.omittedMessages, 0)).toBe(
      retention.omittedMessages,
    );
    const onM4 = retention.machines!.find((m) => m.environmentId === m4)!.omittedMessages;
    expect(onM4).toBe(3005 - third.threads.find((t) => t.environmentId === m4)!.messages.length);
    expect(retention.note).toContain(" (5505 in all); ");
  });
  it("keeps a replaced coordinator's count when it and its replacement both come back", () => {
    const m4 = EnvironmentId.make("m4");
    const ministorm = EnvironmentId.make("ministorm");
    const bundle = (sourceEnvironmentId: EnvironmentId, context: MachineHandoffContext) =>
      ({ sourceEnvironmentId, context }) as unknown as MachineHandoffBundle;
    const named = (thread: ContextThread, threadId: string): ContextThread => ({
      ...thread,
      threadId: ThreadId.make(threadId),
      messages: thread.messages.map((m) => ({ ...m, id: `${threadId}-${m.id}` })),
    });
    const hop = (
      coordinator: ContextThread,
      from: EnvironmentId | null,
      earlier: MachineHandoffContext | null,
    ) =>
      fitCoordinatorContext({
        base,
        coordinator,
        workers: [],
        earlier: from && earlier ? bundle(from, earlier) : null,
      })!;
    const first = hop(named(coordinatorOf(3000, 1024, m4), "a"), null, null);
    const second = hop(named(coordinatorOf(10, 1024, ministorm, 3000), "b"), m4, first);
    const third = hop(named(coordinatorOf(10, 1024, m4, 3100), "a2"), ministorm, second);
    expect(third.retention!.coordinatorMessages + third.retention!.omittedMessages).toBe(3020);
    const fourth = hop(named(coordinatorOf(15, 1024, ministorm, 3000), "b"), m4, third);
    expect(fourth.retention!.coordinatorMessages + fourth.retention!.omittedMessages).toBe(3025);
    const fifth = hop(named(coordinatorOf(15, 1024, m4, 3100), "a2"), ministorm, fourth);
    const retention = fifth.retention!;
    expect(retention.coordinatorMessages + retention.omittedMessages).toBe(3030);
    expect(retention.machines!.reduce((sum, m) => sum + m.omittedMessages, 0)).toBe(
      retention.omittedMessages,
    );
    expect(retention.note).toContain(" (3030 in all); ");
  });
  it("keeps the whole-machine rule after a retention without per-chat counts", () => {
    const m4 = EnvironmentId.make("m4");
    const ministorm = EnvironmentId.make("ministorm");
    const bundle = (sourceEnvironmentId: EnvironmentId, context: MachineHandoffContext) =>
      ({ sourceEnvironmentId, context }) as unknown as MachineHandoffBundle;
    const a = coordinatorOf(3000, 1024, m4);
    const fitted = fitCoordinatorContext({ base, coordinator: a, workers: [], earlier: null })!;
    // A bundle from a build that did not count per chat.
    const { segments: _segments, ...older } = fitted.retention!;
    const first = { ...fitted, retention: older };
    const second = fitCoordinatorContext({
      base,
      coordinator: {
        ...coordinatorOf(3, 1024, ministorm, 3000),
        threadId: ThreadId.make("project-coordinator:b"),
      },
      workers: [],
      earlier: bundle(m4, first),
    })!;
    expect(second.retention!.segments).toBeUndefined();
    const third = fitCoordinatorContext({
      base,
      coordinator: {
        ...a,
        messages: [
          ...a.messages,
          ...coordinatorOf(5, 1024, m4, 3100).messages.map((m, i) => ({
            ...m,
            id: `m${3000 + i}`,
          })),
        ],
      },
      workers: [],
      earlier: bundle(ministorm, second),
    })!;
    const retention = third.retention!;
    expect(retention.coordinatorMessages + retention.omittedMessages).toBe(3008);
    expect(retention.machines!.reduce((sum, m) => sum + m.omittedMessages, 0)).toBe(
      retention.omittedMessages,
    );
  });
  it("leaves out an earlier segment none of whose messages fit", () => {
    const earlierEnv = EnvironmentId.make("earlier-env");
    const earlier = {
      sourceEnvironmentId: earlierEnv,
      context: { ...base, threads: [coordinatorOf(3, 1024, earlierEnv)] },
    } as unknown as MachineHandoffBundle;
    const result = fitCoordinatorContext({
      base,
      coordinator: {
        ...coordinatorOf(3000, 1024, env, 10),
        threadId: ThreadId.make("project-coordinator:next"),
      },
      workers: [],
      earlier,
    })!;
    expect(result.threads.map((t) => t.environmentId)).toEqual([env]);
    expect(result.retention!.coordinatorMessages + result.retention!.omittedMessages).toBe(3003);
  });
});

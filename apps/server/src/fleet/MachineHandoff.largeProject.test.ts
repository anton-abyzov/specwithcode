// @effect-diagnostics nodeBuiltinImport:off - reads the context file the destination retained.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  EnvironmentId,
  MACHINE_HANDOFF_MAX_BYTES,
  ProjectId,
  type MachineHandoffBundle,
} from "@specweave-studio/contracts";
import { stringifyJson } from "../json.ts";
import { checkBundle, contextWithinLimits } from "./handoffBundle.ts";
import { launchPrompt } from "./handoffLaunchPrompt.ts";
import * as MachineHandoff from "./MachineHandoff.ts";
import {
  imported,
  makeHarness,
  preview,
  id,
  projectId,
  threadId,
} from "./MachineHandoff.test-fixtures.ts";

const failureOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return result.failure;
      throw new Error("Expected request to fail");
    }),
  );
/** The live shape: 1,629 chats, a coordinator whose history alone is over 2 MiB. */
const large = () =>
  makeHarness({
    workers: 1200,
    archivedWorkers: 428,
    coordinatorMessages: 3000,
    messageBytes: 1024,
  });
const contextBytes = (bundle: MachineHandoffBundle) =>
  Buffer.byteLength(stringifyJson({ ...bundle.context, notes: [] }));

describe("coordinator handoff of a large project", () => {
  it.effect("fits 1,629 chats and 3 MB of history into one bundle (AC-01)", () => {
    const h = large();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const result = yield* service.prepare(preview);
      const { bundle } = result;
      expect(() => checkBundle(bundle)).not.toThrow();
      expect(contextWithinLimits(bundle.context)).toBe(true);
      expect(contextBytes(bundle)).toBeLessThanOrEqual(MACHINE_HANDOFF_MAX_BYTES);
      // Only the coordinator's transcript is read; workers come from the shell snapshot.
      expect(h.state.recordReads).toEqual([threadId]);
      const [coordinator, ...others] = bundle.context.threads;
      expect(others).toHaveLength(0);
      expect(coordinator?.kind).toBe("coordinator");
      const kept = coordinator!.messages;
      expect(kept.length).toBeGreaterThan(1000);
      expect(kept.length).toBeLessThan(3000);
      // One unbroken run back from the newest message, oldest first.
      expect(kept.at(-1)?.id).toBe("message3000");
      expect(kept.map((m) => m.id)).toEqual(
        Array.from({ length: kept.length }, (_, i) => `message${3000 - kept.length + i + 1}`),
      );
      const retention = bundle.context.retention!;
      expect(retention.coordinatorMessages).toBe(kept.length);
      expect(retention.coordinatorMessages + retention.omittedMessages).toBe(3000);
      expect(retention.truncatedMessages).toBe(0);
      expect(retention.totalThreads).toBe(1628);
      expect(retention.workers).toHaveLength(200);
      expect(retention.omittedThreads).toBe(1428);
      // Active before archived, most recent first.
      expect(retention.workers[0]).toMatchObject({
        threadId: "worker-1199",
        environmentId: "source-env",
        title: "Worker 1199",
        branch: "inc/worker-1199",
        status: "completed",
        archived: false,
        lastMessage: { role: "assistant", truncated: true },
      });
      expect(retention.workers.every((w) => !w.archived)).toBe(true);
      expect(retention.note).toContain(`latest ${kept.length} of 3000 messages`);
      expect(retention.note).toContain("200 of 1628 are summarized");
      expect(result.messageCount).toBe(kept.length);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("publishes the previewed summary unchanged and reports every worker's code", () => {
    const h = large();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      const published = yield* service.prepare({
        ...preview,
        publish: true,
        expectedDigest: first.bundle.digest,
        contextRetention: 1,
      });
      expect(published.publication).toBe("published");
      // Publishing re-signs the fenced binding; the context itself is the one previewed.
      expect(published.bundle.context).toEqual(first.bundle.context);
      // Git mode verifies the carried coordinator and reports on all 1,628 workers without refusing.
      expect(h.state.checkpointWorkers.length).toBeGreaterThan(0);
      expect(h.state.checkpointWorkers.every((count) => count === 1)).toBe(true);
      expect(h.state.reportedWorkers).toEqual([1628, 1628]);
      expect(published.bundle.context.retention).toMatchObject({
        unmergedWorkers: [],
        unmergedWorkerCount: 0,
      });
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("names workers whose branch the published commits lack, and the note says so", () => {
    const h = large();
    h.state.unmergedBranches = ["inc/worker-3", "inc/worker-1100"];
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      const retention = first.bundle.context.retention!;
      expect(() => checkBundle(first.bundle)).not.toThrow();
      // Newest first, like the summaries, and each one named in full.
      expect(retention.unmergedWorkers).toEqual([
        expect.objectContaining({
          environmentId: "source-env",
          threadId: "worker-1100",
          branch: "inc/worker-1100",
        }),
        expect.objectContaining({ threadId: "worker-3", branch: "inc/worker-3" }),
        expect.objectContaining({ threadId: "worker-archived-3", branch: "inc/worker-3" }),
      ]);
      expect(retention.unmergedWorkerCount).toBe(3);
      expect(retention.note).toContain("3 worker chats have a branch or worktree on the source");
      const published = yield* service.prepare({
        ...preview,
        publish: true,
        expectedDigest: first.bundle.digest,
        contextRetention: 1,
      });
      expect(published.publication).toBe("published");
      expect(published.bundle.context.retention).toEqual(retention);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses a publish when a worker behind a full list swaps in at the same count", () => {
    const h = large();
    const branches = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => `inc/worker-${from + i}`);
    h.state.unmergedBranches = branches(900, 1150);
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      const retention = first.bundle.context.retention!;
      expect(retention.unmergedWorkerCount).toBe(250);
      expect(retention.unmergedWorkers).toHaveLength(200);
      expect(retention.unmergedWorkers?.some((w) => w.threadId === "worker-1149")).toBe(true);
      // A listed worker is merged and one the review never counted gains a commit.
      h.state.unmergedBranches = [...branches(900, 1149), "inc/worker-500"];
      const publish = {
        ...preview,
        publish: true,
        expectedDigest: first.bundle.digest,
        contextRetention: 1 as const,
      };
      expect((yield* failureOnly(service.prepare(publish))).code).toBe("source_changed");
      // Fewer of them in all still does not hide a new one.
      h.state.unmergedBranches = [...branches(900, 1140), "inc/worker-500"];
      expect((yield* failureOnly(service.prepare(publish))).code).toBe("source_changed");
      expect(h.state.publicationFenceStates).toHaveLength(0);
      // Merging reviewed workers, listed or not, is fine.
      h.state.unmergedBranches = branches(910, 1140);
      expect((yield* service.prepare(publish)).publication).toBe("published");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("refuses to publish when a worker gained unmerged code after the review", () => {
    const h = large();
    h.state.unmergedBranches = ["inc/worker-3"];
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      h.state.unmergedBranches = ["inc/worker-3", "inc/worker-7"];
      const error = yield* failureOnly(
        service.prepare({
          ...preview,
          publish: true,
          expectedDigest: first.bundle.digest,
          contextRetention: 1,
        }),
      );
      expect(error.code).toBe("source_changed");
      expect(h.state.publicationFenceStates).toHaveLength(0);
      // Merging a reviewed one before publishing is fine.
      h.state.unmergedBranches = [];
      const published = yield* service.prepare({
        ...preview,
        publish: true,
        expectedDigest: first.bundle.digest,
        contextRetention: 1,
      });
      expect(published.publication).toBe("published");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect(
    "gives the destination coordinator its history, the workers and the counts (AC-02)",
    () => {
      const h = large();
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const bundle = imported((yield* service.prepare(preview)).bundle);
        const started = yield* service.receive({
          projectId,
          operationId: id,
          bundle,
          mode: "start",
        });
        expect(started.phase).toBe("started");
        const { contextPath, workspacePath } = started;
        if (contextPath === null || workspacePath === null) throw new Error("No retained context");
        // The launch prompt is the same text as any handoff; the context file explains the rest.
        expect(h.state.starts[0]?.prompt).toBe(launchPrompt(id, contextPath, workspacePath));
        const retained = JSON.parse(NodeFS.readFileSync(contextPath, "utf8"));
        expect(retained.context.retention).toEqual(bundle.context.retention);
        expect(retained.context.retention.note).toContain(
          "stay on the machines they were written on",
        );
        expect(retained.context.retention.workers).toHaveLength(200);
        expect(retained.context.threads[0].messages.at(-1).id).toBe("message3000");
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect(
    "refuses, before fencing, a publish that never confirmed the destination reads it",
    () => {
      const h = large();
      return Effect.gen(function* () {
        const service = yield* MachineHandoff.MachineHandoff;
        const first = yield* service.prepare(preview);
        // An older client publishes without saying the destination advertised contextRetention.
        const error = yield* failureOnly(
          service.prepare({ ...preview, publish: true, expectedDigest: first.bundle.digest }),
        );
        expect(error.code).toBe("too_large");
        expect(h.state.publicationFenceStates).toHaveLength(0);
        expect(
          h.projects.get(projectId)?.workspaceSettings?.coordinatorBinding?.state ?? "unfenced",
        ).not.toBe("transferring");
        const published = yield* service.prepare({
          ...preview,
          publish: true,
          expectedDigest: first.bundle.digest,
          contextRetention: 1,
        });
        expect(published.publication).toBe("published");
      }).pipe(Effect.provide(h.layer));
    },
  );
  it.effect("publishes a small project without the confirmation, as before", () => {
    const h = makeHarness({ workers: 3 });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const first = yield* service.prepare(preview);
      const published = yield* service.prepare({
        ...preview,
        publish: true,
        expectedDigest: first.bundle.digest,
      });
      expect(published.publication).toBe("published");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("is refused by an older destination, which drops the summary it cannot read", () => {
    const h = large();
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const bundle = imported((yield* service.prepare(preview)).bundle);
      // An older peer's schema strips the unknown key; the digest then no longer matches.
      const { retention: _retention, ...older } = bundle.context;
      const stripped = { ...bundle, context: older };
      expect(
        (yield* failureOnly(
          service.receive({ projectId, operationId: id, bundle: stripped, mode: "start" }),
        )).code,
      ).toBe("invalid");
      expect(h.state.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("still carries a small project's every transcript, with no new field (AC-03)", () => {
    const h = makeHarness({ workers: 3 });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const { bundle } = yield* service.prepare(preview);
      expect("retention" in bundle.context).toBe(false);
      expect(Object.keys(bundle.context).sort()).toEqual(
        ["goal", "instructions", "notes", "runtimeMode", "threads"].sort(),
      );
      expect(bundle.context.threads.map((t) => [t.threadId, t.kind, t.messages.length])).toEqual([
        [threadId, "coordinator", 1],
        ["worker-0", "worker", 1],
        ["worker-1", "worker", 1],
        ["worker-2", "worker", 1],
      ]);
      expect(h.state.recordReads).toHaveLength(4);
      const started = yield* service.receive({
        projectId,
        operationId: id,
        bundle: imported(bundle),
        mode: "start",
      });
      expect(started.phase).toBe("started");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("shortens an oversized newest coordinator message instead of refusing", () => {
    const h = makeHarness({ text: "x".repeat(2_097_153) });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const { bundle } = yield* service.prepare(preview);
      expect(contextBytes(bundle)).toBeLessThanOrEqual(MACHINE_HANDOFF_MAX_BYTES);
      const message = bundle.context.threads[0]!.messages[0]!;
      expect(message.text.startsWith("xxxx")).toBe(true);
      expect(message.text).toMatch(
        /\n\[\.\.\. \d+ more bytes of this message stay on the source machine\]$/,
      );
      expect(bundle.context.retention).toMatchObject({
        coordinatorMessages: 1,
        omittedMessages: 0,
        truncatedMessages: 1,
        totalThreads: 0,
      });
      expect(bundle.context.retention?.note).toContain("The newest message was shortened to fit");
    }).pipe(Effect.provide(h.layer));
  });
  it.effect("trims a 1.8 MB earlier segment on the next handoff and counts what stayed", () => {
    const h = makeHarness({ coordinatorMessages: 1700, messageBytes: 1024 });
    return Effect.gen(function* () {
      const service = yield* MachineHandoff.MachineHandoff;
      const firstPrepared = (yield* service.prepare(preview)).bundle;
      // The first hop still fits whole.
      expect("retention" in firstPrepared.context).toBe(false);
      const received = yield* service.receive({
        projectId,
        operationId: id,
        mode: "start",
        bundle: imported(firstPrepared),
      });
      // The coordinator now continues here, after the history it inherited.
      h.state.coordinatorLaterDays = 30;
      const next = yield* service.prepare({
        projectId: received.projectId,
        operationId: "22222222-2222-4222-8222-222222222222",
        publish: false,
        destination: {
          environmentId: EnvironmentId.make("third-env"),
          projectId: ProjectId.make("third-project"),
          joinExistingProject: true,
        },
      });
      const { context } = next.bundle;
      expect(() => checkBundle(next.bundle)).not.toThrow();
      expect(context.threads.map((t) => [t.environmentId, t.projectId, t.kind])).toEqual([
        ["other-env", projectId, "coordinator"],
        ["source-env", received.projectId, "coordinator"],
      ]);
      // The current coordinator comes first; the inherited segment gets what is left.
      expect(context.threads[1]?.messages).toHaveLength(1700);
      const inherited = context.threads[0]!.messages;
      expect(inherited.length).toBeLessThan(1700);
      if (inherited.length > 0) expect(inherited.at(-1)?.id).toBe("message1700");
      expect(context.retention).toMatchObject({
        coordinatorMessages: 1700 + inherited.length,
        omittedMessages: 1700 - inherited.length,
        totalThreads: 0,
      });
    }).pipe(Effect.provide(h.layer));
  });
});

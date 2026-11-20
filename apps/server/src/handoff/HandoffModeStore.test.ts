// @effect-diagnostics nodeBuiltinImport:off - a real state folder per case.
/**
 * The handoff file when it is there but does not read (1390 AC-36): every reader
 * gets an error, nothing writes over it, and nothing reads as "no continuation".
 * Once the file reads again, answers come from it.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HandoffCheckpoint,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as HandoffMode from "./HandoffMode.ts";
import * as HandoffModeStore from "./HandoffModeStore.ts";
import { overTheWire } from "./handoffMove.test.fixture.ts";
import * as HandoffReceiver from "./HandoffReceiver.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  emptyThreadRecord,
  HandoffDocument,
  incomingKey,
} from "./handoffState.ts";
import * as HandoffState from "./handoffState.ts";
import * as HandoffTurnGate from "./HandoffTurnGate.ts";

const m4 = EnvironmentId.make("env-m4");
const minis = EnvironmentId.make("env-minis");
const project = ProjectId.make("project-local");
const sourceThread = ThreadId.make("thread-src");
const localThread = ThreadId.make("thread-here");
const now = "2026-11-19T10:00:00.000Z";
const continuationId = HandoffReceiver.continuationThreadId(m4, sourceThread, 2);
const encodeDocument = Schema.encodeSync(HandoffDocument);
const decodeDocument = Schema.decodeUnknownSync(HandoffDocument);

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

const lease = (holder: EnvironmentId, threadId: ThreadId, epoch: number) => ({
  holderEnvironmentId: holder,
  holderLabel: holder === m4 ? "M4" : "Minis",
  holderThreadId: threadId,
  epoch,
  renewedAt: now,
  state: "active" as const,
});

const checkpoint: HandoffCheckpoint = {
  sequence: 1,
  commit: "a".repeat(40),
  baseCommit: "b".repeat(40),
  branch: "feat/x",
  ref: `refs/specwithcode/handoff/${sourceThread}`,
  createdAt: now,
  reason: "turn-end",
  skipped: [],
  excludedSecretCount: 0,
  transcriptMessageCount: 1,
  note: null,
  pushedToOrigin: false,
  epoch: 1,
  latestRunId: null,
  turnKey: `${sourceThread}/run-1`,
  runEnding: "usage-limit",
  sideEffects: [],
  sourceRoot: {
    environmentId: m4,
    projectId: ProjectId.make("project-src"),
    threadId: sourceThread,
    workspaceRoot: "/repo",
    branch: "feat/x",
  },
};

/**
 * Minis's file after an earlier release launched M4's thread at epoch 2 and stopped
 * before recording it: the replica, not marked, and the continuation's saved lease.
 * Minis also holds a thread of its own, leased here.
 */
const written: HandoffDocument = {
  ...EMPTY_HANDOFF_DOCUMENT,
  incoming: [
    {
      sourceEnvironmentId: m4,
      sourceLabel: "M4",
      sourceThreadId: sourceThread,
      projectId: project,
      title: "Fix the build",
      checkpoint,
      lease: lease(m4, sourceThread, 1),
      sourceLastSeenAt: now,
      sourceUnreachable: false,
      receivedAt: now,
      continuedThreadId: null,
    },
  ],
  incomingDetails: {
    [incomingKey(m4, sourceThread)]: {
      sourceProjectId: ProjectId.make("project-src"),
      repositoryPath: "",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } as never,
      runtimeMode: "full-access",
      interactionMode: "default",
      transcript: [],
      execution: null,
      takeoverEpoch: null,
      takeover: null,
      autoContinueMinutes: null,
    },
  },
  threads: {
    [continuationId]: {
      ...emptyThreadRecord(project),
      mode: "on",
      lease: lease(minis, continuationId, 2),
    },
    [localThread]: {
      ...emptyThreadRecord(project),
      mode: "on",
      lease: lease(minis, localThread, 1),
    },
  },
  continuationReceipts: {},
};
const readable = JSON.stringify(encodeDocument(written));

/** The error `effect` fails with; an assertion failure when it succeeds. */
const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.result(effect), (result) => {
    expect(result._tag).toBe("Failure");
    return (result as { readonly failure: E }).failure;
  });

/** Each way a file that is there fails to read. */
const UNREADABLE = {
  "is not JSON": readable.slice(0, readable.length / 2),
  "does not decode": JSON.stringify({ ...JSON.parse(readable), version: 2 }),
} as const;
const CASES = Object.entries(UNREADABLE);

/** A fresh state folder holding `text` as the handoff file, or no file. */
function stateFolder(text: string | null) {
  const stateDir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-store-")),
  );
  temporary.push(stateDir);
  const file = NodePath.join(stateDir, "handoff-mode.json");
  if (text !== null) NodeFS.writeFileSync(file, text);
  return {
    file,
    bytes: () => (NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null),
    write: (next: string) => NodeFS.writeFileSync(file, next),
    platform: Layer.mergeAll(
      Layer.succeed(ServerConfig.ServerConfig, { stateDir } as never),
      NodeServices.layer,
      NodeCrypto.layer,
    ),
  };
}

const storeOn = (folder: ReturnType<typeof stateFolder>) =>
  HandoffModeStore.layer.pipe(Layer.provideMerge(folder.platform));

describe("the handoff file", () => {
  it.effect("no file reads as the empty document, and the first update writes one", () => {
    const folder = stateFolder(null);
    return Effect.gen(function* () {
      const store = yield* HandoffModeStore.HandoffModeStore;
      expect(yield* store.read).toEqual(EMPTY_HANDOFF_DOCUMENT);
      yield* store.update((current) => [undefined, { ...current, pausedSince: now }] as const);
      expect(JSON.parse(folder.bytes()!)).toMatchObject({ pausedSince: now });
    }).pipe(Effect.provide(storeOn(folder)));
  });

  it("keeps every launch receipt over unlaunched ones, and the newest of each", () => {
    // Read through the module, so a build without receipts fails here, not on import.
    expect(typeof HandoffState.noteContinuation).toBe("function");
    let document: HandoffDocument = EMPTY_HANDOFF_DOCUMENT;
    const max = HandoffState.HANDOFF_CONTINUATION_RECEIPTS_MAX;
    const at = (index: number) => `${now}#${String(index).padStart(6, "0")}`;
    for (let index = 0; index < max; index += 1) {
      document = HandoffState.noteContinuation(document, `m4/thread-${index}`, {
        threadId: `handoff:${index}`,
        epoch: 2,
        launched: index % 2 === 0,
        at: at(index),
      });
    }
    // One more: the oldest unlaunched receipt goes, never a launched one.
    document = HandoffState.noteContinuation(document, "m4/thread-new", {
      threadId: "handoff:new",
      epoch: 2,
      launched: false,
      at: at(max),
    });
    const receipts = document.continuationReceipts ?? {};
    expect(Object.keys(receipts)).toHaveLength(max);
    expect(receipts["m4/thread-1"]).toBeUndefined();
    expect(receipts["m4/thread-0"]?.launched).toBe(true);
    expect(receipts["m4/thread-new"]?.launched).toBe(false);
    // A launch receipt is never replaced by a later start.
    const kept = HandoffState.noteContinuation(document, "m4/thread-0", {
      threadId: "handoff:other",
      epoch: 5,
      launched: false,
      at: at(max + 1),
    });
    expect(kept.continuationReceipts?.["m4/thread-0"]?.threadId).toBe("handoff:0");
  });

  it.effect.each(CASES)(
    "one that %s: every read and update fails, nothing writes over it",
    ([, text]) => {
      const folder = stateFolder(text);
      return Effect.gen(function* () {
        const store = yield* HandoffModeStore.HandoffModeStore;
        const read = yield* failureOf(store.read);
        expect(read).toMatchObject({ code: "failed" });
        expect(read.message).toContain("cannot be read");
        const updated = yield* failureOf(
          store.update((current) => [undefined, { ...current, pausedSince: now }] as const),
        );
        expect(updated).toMatchObject({ code: "failed" });
        // Read again: still an error, never the empty document kept from the first try.
        yield* failureOf(store.read);
        expect(folder.bytes()).toBe(text);
        // Once the file reads again, answers come from it.
        folder.write(readable);
        expect(yield* store.read).toEqual(decodeDocument(JSON.parse(readable)));
        yield* store.update((current) => [undefined, { ...current, pausedSince: now }] as const);
        expect(JSON.parse(folder.bytes()!)).toMatchObject({ pausedSince: now });
      }).pipe(Effect.provide(storeOn(folder)));
    },
  );
});

/** Minis's receiver on the store, with the thread the earlier launch created. */
const receiverOn = () =>
  Effect.gen(function* () {
    const store = yield* HandoffModeStore.HandoffModeStore;
    const launches: Array<unknown> = [];
    const services = Layer.mergeAll(
      Layer.succeed(HandoffMode.HandoffMode, {
        environmentId: minis,
        machineLabel: "Minis",
        document: store.read,
        updateDocument: store.update,
      } as unknown as HandoffMode.HandoffMode["Service"]),
      Layer.succeed(ServerSettings.ServerSettingsService, {} as never),
      Layer.succeed(ServerConfig.ServerConfig, {} as never),
      Layer.succeed(ProjectService.ProjectService, {} as never),
      Layer.succeed(ProviderRegistry.ProviderRegistry, {} as never),
      Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
        launch: (input: unknown) =>
          Effect.sync(() => {
            launches.push(input);
            return {};
          }),
      } as never),
      Layer.succeed(Orchestrator.OrchestratorV2, {
        dispatch: () => Effect.succeed({}),
        getThreadShell: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === continuationId
              ? {
                  id: threadId,
                  projectId: project,
                  modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
                }
              : null,
          ),
      } as never),
      Layer.succeed(WorkGrants.WorkGrants, WorkGrants.WorkGrants.defaultValue()),
    );
    const receiver = yield* HandoffReceiver.make.pipe(Effect.provide(services));
    return { receiver, launches };
  });

const peer: HandoffReceiver.ReceiverCaller = {
  sourceEnvironmentId: m4,
  grant: { ...unscopedGrant(m4), owner: "other" },
  runtimeCeiling: "full-access",
};
const asking = {
  sourceEnvironmentId: m4,
  sourceLabel: "M4",
  leases: [{ sourceThreadId: sourceThread, epoch: 1 }],
  settle: [{ sourceThreadId: sourceThread, epoch: 2 }],
};

describe("a destination whose handoff file does not read", () => {
  it.effect.each(CASES)(
    "one that %s: no thread reads as not started, then the file answers",
    ([, text]) => {
      const folder = stateFolder(text);
      return Effect.gen(function* () {
        const { receiver, launches } = yield* receiverOn();
        expect(yield* receiver.continuation(m4, sourceThread)).toEqual({ kind: "unresolved" });
        // No answer at all: a source on any release reads that as silence and keeps its holds.
        const beat = yield* failureOf(receiver.heartbeat(peer, asking));
        expect(beat).toMatchObject({ status: 503, inDoubt: true });
        expect(overTheWire("Minis", beat).uncertain).toBe(true);
        const takeover = yield* failureOf(
          receiver.takeover(peer, {
            sourceEnvironmentId: m4,
            sourceThreadId: sourceThread,
            epoch: 2,
            sequence: 1,
            reason: "sleep",
            modelSelection: null,
          }),
        );
        expect(overTheWire("Minis", takeover).uncertain).toBe(true);
        expect(folder.bytes()).toBe(text);
        expect(launches).toEqual([]);
        // The file reads again: the thread the earlier launch created answers.
        folder.write(readable);
        expect(yield* receiver.continuation(m4, sourceThread)).toEqual({
          kind: "continued",
          threadId: continuationId,
        });
        expect(yield* receiver.heartbeat(peer, asking)).toMatchObject({
          continued: [{ sourceThreadId: sourceThread, epoch: 2, threadId: continuationId }],
          notStarted: [],
        });
        expect(launches).toEqual([]);
      }).pipe(Effect.provide(storeOn(folder)));
    },
  );
});

/** This machine's own handoff mode and turn gate on the real store. */
const sourceOn = (folder: ReturnType<typeof stateFolder>) => {
  const stubs = Layer.mergeAll(
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(minis),
      getDescriptor: Effect.succeed({ label: "Minis" }),
    } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
    Layer.succeed(ProjectService.ProjectService, {
      getById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectService.ProjectService["Service"]),
    Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      getThreadShell: () => Effect.succeed(null),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Layer.succeed(ServerSettings.ServerSettingsService, {} as never),
    Layer.succeed(TextGeneration.TextGeneration, {} as never),
  );
  return Layer.mergeAll(
    Layer.effect(HandoffMode.HandoffMode, HandoffMode.make),
    HandoffTurnGate.layer,
  ).pipe(
    Layer.provideMerge(HandoffModeStore.layer),
    Layer.provideMerge(stubs),
    Layer.provideMerge(folder.platform),
  );
};

describe("this machine when its handoff file does not read", () => {
  it.effect.each(CASES)(
    "one that %s: its threads act on nothing, and nothing is promised",
    ([, text]) => {
      const folder = stateFolder(text);
      return Effect.gen(function* () {
        const handoff = yield* HandoffMode.HandoffMode;
        const sideEffect = {
          threadId: localThread,
          runId: "run-1",
          kind: "pr-create",
          target: "example/app#1",
        } as const;
        // A lease that does not read may be another machine's now: nothing acts on it.
        expect((yield* handoff.fence(localThread, "run-1")).kind).toBe("fenced");
        expect((yield* handoff.guardSideEffect(sideEffect)).kind).toBe("refuse");
        // Settings shows the unknown state: no list of machines, so no promise.
        yield* failureOf(handoff.snapshot);
        const shown = yield* handoff.viewSnapshot;
        expect(shown.threads).toEqual([]);
        expect("pendingDisarm" in shown).toBe(false);
        // The lease tick and its journal write nothing over the file.
        yield* handoff.recordSideEffect({ ...sideEffect, result: "#1" });
        yield* handoff.heartbeat;
        expect(folder.bytes()).toBe(text);
        // The file reads again: the thread's lease is this machine's, and it acts.
        folder.write(readable);
        expect((yield* handoff.fence(localThread, "run-1")).kind).toBe("ok");
        expect(Array.isArray((yield* handoff.viewSnapshot).pendingDisarm)).toBe(true);
      }).pipe(Effect.provide(sourceOn(folder)));
    },
  );

  // No record reads, so a thread never handed off cannot be told apart: every turn waits.
  it.effect.each(CASES)("one that %s: the turn gate stays shut", ([, text]) => {
    const folder = stateFolder(text);
    return Effect.gen(function* () {
      const gate = yield* HandoffTurnGate.HandoffTurnGate;
      expect(yield* gate.check(localThread)).not.toBeNull();
      expect(yield* gate.check(ThreadId.make("thread-never-handed-off"))).not.toBeNull();
      folder.write(readable);
      expect(yield* gate.check(localThread)).toBeNull();
    }).pipe(Effect.provide(sourceOn(folder)));
  });
});

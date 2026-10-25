import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy, type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";
import { projectCodexFileChanges } from "./codexFileChanges.ts";
import { makeCodexFileChangeWirePeer } from "./codexFileChangeWire.testkit.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);

type FileItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;
type Scenario =
  | "started"
  | "patchUpdated"
  | "legacy"
  | "unknownLegacy"
  | "unknownPatch"
  | "unknownStarted"
  | "unknownCompleted"
  | "emptyPatch"
  | "missingScope"
  | "unrelatedInvalid"
  | "pendingUnknown"
  | "pendingChanged"
  | "legacyPendingUnknown";
const changes = [
  {
    path: "/workspace/case.mjs",
    kind: { type: "update" as const },
    diff: "@@\n-old case\n+new case\n",
  },
  { path: "/workspace/unapproved.mjs", kind: { type: "add" as const }, diff: "+unapproved\n" },
  {
    path: "/workspace/old.mjs",
    kind: { type: "update" as const, move_path: "/workspace/new.mjs" },
    diff: "@@\n-old\n+new\n",
  },
];
// The adapter stores each change as the headed patch the shared projection builds.
const projectedChanges = projectCodexFileChanges(changes)!;
const expectedChanges = projectedChanges.changes!;

// Exercise the production adapter and JSON-RPC decoder against an in-memory peer.
// No native process, credentials, provider session or model can be contacted.
type UntypedUpdate = {
  method: "item/started" | "item/completed";
  phase: "before" | "pending";
  knownItem: boolean;
};
const observeApproval = (
  scenario: Scenario,
  grantRoot?: string | null,
  untypedUpdate?: UntypedUpdate,
) =>
  Effect.gen(function* () {
    const outbound: string[] = [];
    const request = (method: string) =>
      Effect.sync(() => {
        outbound.push(method);
        switch (method) {
          case "initialize":
            return {
              userAgent: "file-change-test",
              codexHome: "/tmp/file-change-test",
              platformFamily: "unix",
              platformOs: "macos",
            };
          case "thread/start":
            return {
              model: "gpt-5.4",
              modelProvider: "openai",
              serviceTier: null,
              cwd: "/workspace",
              instructionSources: [],
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
              reasoningEffort: "medium",
              thread: {
                id: "native-thread-files",
                projectId: null,
                sessionId: "native-thread-files",
                forkedFromId: null,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1782622440,
                updatedAt: 1782622440,
                status: { type: "idle" },
                path: "/tmp/native-thread-files.jsonl",
                cwd: "/workspace",
                cliVersion: "0.144.0",
                source: "vscode",
                threadSource: null,
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
              },
            };
          case "turn/start":
            return {
              turn: {
                id: "native-turn-files",
                items: [],
                itemsView: "notLoaded",
                status: "inProgress",
                error: null,
                startedAt: 1782622440,
                completedAt: null,
                durationMs: null,
              },
            };
          default:
            throw new Error(`Unexpected transport request: ${method}`);
        }
      });
    const peer = yield* makeCodexFileChangeWirePeer(request);
    const emitUntypedUpdate = () =>
      untypedUpdate
        ? peer.notify(untypedUpdate.method, {
            threadId: "native-thread-files",
            turnId: "native-turn-files",
            startedAtMs: 1782622440000,
            completedAtMs: 1782622440001,
            item: {
              id: untypedUpdate.knownItem ? "native-files" : "unrelated-item",
              status: "inProgress",
              files: changes,
            },
          })
        : Effect.void;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* makeReplayServerConfig(`file-changes-${scenario}`).pipe(
      Effect.orDie,
    );
    yield* Effect.addFinalizer(() =>
      fileSystem.remove(serverConfig.baseDir, { recursive: true }).pipe(Effect.orDie),
    );
    const adapter = CodexAdapterV2.makeCodexAdapterV2({
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: decodeSettings({}),
      environment: {},
      clientFactory: { open: () => Effect.succeed(peer.client) },
      crypto: yield* Crypto.Crypto,
      fileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig,
    });
    const threadId = ThreadId.make(`thread-files-${scenario}`);
    const modelSelection = {
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      model: "gpt-5.4",
    };
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: "/workspace",
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`session-files-${scenario}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const events: ProviderAdapterV2Event[] = [];
    const files: FileItem[] = [];
    const evidenceAtApproval: FileItem[] = [];
    const completed = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn_item.updated" && event.turnItem.type === "file_change") {
            files.push(event.turnItem);
            if (event.turnItem.status === "completed")
              yield* Deferred.succeed(completed, undefined);
          }
          if (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.status === "pending"
          ) {
            const lastFile = files.at(-1);
            if (lastFile) evidenceAtApproval.push(lastFile);
            const changedWhilePending =
              scenario === "pendingUnknown" ||
              scenario === "pendingChanged" ||
              scenario === "legacyPendingUnknown" ||
              untypedUpdate?.phase === "pending";
            if (changedWhilePending) {
              if (untypedUpdate?.phase === "pending") yield* emitUntypedUpdate();
              else
                yield* peer.notify("item/fileChange/patchUpdated", {
                  threadId: "native-thread-files",
                  turnId: "native-turn-files",
                  itemId: "native-files",
                  changes:
                    scenario === "pendingChanged"
                      ? changes
                      : [
                          ...changes,
                          {
                            path: "/workspace/hidden.mjs",
                            kind: { type: "copy" },
                            diff: "+hidden\n",
                          },
                        ],
                });
              yield* peer.flush;
            }
            yield* runtime.respondToRuntimeRequest({
              requestId: event.runtimeRequest.id,
              decision: changedWhilePending || untypedUpdate ? "accept" : "decline",
            });
          }
        }),
      ),
      Effect.forkScoped,
    );
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-files"),
        title: "File scope approval regression",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make("run-files"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-files"),
      rootNodeId: NodeId.make("root-files"),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make("message-files"),
        text: "Change only case.mjs",
        attachments: [],
      },
      modelSelection,
      runtimePolicy,
    });
    const base = { threadId: "native-thread-files", turnId: "native-turn-files" };
    const item = { type: "fileChange", id: "native-files", status: "inProgress", changes };
    let approvalResult: Exit.Exit<unknown>;
    if (
      scenario === "legacy" ||
      scenario === "unknownLegacy" ||
      scenario === "legacyPendingUnknown"
    ) {
      const payload = {
        conversationId: base.threadId,
        callId: item.id,
        reason: "Only case.mjs is changed",
        ...(grantRoot === undefined ? {} : { grantRoot }),
        fileChanges: {
          "/workspace/case.mjs": { type: "update", unified_diff: changes[0]!.diff },
          "/workspace/unapproved.mjs": { type: "add", content: changes[1]!.diff },
          "/workspace/old.mjs": {
            type: "update",
            unified_diff: changes[2]!.diff,
            move_path: "/workspace/new.mjs",
          },
          ...(scenario === "unknownLegacy"
            ? { "/workspace/hidden.mjs": { type: "copy", content: "hidden" } }
            : {}),
        },
      };
      approvalResult = yield* peer.request("applyPatchApproval", payload).pipe(Effect.exit);
    } else {
      if (scenario !== "missingScope")
        yield* peer.notify("item/started", {
          ...base,
          startedAtMs: 1782622440000,
          item: {
            ...item,
            changes:
              !untypedUpdate && (scenario === "started" || scenario === "unrelatedInvalid")
                ? changes
                : changes.slice(0, 1),
          },
        });
      if (scenario === "patchUpdated")
        yield* peer.notify("item/fileChange/patchUpdated", {
          ...base,
          itemId: item.id,
          changes,
        });
      if (scenario === "unknownPatch" || scenario === "emptyPatch")
        yield* peer.notify("item/fileChange/patchUpdated", {
          ...base,
          itemId: item.id,
          changes:
            scenario === "emptyPatch"
              ? []
              : [
                  ...changes,
                  { path: "/workspace/hidden.mjs", kind: { type: "copy" }, diff: "+hidden\n" },
                ],
        });
      if (scenario === "unknownStarted" || scenario === "unknownCompleted")
        yield* peer.notify(scenario === "unknownStarted" ? "item/started" : "item/completed", {
          ...base,
          startedAtMs: 1782622440000,
          completedAtMs: 1782622440001,
          item: {
            ...item,
            changes: [
              ...changes,
              { path: "/workspace/hidden.mjs", kind: { type: "copy" }, diff: "+hidden\n" },
            ],
          },
        });
      if (scenario === "unrelatedInvalid")
        yield* peer.notify("item/agentMessage/delta", { unknown: true });
      if (untypedUpdate?.phase === "before") {
        yield* emitUntypedUpdate();
        yield* peer.flush;
      }
      approvalResult = yield* peer
        .request("item/fileChange/requestApproval", {
          ...base,
          itemId: item.id,
          startedAtMs: 1782622440000,
          reason: "Only case.mjs is changed",
          ...(grantRoot === undefined ? {} : { grantRoot }),
        })
        .pipe(Effect.exit);
      if (scenario === "started" || scenario === "patchUpdated") {
        yield* peer.notify("item/completed", {
          ...base,
          completedAtMs: 1782622440001,
          item: { ...item, status: "completed" },
        });
        yield* Deferred.await(completed);
      }
    }
    const result =
      approvalResult._tag === "Success"
        ? { tag: "Success", response: approvalResult.value }
        : { tag: "Failure" };
    return { events, files, evidenceAtApproval, approvalResult: result, outbound };
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
    Effect.timeout("10 seconds"),
  );

describe("Codex adapter structured file approval evidence", () => {
  it.effect.each([
    { scenario: "started", method: "item/started", phase: "before" },
    { scenario: "started", method: "item/completed", phase: "before" },
    { scenario: "started", method: "item/started", phase: "pending" },
    { scenario: "started", method: "item/completed", phase: "pending" },
    { scenario: "legacy", method: "item/started", phase: "pending" },
    { scenario: "legacy", method: "item/completed", phase: "pending" },
  ] as const)("rejects untyped known-item $method $phase $scenario approval", (input) =>
    Effect.gen(function* () {
      const result = yield* observeApproval(input.scenario, undefined, {
        ...input,
        knownItem: true,
      });
      expect(result.approvalResult).toEqual({
        tag: "Success",
        response: {
          decision:
            input.scenario === "legacy"
              ? { denied: { rejection: "User declined the request." } }
              : "decline",
        },
      });
      expect(result.evidenceAtApproval).toHaveLength(input.phase === "before" ? 0 : 1);
      if (input.scenario === "started")
        expect(result.files[0]?.changes).toEqual(expectedChanges.slice(0, 1));
    }),
  );

  it.effect.each([
    { method: "item/started", phase: "before" },
    { method: "item/completed", phase: "before" },
    { method: "item/started", phase: "pending" },
    { method: "item/completed", phase: "pending" },
  ] as const)(
    "keeps unrelated untyped $method $phase notifications from rejecting a valid file approval",
    (input) =>
      Effect.gen(function* () {
        const result = yield* observeApproval("started", undefined, { ...input, knownItem: false });
        expect(result.approvalResult).toEqual({ tag: "Success", response: { decision: "accept" } });
        expect(result.evidenceAtApproval).toHaveLength(1);
        expect(result.evidenceAtApproval[0]?.changes).toEqual(expectedChanges.slice(0, 1));
      }),
  );

  it.effect.each(["started", "patchUpdated", "legacy", "unrelatedInvalid"] as const)(
    "retains all file scopes before %s approval despite misleading reason text",
    (scenario) =>
      Effect.gen(function* () {
        const result = yield* observeApproval(scenario);
        expect(result.outbound).toEqual(["initialize", "thread/start", "turn/start"]);
        expect(result.approvalResult).toEqual({
          tag: "Success",
          response: {
            decision:
              scenario === "legacy"
                ? { denied: { rejection: "User declined the request." } }
                : "decline",
          },
        });
        expect(result.evidenceAtApproval).toHaveLength(1);
        const evidence = result.evidenceAtApproval[0]!;
        expect(evidence.changes).toEqual(expectedChanges);
        expect(evidence).not.toHaveProperty("diffStr");
        expect(evidence.status).toBe("running");
        const approval = result.events.find((event) => event.type === "runtime_request.updated");
        expect(approval).toMatchObject({
          runtimeRequest: {
            kind: "file-change",
            nativeRequestRef: { nativeId: evidence.nativeItemRef?.nativeId },
          },
        });
        if (scenario === "started" || scenario === "patchUpdated") {
          expect(result.files.at(-1)).toMatchObject({
            id: evidence.id,
            status: "completed",
            changes: expectedChanges,
          });
        }
      }),
  );

  it.effect(
    "emits neither a partial valid file scope nor an approval for an unknown legacy action",
    () =>
      Effect.gen(function* () {
        const result = yield* observeApproval("unknownLegacy");
        expect(result.approvalResult).toEqual({ tag: "Failure" });
        expect(result.files).toEqual([]);
        expect(result.events.some((event) => event.type === "runtime_request.updated")).toBe(false);
      }),
  );

  it.effect.each([
    "unknownPatch",
    "unknownStarted",
    "unknownCompleted",
    "emptyPatch",
    "missingScope",
  ] as const)(
    "declines %s through the real JSON-RPC decoder without presenting stale evidence for approval",
    (scenario) =>
      Effect.gen(function* () {
        const result = yield* observeApproval(scenario);
        expect(result.approvalResult).toEqual({
          tag: "Success",
          response: { decision: "decline" },
        });
        expect(result.evidenceAtApproval).toEqual([]);
        expect(result.events.some((event) => event.type === "runtime_request.updated")).toBe(false);
        if (scenario !== "missingScope")
          expect(result.files[0]?.changes).toEqual(expectedChanges.slice(0, 1));
      }),
  );
  it.effect.each(["pendingUnknown", "pendingChanged", "legacyPendingUnknown"] as const)(
    "declines an accepted %s approval when file evidence changes while the decision is pending",
    (scenario) =>
      Effect.gen(function* () {
        const result = yield* observeApproval(scenario);
        expect(result.evidenceAtApproval).toHaveLength(1);
        expect(result.approvalResult).toEqual({
          tag: "Success",
          response: {
            decision:
              scenario === "legacyPendingUnknown"
                ? { denied: { rejection: "User declined the request." } }
                : "decline",
          },
        });
      }),
  );

  it.effect.each([
    ["started", null],
    ["started", "/workspace"],
    ["started", undefined],
    ["legacy", null],
    ["legacy", "/workspace"],
    ["legacy", undefined],
  ] as const)(
    "preserves %s grantRoot %s independently of a misleading reason",
    ([scenario, grantRoot]) =>
      Effect.gen(function* () {
        const result = yield* observeApproval(scenario, grantRoot);
        const approval = result.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        expect(approval).toMatchObject({ turnItem: { prompt: "Only case.mjs is changed" } });
        if (grantRoot === undefined) expect(approval).not.toHaveProperty("turnItem.grantRoot");
        else expect(approval).toHaveProperty("turnItem.grantRoot", grantRoot);
      }),
  );
});

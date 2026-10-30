import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { FolderCopyCapabilities } from "./folderCopy.ts";
import {
  MachineHandoffContext,
  MachineHandoffPrepareInput,
  MachineHandoffReceiveInput,
  MachineHandoffError,
  type MachineHandoffBundle,
} from "./machineHandoff.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthSettingsWriteScope,
} from "./auth.ts";

const isPrepareInput = Schema.is(MachineHandoffPrepareInput);
const isReceiveInput = Schema.is(MachineHandoffReceiveInput);
const decodeReceiveInput = Schema.decodeUnknownSync(MachineHandoffReceiveInput);
const operationId = "11111111-1111-4111-8111-111111111111";
const metadata = {
  manifest: {
    version: 1 as const,
    operationId,
    repositories: [
      {
        relativePath: ".",
        identity: "github.com/example/project",
        head: "a".repeat(40),
        ref: `refs/heads/codex/handoff/${operationId}/${"a".repeat(40)}`,
      },
    ],
  },
  sourceEnvironmentId: EnvironmentId.make("source"),
  sourceProjectId: ProjectId.make("source-project"),
  sourceThreadId: ThreadId.make("source-thread"),
  digest: "b".repeat(64),
};
const previewInput = { ...metadata, projectId: "destination", operationId, mode: "preview" };
const bundle: MachineHandoffBundle = {
  ...metadata,
  createdAt: "2026-10-13T00:00:00Z",
  context: {
    goal: "Retained private goal",
    instructions: "Retained private instructions",
    notes: [{ name: "MEMORY.md", content: "Retained private decision" }],
    threads: [],
  },
};

describe("machine handoff wire and permissions", () => {
  it("gives actionable closed-category errors without exposing Git command details", () => {
    expect(new MachineHandoffError({ code: "worker_checkpoint" }).message).toContain(
      "Commit and merge",
    );
    expect(new MachineHandoffError({ code: "remote_unavailable" }).message).toContain(
      "remote access",
    );
    expect(new MachineHandoffError({ code: "storage_failed" }).message).toContain(
      "Retry the same handoff",
    );
  });
  it("round-trips a closed unsafe-path error with actionable link guidance", () => {
    const error = Schema.decodeUnknownSync(MachineHandoffError)({
      _tag: "MachineHandoffError",
      code: "unsafe_path",
    });
    expect(error.message).toContain("symbolic link");
    expect(error.message).toContain("preserving their targets");
    expect(Schema.encodeSync(MachineHandoffError)(error)).toEqual({
      _tag: "MachineHandoffError",
      code: "unsafe_path",
    });
  });
  it("round-trips a folder copy's source changes and bounds what it carries", () => {
    const changes = {
      digest: "a".repeat(64),
      total: 2,
      truncated: false,
      acceptable: true,
      rows: [
        { path: ".specweave/ledger.jsonl", kind: "changed", size: 12 },
        {
          path: "repositories/svc",
          kind: "repository",
          repository: {
            headFrom: "1".repeat(40),
            headTo: "2".repeat(40),
            branchesChanged: ["main"],
            stashFrom: 0,
            stashTo: 1,
            indexChanged: false,
          },
        },
      ],
    };
    const wire = { _tag: "MachineHandoffError", code: "source_changed", changes };
    const error = Schema.decodeUnknownSync(MachineHandoffError)(wire);
    expect(error.changes).toEqual(changes);
    expect(error.message).toContain("Review them");
    expect(Schema.encodeSync(MachineHandoffError)(error)).toEqual(wire);
    expect(new MachineHandoffError({ code: "source_changed" }).message).toContain(
      "Start a new handoff",
    );
    const decodes = (value: unknown) =>
      Schema.decodeUnknownExit(MachineHandoffError)({ ...wire, changes: value })._tag === "Success";
    const refs = { ...changes.rows[1]!.repository!, refsChanged: true, settingsChanged: true };
    expect(decodes({ ...changes, rows: [{ ...changes.rows[1], repository: refs }] })).toBe(true);
    expect(decodes({ ...changes, digest: "../report" })).toBe(false);
    expect(decodes({ ...changes, rows: [{ path: "a", kind: "renamed" }] })).toBe(false);
    expect(decodes({ ...changes, rows: Array.from({ length: 501 }, () => changes.rows[0]) })).toBe(
      false,
    );
    const accepts = (acceptedSourceChanges: string) =>
      isPrepareInput({ projectId: "p", operationId, publish: true, acceptedSourceChanges });
    expect(accepts("b".repeat(64))).toBe(true);
    expect(accepts("not-a-digest")).toBe(false);
  });
  it("requires an explicit publish choice and safe UUID", () => {
    const input = {
      projectId: "p",
      operationId: "11111111-1111-4111-8111-111111111111",
      publish: false,
    };
    expect(isPrepareInput(input)).toBe(true);
    expect(isPrepareInput({ ...input, operationId: "../escape" })).toBe(false);
    expect(isPrepareInput({ projectId: "p", operationId: input.operationId })).toBe(false);
  });
  it("never starts a destination without an explicit mode and bundle", () => {
    expect(
      isReceiveInput({
        projectId: "p",
        operationId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe(false);
  });
  it("accepts metadata-only preview and carries no retained context on its wire", () => {
    expect(isReceiveInput(previewInput)).toBe(true);
    const decoded = decodeReceiveInput(previewInput);
    expect(decoded).toEqual(previewInput);
    expect(JSON.stringify(decoded)).not.toContain("Retained private");
    expect(decoded).not.toHaveProperty("bundle");
    expect(decoded).not.toHaveProperty("context");
  });
  it("rejects the old full-context preview instead of falling back before consent", () => {
    expect(() =>
      decodeReceiveInput({ projectId: "destination", operationId, mode: "preview", bundle }),
    ).toThrow();
    expect(() => decodeReceiveInput({ ...previewInput, bundle })).toThrow();
    expect(() => decodeReceiveInput({ ...previewInput, context: bundle.context })).toThrow();
  });
  it("requires the full bundle for start and all source bindings for preview", () => {
    expect(isReceiveInput({ ...previewInput, mode: "start" })).toBe(false);
    expect(isReceiveInput({ projectId: "destination", operationId, mode: "start", bundle })).toBe(
      true,
    );
    for (const key of [
      "sourceEnvironmentId",
      "sourceProjectId",
      "sourceThreadId",
      "digest",
    ] as const) {
      const { [key]: _removed, ...missing } = previewInput;
      expect(isReceiveInput(missing)).toBe(false);
    }
  });
  it.each([
    [WS_METHODS.machineHandoffPrepare, { publish: false }],
    [WS_METHODS.machineHandoffReceive, { mode: "preview" }],
  ])("allows preview only with context and filesystem read grants: %s", (method, input) => {
    expect(clientRpcRequiredScopes(method, input)).toEqual([
      AuthOrchestrationReadScope,
      AuthFilesystemReadScope,
    ]);
  });
  it.each([
    [WS_METHODS.machineHandoffPrepare, { publish: true }],
    [WS_METHODS.machineHandoffReceive, { mode: "start" }],
  ])("requires every write and start grant: %s", (method, input) => {
    expect(clientRpcRequiredScopes(method, input)).toEqual([
      AuthOrchestrationReadScope,
      AuthFilesystemReadScope,
      AuthFilesystemWriteScope,
      AuthSourceControlWriteScope,
      AuthOrchestrationOperateScope,
      ...(method === WS_METHODS.machineHandoffReceive ? [AuthSettingsWriteScope] : []),
    ]);
  });
});
describe("MachineHandoffContext retention", () => {
  const isContext = Schema.is(MachineHandoffContext);
  const decodeContext = Schema.decodeUnknownSync(MachineHandoffContext);
  const legacy = { goal: "g", instructions: "i", notes: [], threads: [] };
  const worker = {
    environmentId: "source",
    threadId: "worker-1",
    title: "Worker",
    branch: "inc/1",
    worktreePath: null,
    status: "completed",
    archived: false,
    lastActivityAt: "2026-10-30T00:00:00.000Z",
    lastMessage: {
      role: "assistant",
      text: "Done",
      createdAt: "2026-10-30T00:00:00.000Z",
      truncated: false,
    },
  };
  const retention = {
    note: "Worker chats did not move.",
    coordinatorMessages: 412,
    omittedMessages: 9418,
    truncatedMessages: 0,
    totalThreads: 1628,
    workers: [worker],
    omittedThreads: 1627,
  };
  it("still accepts a context without it, and decodes it unchanged", () => {
    expect(isContext(legacy)).toBe(true);
    expect(decodeContext(legacy)).toEqual(legacy);
  });
  it("round-trips a summary within its bounds", () => {
    expect(decodeContext({ ...legacy, retention })).toEqual({ ...legacy, retention });
    expect(
      isContext({
        ...legacy,
        retention: { ...retention, workers: Array.from({ length: 200 }, () => worker) },
      }),
    ).toBe(true);
  });
  it.each([
    ["201 workers", { workers: Array.from({ length: 201 }, () => worker) }],
    ["a long note", { note: "n".repeat(2001) }],
    ["a negative count", { omittedMessages: -1 }],
    ["a fractional count", { totalThreads: 1.5 }],
    [
      "a long excerpt",
      { workers: [{ ...worker, lastMessage: { ...worker.lastMessage, text: "t".repeat(281) } }] },
    ],
  ])("refuses %s", (_name, change) => {
    expect(isContext({ ...legacy, retention: { ...retention, ...change } })).toBe(false);
  });
  it("advertises the capability optionally", () => {
    const isCapabilities = Schema.is(FolderCopyCapabilities);
    expect(isCapabilities({ scopeVersion: 1 })).toBe(true);
    expect(isCapabilities({ scopeVersion: 1, contextRetention: 1 })).toBe(true);
    expect(isCapabilities({ scopeVersion: 1, contextRetention: 2 })).toBe(false);
  });
});

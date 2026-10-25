import {
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  RuntimeRequestId,
  ProviderDriverKind,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@specweave-studio/contracts";
import { TRANSPORT_TRUNCATION_MARKER } from "@specweave-studio/shared/toolOutput";
import { describe, expect, it } from "vite-plus/test";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import { createQuestionHistoryProjector, derivePendingThreadRequests } from "./threadRequests.ts";

const requestId = RuntimeRequestId.make("async-question");
const nodeId = NodeId.make("async-question-node");
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  runtimeRequests: [
    {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: v2Now,
      resolvedAt: null,
    },
  ],
  turnItems: [
    {
      id: TurnItemId.make("async-question-item"),
      threadId: v2Projection.thread.id,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "user_input_request",
      requestId,
      responseMode: "message",
      questions: [
        {
          id: "next",
          header: "Next",
          question: "What should happen next?",
          required: true,
          allowCustomAnswer: false,
          options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
        },
      ],
    },
  ],
};

describe("pending v2 questions", () => {
  it("keeps message responses available after the originating runtime exits", () => {
    expect(projection.providerSessions).toEqual([]);
    expect(derivePendingThreadRequests(projection).userInputs).toEqual([
      {
        requestId,
        createdAt: "2026-06-20T00:00:00.000Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "next",
            header: "Next",
            question: "What should happen next?",
            required: true,
            allowCustomAnswer: false,
            multiSelect: false,
            options: [{ label: "Continue", value: "  continue  ", description: "Resume work" }],
          },
        ],
      },
    ]);
  });

  it("only marks asynchronous questions as dismissible", () => {
    const live = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        responseCapability: {
          type: "live" as const,
          providerSessionId: ProviderSessionId.make("live-session"),
        },
      })),
      turnItems: projection.turnItems.map((item) =>
        item.type === "user_input_request" ? { ...item, responseMode: undefined } : item,
      ),
    };
    expect(derivePendingThreadRequests(live).userInputs[0]?.dismissible).toBe(false);
  });

  it("removes answered requests from the composer while retaining their answers in projection data", () => {
    const answered = {
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved" as const,
        resolvedAt: v2Now,
        answers: { next: "  continue  " },
      })),
    };
    expect(derivePendingThreadRequests(answered).userInputs).toEqual([]);
    expect(answered.runtimeRequests[0]?.answers).toEqual({ next: "  continue  " });
  });
});

it("restores old text answers without mutating history or replacing unchanged rows", () => {
  const project = createQuestionHistoryProjector();
  const item = projection.turnItems[0]!;
  const row = {
    item,
    position: 0,
    sourceItemId: item.id,
    sourceThreadId: item.threadId,
    visibility: "local" as const,
  };
  const rows = [row];
  const pending = { visibleTurnItems: rows, runtimeRequests: projection.runtimeRequests };
  expect(project(pending)).toBe(rows);
  const answered = {
    ...pending,
    runtimeRequests: [
      {
        ...projection.runtimeRequests[0]!,
        status: "resolved" as const,
        answers: { next: "Continue" },
      },
    ],
  };
  const result = project(answered);
  expect(result[0]?.item).toMatchObject({
    questionAnswer: {
      answers: { next: "Continue" },
      attachmentsByQuestionId: {},
      questionTextById: { next: "What should happen next?" },
    },
  });
  expect(row.item).not.toHaveProperty("questionAnswer");
  expect(project(answered)).toBe(result);
  expect(project({ ...answered, visibleTurnItems: [...rows] })[0]).toBe(result[0]);
});

type Item = OrchestrationV2ThreadProjection["turnItems"][number];
const editRequest = {
  ...projection.runtimeRequests[0]!,
  id: RuntimeRequestId.make("edit-request"),
  kind: "file-change" as const,
  providerTurnId: ProviderTurnId.make("edit-turn"),
  // A request identity is not a tool identity.
  nativeRequestRef: {
    driver: ProviderDriverKind.make("acpRegistry"),
    nativeId: "permission-request",
    strength: "weak" as const,
  },
  responseCapability: {
    type: "live" as const,
    providerSessionId: ProviderSessionId.make("edit-session"),
  },
};
const editApproval: Extract<Item, { type: "approval_request" }> = {
  ...projection.turnItems[0]!,
  type: "approval_request",
  id: TurnItemId.make("edit-approval"),
  requestId: editRequest.id,
  requestKind: "file-change",
  prompt: "Changed files",
  runId: RunId.make("edit-run"),
  providerThreadId: ProviderThreadId.make("edit-provider-thread"),
  providerTurnId: editRequest.providerTurnId,
  nativeItemRef: {
    driver: ProviderDriverKind.make("acpRegistry"),
    nativeId: "edit-tool",
    strength: "weak",
  },
  options: [
    { decision: "accept", label: "Allow this edit" },
    { decision: "decline", label: "Reject" },
  ],
};
const editFile: Extract<Item, { type: "file_change" }> = {
  ...editApproval,
  type: "file_change",
  id: TurnItemId.make("edit-file"),
  nativeItemRef: { ...editApproval.nativeItemRef!, strength: "strong" },
  fileName: "/workspace/value.cjs",
};
const editProjection = {
  ...v2Projection,
  runtimeRequests: [editRequest],
  turnItems: [editApproval, editFile],
};

describe("pending file approval display details", () => {
  it("joins the unique scoped tool identity without changing the request or its authority", () => {
    const before = structuredClone(editProjection);
    const approval = derivePendingThreadRequests(editProjection).approvals[0];
    expect(approval).toMatchObject({
      requestId: editRequest.id,
      detail: "Changed files",
      options: editApproval.options,
      responseCapability: "live",
      fileChange: { fileName: "/workspace/value.cjs" },
    });
    expect(approval?.fileChange).not.toHaveProperty("diffStr");
    expect(editProjection).toEqual(before);
    expect(editApproval.nativeItemRef?.strength).toBe("weak");
  });

  it("copies only supplied patches, including structured file changes", () => {
    const file = {
      ...editFile,
      diffStr: "--- a/value.cjs\n+++ b/value.cjs\n-old\n+new",
      oldStr: "not a patch",
      newStr: "do not synthesize",
      changes: [
        { operation: "update" as const, path: "/workspace/value.cjs", diffStr: "-one\n+two" },
      ],
    };
    const approval = derivePendingThreadRequests({
      ...editProjection,
      turnItems: [editApproval, file],
    }).approvals[0];
    expect(approval?.fileChange).toEqual({
      fileName: file.fileName,
      diffStr: file.diffStr,
      changes: file.changes,
    });
    const noPatch = derivePendingThreadRequests({
      ...editProjection,
      turnItems: [editApproval, { ...editFile, oldStr: "old", newStr: "new" }],
    }).approvals[0];
    expect(noPatch?.fileChange).toEqual({ fileName: editFile.fileName });
  });

  it.each([
    ["thread", { threadId: ThreadId.make("other-thread") }],
    ["provider thread", { providerThreadId: ProviderThreadId.make("other-provider-thread") }],
    ["provider turn", { providerTurnId: ProviderTurnId.make("other-turn") }],
    ["run", { runId: RunId.make("other-run") }],
    [
      "driver",
      {
        nativeItemRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "edit-tool",
          strength: "strong",
        },
      },
    ],
    [
      "native ID",
      {
        nativeItemRef: {
          driver: ProviderDriverKind.make("acpRegistry"),
          nativeId: "another-tool",
          strength: "strong",
        },
      },
    ],
    ["missing native ID", { nativeItemRef: null }],
    [
      "null native ID",
      {
        nativeItemRef: {
          driver: ProviderDriverKind.make("acpRegistry"),
          nativeId: null,
          strength: "weak",
        },
      },
    ],
  ] as const)("does not join a file with a different %s", (_label, fields) => {
    expect(
      derivePendingThreadRequests({
        ...editProjection,
        turnItems: [editApproval, { ...editFile, ...fields }],
      }).approvals[0],
    ).not.toHaveProperty("fileChange");
  });

  it("does not use the permission request identity as a fallback tool identity", () => {
    const file = { ...editFile, nativeItemRef: editRequest.nativeRequestRef };
    expect(
      derivePendingThreadRequests({ ...editProjection, turnItems: [editApproval, file] })
        .approvals[0],
    ).not.toHaveProperty("fileChange");
  });

  it.each(["file", "approval"])(
    "retains the original prompt when %s matches are ambiguous",
    (kind) => {
      const duplicate =
        kind === "file"
          ? { ...editFile, id: TurnItemId.make("second-file"), fileName: "/workspace/other.cjs" }
          : { ...editApproval, id: TurnItemId.make("second-approval") };
      expect(
        derivePendingThreadRequests({
          ...editProjection,
          turnItems: [...editProjection.turnItems, duplicate],
        }).approvals[0],
      ).toMatchObject({ detail: "Changed files", requestId: editRequest.id });
      expect(
        derivePendingThreadRequests({
          ...editProjection,
          turnItems: [...editProjection.turnItems, duplicate],
        }).approvals[0],
      ).not.toHaveProperty("fileChange");
    },
  );

  it("rejects missing or stale approval scope even when native IDs match", () => {
    for (const fields of [
      { providerTurnId: null },
      { providerThreadId: null },
      { runId: null },
      { nativeItemRef: null },
      { nativeItemRef: { ...editApproval.nativeItemRef!, nativeId: null } },
      { threadId: ThreadId.make("other-thread") },
    ]) {
      const anchor = { ...editApproval, ...fields };
      expect(
        derivePendingThreadRequests({
          ...editProjection,
          turnItems: [anchor, { ...editFile, ...fields }],
        }).approvals[0],
      ).not.toHaveProperty("fileChange");
    }
    expect(
      derivePendingThreadRequests({
        ...editProjection,
        runtimeRequests: [{ ...editRequest, providerTurnId: ProviderTurnId.make("new-turn") }],
      }).approvals[0],
    ).not.toHaveProperty("fileChange");
  });

  it("keeps not-resumable authority and removes resolved requests", () => {
    expect(
      derivePendingThreadRequests({
        ...editProjection,
        runtimeRequests: [
          { ...editRequest, responseCapability: { type: "not_resumable", reason: "native ended" } },
        ],
      }).approvals[0],
    ).toMatchObject({
      responseCapability: "not_resumable",
      fileChange: { fileName: editFile.fileName },
    });
    expect(
      derivePendingThreadRequests({
        ...editProjection,
        runtimeRequests: [{ ...editRequest, status: "resolved" }],
      }).approvals,
    ).toEqual([]);
    expect(
      derivePendingThreadRequests({
        ...editProjection,
        runtimeRequests: [{ ...editRequest, kind: "command" }],
      }).approvals[0],
    ).not.toHaveProperty("fileChange");
  });

  it("keeps every supplied Codex patch, including one the wire bounded", () => {
    // The wire strips the item body but keeps each change's patch, bounded at 32 KiB.
    const codex = ProviderDriverKind.make("codex");
    const largePatch = `@@ -1 +1 @@\n${"-old line\n+new line\n".repeat(4_000)}`;
    const boundedPatch = `${largePatch.slice(0, 32 * 1024)}${TRANSPORT_TRUNCATION_MARKER}`;
    const changes = [
      { operation: "update", path: "/workspace/small.ts", diffStr: "@@ -1 +1 @@\n-a\n+b\n" },
      {
        operation: "update",
        path: "/workspace/large.ts",
        diffStr: boundedPatch,
        additions: 4_000,
        deletions: 4_000,
      },
      { operation: "add", path: "/workspace/new.ts", diffStr: "@@ -0,0 +1 @@\n+export {};\n" },
    ];
    const approval = {
      ...editApproval,
      nativeItemRef: { ...editApproval.nativeItemRef!, driver: codex },
    };
    const file = {
      ...editFile,
      nativeItemRef: { ...editFile.nativeItemRef!, driver: codex },
      diffOmitted: true,
      changes,
    };
    const pending = derivePendingThreadRequests({
      ...editProjection,
      runtimeRequests: [
        { ...editRequest, nativeRequestRef: { ...editRequest.nativeRequestRef, driver: codex } },
      ],
      turnItems: [approval, file],
    }).approvals[0];
    expect(pending?.fileChange).toEqual({ fileName: file.fileName, changes });
    expect(pending?.fileChange?.changes?.map((change) => change.diffStr)).toEqual(
      changes.map((change) => change.diffStr),
    );
    expect(pending?.fileChange?.changes?.[1]?.diffStr?.endsWith(TRANSPORT_TRUNCATION_MARKER)).toBe(
      true,
    );
  });
});

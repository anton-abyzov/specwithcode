/* Synthetic decisions only. No native sessions, accounts, credentials or provider calls. */
export * from "../project-workspace/mocks";
import * as base from "../project-workspace/mocks";
import { useState, useSyncExternalStore } from "react";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  RuntimeRequestId,
  ProviderDriverKind,
  NodeId,
  ProviderTurnId,
  ProviderThreadId,
  ProviderSessionId,
  RunId,
  TurnItemId,
  type EnvironmentId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { derivePendingThreadRequests } from "@specweave-studio/client-runtime/state/thread-requests";
import { CoordinatorNativeControls } from "../../src/components/studio/CoordinatorNativeControls";
import { useComposerDraftStore } from "../../src/composerDraftStore";
import {
  questionAttachmentDraftId,
  useQuestionAttachmentPreparation,
} from "../../src/questionAttachments";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../src/pendingUserInput";
import type { PendingUserInput } from "../../src/session-logic";
import type { AttachmentUploadState } from "../../src/lib/attachmentUploadState";
const scenario = new URLSearchParams(location.search).get("request") ?? "approval";
const isFileApproval = scenario === "file-approval" || scenario === "file-approval-no-patch";
const isApproval = scenario === "approval" || isFileApproval;
const receipts = {
  approvals: [] as unknown[],
  answers: [] as unknown[],
  plans: [] as unknown[],
  uploads: [] as unknown[],
  releases: [] as string[],
  outputReads: [] as unknown[],
};
(window as unknown as { __coordinatorReviewReceipts: unknown }).__coordinatorReviewReceipts =
  receipts;
export const useThreadShells = () =>
  base.useThreadShells().map((thread) =>
    thread.id !== "coord"
      ? thread
      : {
          ...thread,
          hasPendingApprovals: isApproval,
          hasPendingUserInput: scenario === "question",
          hasActionableProposedPlan: scenario === "plan",
        },
  );
const item = {
  id: "fixture-command",
  threadId: "coord",
  runId: "fixture-run",
  ordinal: 1,
  type: "command_execution",
  status: "completed",
  title: "Run unit tests",
  input: "npm run test:unit",
  outputOmitted: true,
  updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:00Z"),
  exitCode: 0,
};
export const useThreadProjection = () => {
  const source = base.useThreadProjection();
  if (scenario !== "activity") return source;
  return {
    projection: {
      ...source.projection,
      messages: source.projection.messages.map((message) => ({ ...message, runId: "fixture-run" })),
      runs: [
        { id: "fixture-run", status: "completed", ordinal: 1, requestedAt: "2026-10-13T12:00:00Z" },
      ],
      turnItems: [item],
    },
  };
};
export const useTurnItemDetail = (target: unknown) => {
  if (target) receipts.outputReads.push(target);
  return {
    data: target
      ? {
          item: {
            ...item,
            outputOmitted: false,
            output: "✓ 327 tests passed\n\nSynthetic fixture output. No command was executed.",
          },
        }
      : undefined,
    isPending: false,
    error: null,
  };
};
const uploadListeners = new Set<() => void>();
let uploadStates: Record<string, AttachmentUploadState> = {};
export const useAttachmentUploadStore = (
  select: (state: { uploadsByImageId: typeof uploadStates }) => unknown,
) => {
  const value = useSyncExternalStore(
    (listener) => {
      uploadListeners.add(listener);
      return () => uploadListeners.delete(listener);
    },
    () => uploadStates,
    () => uploadStates,
  );
  return select({ uploadsByImageId: value });
};
export const startAttachmentUpload = ({
  environmentId,
  image,
  draftTarget,
}: {
  environmentId: EnvironmentId;
  image: { id: string; name: string };
  draftTarget?: unknown;
}) => {
  if (uploadStates[image.id]) return;
  receipts.uploads.push({ environmentId, id: image.id, name: image.name, draftTarget });
  uploadStates = {
    ...uploadStates,
    [image.id]: { status: "ready", environmentId, attachmentId: `fixture-${image.id}` },
  };
  for (const listener of uploadListeners) listener();
};
export const releaseDraftAttachment = (image: { id: string }) => {
  receipts.releases.push(image.id);
};
export const releaseDraftAttachments = (images: { id: string }[]) => {
  for (const image of images) releaseDraftAttachment(image);
};
export const retryAttachmentUpload = startAttachmentUpload;
export const prepareImageForAttachment = async (file: File) => ({ ok: true, file });
export const isHeicImageFile = (file: { name: string }) => /\.hei[cf]$/i.test(file.name);
const questions: PendingUserInput["questions"] = [
  {
    id: "destination",
    header: "Destination",
    question: "Where should the verified report be saved?",
    options: [
      { label: "Project reports", description: "Keep the report with this project's work." },
      { label: "Downloads", description: "Save a local copy to review." },
    ],
    multiSelect: false,
  },
  {
    id: "context",
    header: "Context",
    question: "What should the review focus on? You can attach supporting files.",
    options: [],
    multiSelect: false,
  },
];
function fileApprovals(threadId: ThreadId) {
  const createdAt = DateTime.makeUnsafe("2026-10-14T12:00:00Z");
  const request = {
    id: RuntimeRequestId.make("fixture-edit-approval"),
    nodeId: NodeId.make("fixture-edit-node"),
    providerTurnId: ProviderTurnId.make("fixture-edit-turn"),
    nativeRequestRef: null,
    kind: "file-change" as const,
    status: "pending" as const,
    responseCapability: {
      type: "live" as const,
      providerSessionId: ProviderSessionId.make("fixture-session"),
    },
    createdAt,
    resolvedAt: null,
  };
  const approval = {
    id: TurnItemId.make("fixture-approval-item"),
    threadId,
    runId: RunId.make("fixture-edit-run"),
    nodeId: request.nodeId,
    providerThreadId: ProviderThreadId.make("fixture-provider-thread"),
    providerTurnId: request.providerTurnId,
    nativeItemRef: {
      driver: ProviderDriverKind.make("acpRegistry"),
      nativeId: "fixture-edit-tool",
      strength: "weak" as const,
    },
    parentItemId: null,
    ordinal: 0,
    status: "pending" as const,
    title: null,
    startedAt: createdAt,
    completedAt: null,
    updatedAt: createdAt,
    type: "approval_request" as const,
    requestId: request.id,
    requestKind: "file-change" as const,
    prompt: "Changed files",
    options: [
      { decision: "decline" as const, label: "Decline" },
      { decision: "accept" as const, label: "Approve" },
    ],
  };
  const file = {
    ...approval,
    id: TurnItemId.make("fixture-file"),
    type: "file_change" as const,
    nativeItemRef: { ...approval.nativeItemRef, strength: "strong" as const },
    fileName: "/workspace/long directory/selected project/source/value.cjs",
    ...(scenario === "file-approval"
      ? {
          diffStr:
            "--- a/value.cjs\n+++ b/value.cjs\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;",
        }
      : {}),
  };
  return derivePendingThreadRequests({
    thread: { id: threadId },
    runtimeRequests: [request],
    turnItems: [approval, file],
  }).approvals;
}

export function NativeThreadFixture(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  reviewOnly?: boolean;
}) {
  if (!props.reviewOnly) return <base.NativeThreadFixture {...props} />;
  return <NativeDecisionFixture {...props} />;
}
function NativeDecisionFixture({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [approved, setApproved] = useState(false),
    [answered, setAnswered] = useState(false),
    [implemented, setImplemented] = useState(false);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [index, setIndex] = useState(0);
  const drafts = useComposerDraftStore((state) => state.draftsByThreadKey);
  const preparations = useQuestionAttachmentPreparation((state) => state.counts);
  const uploads = useAttachmentUploadStore(
    (state) => state.uploadsByImageId,
  ) as typeof uploadStates;
  const requestId = RuntimeRequestId.make("fixture-question");
  const resolved = Object.fromEntries(
    questions.map((question) => {
      const target = questionAttachmentDraftId(environmentId, threadId, requestId, question.id);
      const draft = drafts[target],
        attachments = draft ? [...draft.images, ...draft.files] : [];
      return [
        question.id,
        {
          ...answers[question.id],
          attachmentCount: attachments.length,
          attachmentsBlocked:
            (preparations[target] ?? 0) > 0 ||
            attachments.some((attachment) => uploads[attachment.id]?.status !== "ready"),
        },
      ];
    }),
  );
  const progress = derivePendingUserInputProgress(questions, resolved, index);
  return (
    <CoordinatorNativeControls
      markdownContext={{
        environmentId,
        threadRef: scopeThreadRef(environmentId, threadId),
        cwd: "/scratch/atlas",
      }}
      loading={false}
      disabled={false}
      error={null}
      approvals={
        isApproval && !approved
          ? isFileApproval
            ? fileApprovals(threadId)
            : [
                {
                  requestId: RuntimeRequestId.make("fixture-approval"),
                  requestKind: "command",
                  responseCapability: "live",
                  createdAt: "2026-10-13T12:00:00Z",
                  detail: "npm run test:unit -- coordinator-recovery",
                  options: [
                    { decision: "decline", label: "Decline" },
                    { decision: "accept", label: "Approve" },
                  ],
                },
              ]
          : []
      }
      respondingApprovals={[]}
      onApproval={async (id, decision) => {
        receipts.approvals.push({ environmentId, threadId, requestId: id, decision });
        setApproved(true);
      }}
      questions={
        scenario === "question" && !answered
          ? [
              {
                requestId,
                responseCapability: "live",
                createdAt: "2026-10-13T12:00:00Z",
                questions,
                dismissible: true,
              },
            ]
          : []
      }
      answers={resolved}
      questionIndex={index}
      progress={progress}
      respondingQuestions={[]}
      onOption={(id, value) =>
        setAnswers((current) => ({
          ...current,
          [id]: togglePendingUserInputOptionSelection(
            questions.find((question) => question.id === id)!,
            current[id],
            value,
          ),
        }))
      }
      onCustomAnswer={(id, value) =>
        setAnswers((current) => ({
          ...current,
          [id]: setPendingUserInputCustomAnswer(current[id], value),
        }))
      }
      onPrevious={() => setIndex((current) => Math.max(0, current - 1))}
      onAdvance={() => {
        if (!progress.canAdvance) return;
        if (!progress.isLastQuestion) {
          setIndex((current) => current + 1);
          return;
        }
        receipts.answers.push({
          requestId,
          answers: buildPendingUserInputAnswers(questions, resolved),
          attachments: questions.map((question) => {
            const target = questionAttachmentDraftId(
              environmentId,
              threadId,
              requestId,
              question.id,
            );
            const draft = drafts[target];
            return {
              questionId: question.id,
              names: draft
                ? [...draft.images, ...draft.files].map((attachment) => attachment.name)
                : [],
            };
          }),
        });
        setAnswered(true);
      }}
      onDismiss={(id) => {
        receipts.answers.push({ requestId: id, dismissed: true });
        setAnswered(true);
      }}
      questionAttachmentContext={{ environmentId, threadId, maxFileBytes: 50 * 1024 * 1024 }}
      planMarkdown={
        scenario === "plan" && !implemented
          ? "# Coordinator recovery\n\nKeep the conversation in place while handling provider failures.\n\n1. Verify the selected Copilot model before starting a turn.\n2. Preserve the message and its attachments on retry.\n3. Review native decisions in this dialog.\n\nNo production action is part of this synthetic plan."
          : null
      }
      onImplementPlan={async () => {
        receipts.plans.push({ synthetic: true, action: "implement" });
        setImplemented(true);
        return true;
      }}
    />
  );
}
export const EMPTY_SERVER_PROVIDERS = [];
export const awaitAttachmentUploads = async () => {};
export const getUploadedAttachments = ({
  images,
}: {
  images: { id: string; name: string; mimeType: string; sizeBytes: number; type: string }[];
}) => images.map((image) => ({ ...image, attachmentId: `fixture-${image.id}` }));
export const useServerConfigs = () => new Map();
export const formatEnvironmentQueryError = (error: unknown) =>
  error instanceof Error ? error.message : null;
const fixtureServerSettings = Atom.make(DEFAULT_SERVER_SETTINGS);
const fixtureServerConfig = Atom.make({
  availableEditors: [],
  providers: [],
  environment: { capabilities: {} },
});
export const serverEnvironment = {
  ...base.serverEnvironment,
  configValueAtom: () => fixtureServerConfig,
  settingsValueAtom: () => fixtureServerSettings,
};
export const readEnvironmentSupportsServerBrowser = () => false;
export const useEnvironmentSupportsServerBrowser = () => false;
export const resolveAssetUrl = () => null;
const emptySearch = {
  matches: [],
  entries: [],
  results: [],
  data: null,
  query: "",
  isPending: false,
  error: null,
  refresh: () => {},
};
export const useProjectPathSearch = () => emptySearch;
export const useComposerPathSearch = () => emptySearch;
export const useProjectContentSearch = () => emptySearch;
export const useThreadSearch = () => emptySearch;
export const useCheckpointDiff = () => emptySearch;
export const usePaginatedBranches = () => emptySearch;
export const useDebouncedValue = <T,>(value: T) => value;
export const areProjectPathSearchTargetsEqual = (left: unknown, right: unknown) => left === right;

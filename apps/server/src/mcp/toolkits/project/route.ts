// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  type ChatAttachment,
  ChatAttachmentId,
  CommandId,
  type MessageId,
  OrchestratorMcpFailure,
  type Project,
  type ProjectId,
  type ProjectWorkspaceError,
  type RunId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { routedMessageNote, routedMessageText } from "@specweave-studio/shared/routedMessage";
import { formatStudioThreadLink } from "@specweave-studio/shared/studioThreadLinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import {
  parseAttachmentFileExtension,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../../../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectCoordinator from "../../../project/ProjectCoordinatorService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import {
  assistantFolders,
  grantingFolder,
  routeRefusalMessage,
  ROUTE_NOT_ASKED_MESSAGE,
  routeStateRefusal,
  type RouteRefusal,
  userAskedIn,
} from "../../../project/projectRouting.ts";
import { workerFollowUpText } from "../../../project/workerFollowUp.ts";
import {
  assertTargetWithinLimits,
  type Caller,
  loadCaller,
  unavailable,
} from "../../threadAccess.ts";

const GOAL_PREVIEW_CHARS = 400;
const RECENT_THREADS = 5;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** The calling thread must be a personal assistant's coordinator. */
const requireAssistant = Effect.fn("mcp.route.requireAssistant")(function* (context: Caller) {
  const caller = context.caller;
  if (caller === undefined)
    return yield* failure(
      "invalid_request",
      "Only a personal assistant's coordinator routes requests between projects.",
    );
  const projects = yield* ProjectService.ProjectService;
  const found = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
  const assistant = Option.getOrUndefined(found);
  if (
    assistant === undefined ||
    assistant.workspaceSettings?.kind !== "personal" ||
    assistant.workspaceSettings.coordinatorThreadId !== caller.id
  )
    return yield* failure(
      "capability_denied",
      "Only a personal assistant's coordinator routes requests between projects. A project coordinator starts its own workers with delegate_task.",
    );
  return { caller, assistant };
});

/** Real paths of the assistant's own and approved folders; a missing folder is no evidence. */
const realFolders = Effect.fn("mcp.route.realFolders")(function* (assistant: Project) {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* Effect.forEach(assistantFolders(assistant), (folder) =>
    fileSystem.realPath(folder).pipe(
      Effect.map((real) => [{ folder, real }]),
      Effect.orElseSucceed(() => []),
    ),
  );
  return entries.flat();
});

/** Null when the folder cannot be resolved: a lexical path could hide a symlink out. */
const realPathOrNull = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.realPath(path)),
    Effect.orElseSucceed(() => null),
  );

interface Evaluated {
  readonly project: Project;
  readonly refusal: RouteRefusal | null;
  readonly grantedBy: string | null;
}

const evaluate = (
  assistant: Project,
  folders: ReadonlyArray<{ readonly folder: string; readonly real: string }>,
  project: Project,
) =>
  Effect.gen(function* () {
    const real = yield* realPathOrNull(project.workspaceRoot);
    const grantedBy = real === null ? null : grantingFolder(folders, real);
    const refusal =
      routeStateRefusal(assistant, project) ?? (grantedBy === null ? "outside_folders" : null);
    return { project, refusal, grantedBy } satisfies Evaluated;
  });

/** The user message the caller's live turn answers, when the user wrote it. */
const turnMessageId = (threads: Caller["threads"], threadId: ThreadId, activeRunId: RunId | null) =>
  Effect.gen(function* () {
    if (activeRunId === null) return undefined;
    const { runs } = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(unavailable));
    return runs.find((run) => run.id === activeRunId)?.userMessageId;
  });

export const routeTargets = Effect.fn("mcp.route.targets")(function* () {
  const context = yield* loadCaller();
  const { caller, assistant } = yield* requireAssistant(context);
  const projects = yield* ProjectService.ProjectService;
  const turnMessage = yield* turnMessageId(context.threads, caller.id, caller.activeRunId);
  const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
  const folders = yield* realFolders(assistant);
  const rows = yield* Effect.forEach(
    snapshot.projects.filter(
      (project) => project.deletedAt === null && project.id !== assistant.id,
    ),
    (project) => evaluate(assistant, folders, project),
  );
  const targets = yield* Effect.forEach(
    rows.filter((row) => row.refusal === null),
    ({ project, grantedBy }) =>
      Effect.gen(function* () {
        const settings = project.workspaceSettings;
        const shells = yield* context.threads
          .listProjectThreads({ projectId: project.id, includeSubagents: false })
          .pipe(Effect.orElseSucceed(() => []));
        const coordinatorId = settings?.coordinatorThreadId ?? null;
        const coordinator = shells.find((shell) => shell.id === coordinatorId);
        // Titles and statuses only: who owns what. The project's memory stays its own.
        const recent = shells
          .filter((shell) => shell.id !== coordinatorId && shell.archivedAt === null)
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
          )
          .slice(0, RECENT_THREADS)
          .map((shell) => ({
            title: shell.title,
            status: shell.status,
            threadLink: formatStudioThreadLink(shell.id, shell.title),
          }));
        const goal = settings?.goal ?? "";
        return {
          projectId: project.id,
          title: project.title,
          kind: settings?.kind ?? "code",
          workspaceRoot: project.workspaceRoot,
          grantedBy: grantedBy!,
          goal:
            goal.length > GOAL_PREVIEW_CHARS ? `${goal.slice(0, GOAL_PREVIEW_CHARS - 1)}…` : goal,
          coordinatorLink:
            coordinator === undefined
              ? null
              : formatStudioThreadLink(coordinator.id, coordinator.title),
          recentThreads: recent,
        };
      }),
  );
  return {
    assistant: assistant.title,
    turnMessageId: turnMessage ?? null,
    targets,
    unavailable: rows
      .filter((row) => row.refusal !== null)
      .map(({ project, refusal }) => ({
        projectId: project.id,
        title: project.title,
        reason: routeRefusalMessage(refusal!, {
          assistant: assistant.title,
          target: project.title,
        }),
      })),
  };
});

/** One stable identity per (assistant thread, message, target project). */
export function routeKey(input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly projectId: string;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.threadId, input.messageId, input.projectId]))
    .digest("hex")
    .slice(0, 32);
}

function uuidFrom(key: string, attachmentId: string): string {
  const hash = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([key, attachmentId]))
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Copies the source message's saved files to pending uploads whose IDs derive
 * from the route, so a retry stages the same IDs and the coordinator send's
 * receipt recognises it. The bytes stay on this host; nothing is re-uploaded.
 */
const restageAttachments = Effect.fn("mcp.route.restageAttachments")(function* (
  key: string,
  attachments: ReadonlyArray<ChatAttachment>,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.forEach(
    attachments,
    (attachment) =>
      Effect.gen(function* () {
        const unavailableFile = failure(
          "invalid_request",
          `The file "${attachment.name}" on that message is no longer stored here. Ask the user to attach it again in the target project.`,
        );
        const source = resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: attachment.id,
        });
        if (source === null) return yield* unavailableFile;
        const extension = parseAttachmentFileExtension(attachment.id);
        const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuidFrom(key, attachment.id)}${
          extension === null ? "" : `-${extension}`
        }`;
        const target = resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: `${pendingId}${NodePath.extname(source)}`,
        });
        if (target === null) return yield* unavailableFile;
        // Always a fresh copy of the saved upload, never a file already sitting at the
        // derived name: that name is predictable, so it is no proof of what it holds.
        const partial = `${target}.${NodeCrypto.randomUUID()}.part`;
        yield* fileSystem.copyFile(source, partial).pipe(
          Effect.andThen(fileSystem.rename(partial, target)),
          Effect.tapError(() => fileSystem.remove(partial).pipe(Effect.ignore)),
          Effect.mapError(() => unavailableFile),
          Effect.uninterruptible,
        );
        return { ...attachment, id: ChatAttachmentId.make(pendingId) } satisfies ChatAttachment;
      }),
    { concurrency: 1 },
  );
});

const routeFailure = (error: ProjectWorkspaceError, target: string) => {
  switch (error.code) {
    case "paused":
    case "archived":
    case "transferred":
      return failure(
        "invalid_request",
        routeRefusalMessage(error.code, { assistant: "this assistant", target }),
      );
    case "model_required":
    case "unsupported_provider":
      return failure(
        "invalid_request",
        `${target} has no coordinator model that can run on this machine. The user picks one in that project; tell them.`,
      );
    case "attachment_unavailable":
    case "invalid_attachments":
    case "attachment_limit":
      return failure(
        "invalid_request",
        "The message's files could not be passed on. Ask the user to attach them in the target project.",
      );
    case "update_in_progress":
      return failure(
        "orchestration_error",
        "SpecWithCode is installing an update. Route the message again once it finishes; it will be delivered once.",
      );
    case "conflict":
      return failure(
        "invalid_request",
        "This message was already routed to that project with different content; it was not sent again.",
      );
    default:
      return unavailable();
  }
};

export const routeToProject = Effect.fn("mcp.route.toProject")(function* (input: {
  readonly projectId: ProjectId;
  readonly forwardMessageId?: MessageId | undefined;
  readonly note?: string | undefined;
  readonly userAsked: string;
}) {
  const context = yield* loadCaller();
  const { caller, assistant } = yield* requireAssistant(context);
  const projects = yield* ProjectService.ProjectService;
  const target = Option.getOrUndefined(
    yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable)),
  );
  const names = { assistant: assistant.title, target: target?.title ?? "That project" };
  const stateRefusal = routeStateRefusal(assistant, target);
  if (stateRefusal !== null || target === undefined)
    return yield* failure(
      "invalid_request",
      routeRefusalMessage(stateRefusal ?? "not_found", names),
    );
  const evaluated = yield* evaluate(assistant, yield* realFolders(assistant), target);
  if (evaluated.refusal !== null)
    return yield* failure("invalid_request", routeRefusalMessage(evaluated.refusal, names));

  // Only what the user wrote here is routed as theirs. Omitted: the message
  // that started this turn, the one the assistant is answering.
  const turnMessage = yield* turnMessageId(context.threads, caller.id, caller.activeRunId);
  const forwardMessageId = input.forwardMessageId ?? turnMessage;
  if (forwardMessageId === undefined)
    return yield* failure(
      "invalid_request",
      "This turn did not start from a message the user wrote. Pass forwardMessageId.",
    );
  const { messages } = yield* context.threads
    .getThreadRecords(caller.id, ["messages"], {
      messageIds: turnMessage === undefined ? [forwardMessageId] : [forwardMessageId, turnMessage],
    })
    .pipe(Effect.mapError(unavailable));
  const userWrote = (id: MessageId | undefined) => {
    const found = messages.find((candidate) => candidate.id === id);
    return found !== undefined && found.role === "user" && found.createdBy === "user"
      ? found
      : undefined;
  };
  const message = userWrote(forwardMessageId);
  if (message === undefined)
    return yield* failure(
      "invalid_request",
      `Message ${forwardMessageId} is not a message the user wrote in this conversation.`,
    );
  const words = (workerFollowUpText(message) ?? message.text).trim();
  if (words === "" && message.attachments.length === 0)
    return yield* failure("invalid_request", "That message has nothing to route.");
  // The assistant's chat stays apart from project chats: it posts into one only
  // when the user asked, in the routed message or in the reply that started this
  // turn (a yes to an offer to send it).
  const reply = userWrote(turnMessage);
  const asked = [words, ...(reply === undefined ? [] : [workerFollowUpText(reply) ?? reply.text])];
  if (reply === undefined || !userAskedIn(input.userAsked, asked))
    return yield* failure("invalid_request", ROUTE_NOT_ASKED_MESSAGE);

  const coordinator = yield* ProjectCoordinator.ProjectCoordinatorService;
  const modes = yield* coordinator
    .coordinatorModes(target.id)
    .pipe(Effect.mapError((error) => routeFailure(error, target.title)));
  yield* assertTargetWithinLimits(context.limits, modes).pipe(
    Effect.mapError((error) =>
      error.code === "interaction_mode_escalation_denied"
        ? failure(
            "interaction_mode_escalation_denied",
            `${target.title}'s coordinator runs in ${modes.interactionMode} mode, broader than this conversation's ${context.limits.interactionMode}. The user can send it there directly.`,
          )
        : failure(
            "runtime_mode_escalation_denied",
            `${target.title}'s coordinator runs in ${modes.runtimeMode} mode, broader than this conversation's ${context.limits.runtimeMode}. The user can send it there directly.`,
          ),
    ),
  );

  const key = routeKey({
    threadId: caller.id,
    messageId: forwardMessageId,
    projectId: target.id,
  });
  const attachments = yield* restageAttachments(key, message.attachments);
  const note = routedMessageNote(input.note);
  const result = yield* coordinator
    .route({
      projectId: target.id,
      commandId: CommandId.make(`route:${key}`),
      text: routedMessageText(
        {
          assistantTitle: assistant.title,
          threadId: caller.id,
          messageId: forwardMessageId,
          note,
        },
        words,
      ),
      senderThreadId: caller.id,
      attachments,
    })
    .pipe(Effect.mapError((error) => routeFailure(error, target.title)));
  const shell = yield* context.threads
    .getThreadShell(result.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  const title = shell?.title || `${target.title} coordinator`;
  return {
    projectId: target.id,
    projectTitle: target.title,
    grantedBy: evaluated.grantedBy!,
    coordinatorThreadId: result.threadId,
    coordinatorLink: formatStudioThreadLink(result.threadId, title),
    coordinatorCreated: result.created,
    messageId: result.messageId,
    attachments: attachments.length,
  };
});

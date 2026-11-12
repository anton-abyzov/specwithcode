import {
  WorktreeMcpFailure,
  OrchestratorMcpFailure,
  VcsListRefsInput,
  VcsListRefsResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpStatusResult,
  WorktreeMcpAddRepositoryInput,
  WorktreeMcpAddRepositoryResult,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeMcpService.WorktreeMcpService,
];

/** What handoff and status fail with, including the access gate's refusal. */
const WorktreeToolFailure = Schema.Union([WorktreeMcpFailure, OrchestratorMcpFailure]);

const WorktreeHandoffTool = Tool.make("studio_worktree_handoff", {
  description:
    "Needs an agent running inside a SpecWithCode thread. Move this agent thread into a new git worktree. To launch a separate agent already bound to a new or existing worktree, use studio_thread_launch with workspaceStrategy instead. Creates the worktree branch (optionally from origin), re-points the thread at the worktree, and by default runs the project's setup script there. Changing the workspace detaches the live provider session, so the current turn ends shortly after the handoff is recorded; call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt with the remaining work: it is queued as the thread's next message and starts a new turn inside the worktree with the conversation preserved. Without it the thread stays idle until the next message. The worktree is not removed automatically when the thread is deleted. Fails if the thread is already attached to a worktree, and refused while the project's Use worktrees setting is off: then keep working in the project folder, and the user must turn the setting on in the project's settings first.",
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hand off thread to a git worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeStatusTool = Tool.make("studio_worktree_status", {
  description:
    "Needs an agent running inside a SpecWithCode thread. Report this agent thread's worktree binding: whether it is attached to a git worktree, the worktree path and branch, the project's main workspace root, and the server default for studio_worktree_handoff's startFromOrigin. Call this before studio_worktree_handoff to check whether a handoff is possible or has already happened.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get thread worktree status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorktreeAddRepositoryTool = Tool.make("studio_worktree_add_repository", {
  description:
    "Needs an agent running inside a SpecWithCode thread that has its own folder: a worktree, a folder of several, or the empty folder a thread starts in when the project folder holds several repositories. Add a repository before changing it: it gets a worktree on the thread's branch inside the thread's folder, at its path relative to the project folder (a repository outside the project folder sits at the folder's top level under its own name), and the turn keeps running. Name it by its path relative to the project folder (studio_environment_read lists them), or by a project environment repository id or checkout path. The worktree is cut from the repository's checked-out branch, or from its default branch on origin when none is checked out; the result names what it was cut from. Nothing is installed: run the repository's normal install in the worktree only when you build or test there, never by linking another checkout's node_modules. Adding a repository the thread already has returns it. A thread holds at most 8 repositories, and an add is refused while the disk is low. Use this instead of `git worktree add`, and instead of editing or committing in the project folder's clones. Refused while the project's Use worktrees setting is off, or when the thread works in the project folder itself (move it with studio_worktree_handoff first).",
  parameters: WorktreeMcpAddRepositoryInput,
  success: WorktreeMcpAddRepositoryResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Add a repository to this thread's worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeListTool = Tool.make("studio_worktree_list", {
  description:
    "List branch refs and their associated checkout paths for a thread's workspace (omit threadId for this thread) using the app's ref inventory. Detached worktrees without a branch are not included. Use studio_worktree_status for the thread binding and studio_worktree_handoff to create a new worktree.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    query: VcsListRefsInput.fields.query,
    cursor: VcsListRefsInput.fields.cursor,
    limit: VcsListRefsInput.fields.limit,
    refKind: VcsListRefsInput.fields.refKind,
    includeMatchingRemoteRefs: VcsListRefsInput.fields.includeMatchingRemoteRefs,
  }),
  success: VcsListRefsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    GitWorkflowService.GitWorkflowService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeAddRepositoryTool,
  WorktreeListTool,
);

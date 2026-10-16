import { McpAttachmentInput } from "../attachment/input.ts";
import {
  NonNegativeInt,
  ModelSelection,
  TrimmedNonEmptyString,
  ThreadId,
  RunId,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  RuntimeMode,
  ProviderInteractionMode,
  Project,
  ProjectCreatePayload,
  ProjectUpdatePayload,
  ProjectId,
  OrchestratorMcpFailure,
  OrchestratorMcpMachineRef,
  OrchestratorMcpMachineTarget,
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
} from "@specweave-studio/contracts";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../../../config.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ProjectActionRequests from "../../../project/ProjectActionRequests.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SourceControlRepositoryService from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: Project,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Crypto.Crypto,
  ],
};
const ProjectListTool = Tool.make("studio_project_list", {
  ...shared,
  description:
    "List registered projects in this environment. Pages use the current project snapshot and may shift between calls.",
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    projects: Schema.Array(Project),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectReadTool = Tool.make("studio_project_read", {
  ...shared,
  description:
    "Read a registered project in this environment, including its workspace and saved scripts.",
  parameters: Schema.Struct({ projectId: ProjectId }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const ProjectCreateTool = Tool.make("studio_project_create", {
  ...shared,
  description:
    "Register a project directory through the existing project service. Set createWorkspaceRootIfMissing to create a directory. Omit workspaceRoot to start a new project from just its title: the app makes a Git repository for it in its own projects folder, with a README, an icon, and a first commit (commitError says why a commit failed; the project exists either way). Each call creates a new request; an existing registered workspace is rejected. Clone separately with studio_project_clone when needed.",
  parameters: Schema.Struct({
    ...ProjectCreatePayload.fields,
    workspaceRoot: Schema.optional(ProjectCreatePayload.fields.workspaceRoot),
  }),
  success: Schema.Struct({ ...Project.fields, commitError: Schema.optional(Schema.String) }),
  dependencies: [...shared.dependencies, ManagedProjectFolders.ManagedProjectFolders],
}).annotate(Tool.Destructive, true);
const ProjectUpdateTool = Tool.make("studio_project_update", {
  ...shared,
  description:
    "Update a registered project's settings. Omitted fields are preserved. Uses the same project service as the app. To move a project to another folder, or to archive, restore or delete it, use studio_project_request: the user approves those.",
  parameters: Schema.Struct({ projectId: ProjectId, ...ProjectUpdatePayload.fields }),
}).annotate(Tool.Destructive, true);
const ProjectRequestResult = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Literal("awaiting_user"),
  message: Schema.String,
});
const requestDependencies = [...shared.dependencies, ProjectActionRequests.ProjectActionRequests];
const ProjectRequestTool = Tool.make("studio_project_request", {
  ...shared,
  description:
    "Ask the user to archive, restore (unarchive), delete or move a project to another folder. SpecWithCode shows an approval card in your thread; only the user can answer it, and SpecWithCode makes the change itself when they approve. End your turn after calling: the decision and its outcome arrive as the user's answer to the card. For change_folder pass workspaceRoot, an existing folder; the card says whether it is a checkout of the same repository, and the change is refused while the project has other running work. Deleting removes the project's threads, memory, plans and routines but never its folders or Git branches.",
  parameters: Schema.Struct({
    action: ProjectActionRequests.ProjectAction,
    projectId: Schema.optional(
      ProjectId.annotate({ description: "Omitted means the calling thread's project." }),
    ),
    workspaceRoot: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "For change_folder: the absolute folder the project should use.",
      }),
    ),
    reason: TrimmedNonEmptyString.annotate({
      description: "One sentence the user reads on the card: why this change is needed.",
    }),
  }),
  success: ProjectRequestResult,
  dependencies: requestDependencies,
}).annotate(Tool.Destructive, true);
const ProjectDeleteTool = Tool.make("studio_project_delete", {
  ...shared,
  description:
    "Ask the user to delete a project. Same as studio_project_request with action delete: SpecWithCode shows an approval card in your thread and deletes the project only if the user approves. End your turn after calling. Deleting removes the project's threads, memory, plans and routines but never its folders or Git branches.",
  parameters: Schema.Struct({
    projectId: ProjectId,
    reason: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "One sentence the user reads on the card: why the project should go.",
      }),
    ),
  }),
  success: ProjectRequestResult,
  dependencies: requestDependencies,
}).annotate(Tool.Destructive, true);
const ProjectCloneTool = Tool.make("studio_project_clone", {
  ...shared,
  description:
    "Clone a repository using the app's source-control service. This only clones; register the returned cwd with studio_project_create. An existing destination is not adopted or removed on failure.",
  parameters: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  dependencies: [
    ...shared.dependencies,
    SourceControlRepositoryService.SourceControlRepositoryService,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);
const ThreadLaunchTool = Tool.make("studio_thread_launch", {
  ...shared,
  description:
    'Create an ordinary TOP-LEVEL thread with an explicit workspace binding before its agent starts. Use this when the user requests independent work, a new thread, or a PR stack in its own worktree; use delegate_task for child subagents. Set workspaceStrategy to {type:"worktree",baseRef:"parent-branch",branch:"new-branch",startFromOrigin:false} for a new worktree based on local commits, or {type:"existing_worktree",worktreePath:"/absolute/path",branch:"existing-branch"} to use an existing checkout. For upstream commits, set startFromOrigin:true. When the project holds nested repositories, add repository (an id from the project\'s environment repositories, or that checkout\'s absolute path) so git runs in that repository instead of the project root; a baseRef missing there fails rather than falling back to another branch. Omitted workspaceStrategy means the project root, NOT the caller\'s worktree. Pass effort when the user names one (\"extra high\" is xhigh). Omit projectId/modelSelection/modes to inherit those settings from the calling thread (a project coordinator uses the project worker model default); a caller outside a SpecWithCode thread must pass projectId and gets the project\'s default model. Set scratch:true instead of projectId for a thread without a project: it runs in a fresh folder of its own, outside any repository. Put the task in message. Do not ask the agent to create its own worktree via shell: that does not update the thread binding. Each call creates a new launch with no retry key; retain threadId and use studio_thread_read/studio_thread_wait to follow preparation. After errors or lost responses, inspect studio_thread_list before retrying. Attachments must be pending uploads. The new thread may not run with broader runtime or interaction modes than the caller: the calling SpecWithCode thread\'s own modes, or the permission mode an outside agent was approved with.',
  parameters: Schema.Struct({
    machine: Schema.optional(
      OrchestratorMcpMachineTarget.annotate({
        description:
          "Run the thread on another machine in the owner's fleet: its id or label from studio_machine_list, or \"local\" for this one. Omitted means the project's worker machine when a project coordinator calls, otherwise this machine. The thread runs in the matching project there, with no broader modes than the user allowed for that machine; its completion wakes the caller unless reportBack is false.",
      }),
    ),
    machineProjectId: Schema.optional(
      ProjectId.annotate({
        description:
          "The project on that machine, when studio_machine_list reports no single match. Its id there, not here.",
      }),
    ),
    reportBack: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "For a thread on another machine: wake the caller when its run finishes (default true).",
      }),
    ),
    projectId: Schema.optional(ProjectId),
    scratch: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Launch without a project, in its own folder under the environment's Scratch project. Not with projectId or workspaceStrategy.",
      }),
    ),
    title: TrimmedNonEmptyString,
    modelSelection: Schema.optional(ModelSelection),
    effort: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "Reasoning effort the user asked for, e.g. 'low', 'medium', 'high', 'xhigh' (extra high) or 'max'. Mapped to the chosen model's own effort option; when the model lacks that level the nearest one it offers is used, and a model without an effort setting is rejected.",
      }),
    ),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    workspaceStrategy: Schema.optional(
      OrchestrationV2ThreadLaunchWorkspaceStrategy.annotate({
        description:
          "Choose where this thread runs before starting its agent: worktree creates and binds a new checkout from baseRef; existing_worktree binds worktreePath, which must be one of the project's git worktrees; root uses the project checkout. On worktree and existing_worktree, repository picks one of the project's environment repositories (id or checkout path) to run git in; without it git runs in the project root. Omitted means root, not the caller's worktree. For a PR stack use the parent branch as baseRef and startFromOrigin:false. Uncommitted changes are not copied.",
      }),
    ),
    message: Schema.optional(
      Schema.String.check(Schema.isMaxLength(120000)).annotate({
        description:
          "First task prompt, delivered after workspace preparation. Omit message and attachments to create an idle thread.",
      }),
    ),
    attachments: Schema.optional(Schema.Array(McpAttachmentInput).check(Schema.isMaxLength(8))),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    threadLink: Schema.String.annotate({
      description:
        "Ready-made Markdown link to the new thread. Copy it verbatim when naming the thread to the user; never build a thread link by hand.",
    }),
    projectId: ProjectId,
    /** Always set for a thread here; unknown only for a remote launch found again after a lost answer. */
    modelSelection: Schema.optional(ModelSelection),
    effort: Schema.optional(
      Schema.String.annotate({
        description: "Reasoning effort option the thread was started with, when one was set.",
      }),
    ),
    runId: Schema.NullOr(RunId),
    status: Schema.NullOr(OrchestrationV2RunStatus),
    /** Set when the thread runs on another machine; projectId is then that machine's project. */
    machine: Schema.optional(OrchestratorMcpMachineRef),
    threadRef: Schema.optional(Schema.String),
    reportsBack: Schema.optional(Schema.Boolean),
  }),
  dependencies: [
    ...shared.dependencies,
    ThreadLaunchService.ThreadLaunchService,
    ManagedProjectFolders.ManagedProjectFolders,
    ProviderRegistry.ProviderRegistry,
    GitVcsDriver.GitVcsDriver,
    FileSystem.FileSystem,
    ServerConfig.ServerConfig,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ProjectToolkit = Toolkit.make(
  ThreadLaunchTool,
  ProjectListTool,
  ProjectReadTool,
  ProjectCreateTool,
  ProjectUpdateTool,
  ProjectRequestTool,
  ProjectDeleteTool,
  ProjectCloneTool,
);

import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpAskUserInput,
  OrchestratorMcpAskUserResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpHandoffReadyListInput,
  OrchestratorMcpHandoffReadyListResult,
  OrchestratorMcpThreadContinueHereInput,
  OrchestratorMcpThreadContinueHereResult,
  OrchestratorMcpThreadMigrateInput,
  OrchestratorMcpThreadMigrateResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  OrchestratorMcpThreadsBulkResult,
  OrchestratorMcpThreadsContinueAllInput,
  OrchestratorMcpThreadsStopAllInput,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "@specweave-studio/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as HandoffMode from "../../../handoff/HandoffMode.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the V2 provider instances and their current models from the same live catalog as the composer, including configured custom models, inherited runtime settings, and app-owned orchestration features available to this caller. For a separate top-level thread in a new or existing worktree, use studio_thread_launch with workspaceStrategy.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Needs an agent running inside a SpecWithCode thread. Delegate one task to a SpecWithCode-owned child of THIS thread (a coordinator's child is a worker; any other thread's child is its subagent) and run it with only the supplied task prompt, without copying parent conversation history. Choose providers and models from orchestrator_capabilities, which uses the same live catalog as the composer. Prefer native subagent tools for same-provider work only when they support the chosen model. Use this for any model missing from the native tool, including same-provider work, for cross-provider work, or for explicitly SpecWithCode-owned child tasks. For every SpecWithCode delegated review round, call delegate_task again with the original brief, prior findings, responses, and unresolved objections in the task prompt. Pass title, a few words naming the task; it becomes the child thread's name. End the task prompt by asking for a final result in your response style (a plain short message when that is enough). Track each round by its own taskId (internal; when talking to the user, refer to the child with the result's threadLink copied verbatim, and never build a thread link by hand) and use a distinct clientRequestId per round, stable across retries of that round. The childThreadId is backing storage, not the target for starting another delegated review round through studio_thread_send. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. When the user names a reasoning effort, pass it as target.effort (e.g. 'xhigh' for extra high); it maps to the model's nearest supported level, and unknown target keys are rejected. Prefer mode='async' for long work; mode='wait' blocks until completion or timeout. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later task_status. An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Needs an agent running inside a SpecWithCode thread. Read a SpecWithCode-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. When you tell the user, relay its outcome in your response style and link the child; do not paste summary verbatim, but quote provider errors, failing tests and security warnings in it exactly. A project coordinator does not relay: the result stays in the worker's thread. hasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal; it does not reopen the task, and task_cancel stops those turns too. latestTerminal* provides later non-monitor turn results. Reading a terminal result acknowledges its automatic parent delivery.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Needs an agent running inside a SpecWithCode thread. Stop a SpecWithCode-owned delegated task and dispose its automatic parent delivery. Its child thread stops like a user Stop: the running turn is interrupted, queued turns are held, pull request watches end, and the tasks it delegated stop too. This includes later child-thread runs, even after the task is terminal. A terminal task returns its existing status, and published task results remain available.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent work in the app scheduler that runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text. Timers: {type:'interval', everyMs:3600000} is hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} is weekday mornings; {type:'monthly', dayOfMonth:1, timeOfDay:'09:00'} is monthly; report the returned nextRunAt. Reusable work the user starts when needed (monthly bookkeeping, a report, a research brief): {type:'manual'} with ownThread:true and a brief; it never runs on its own, and each Run now continues the routine's own thread. Never turn on a cadence the user did not ask for. Webhooks: {type:'webhook'} runs once per request to a generated URL. The run sees the request ONLY through prompt placeholders: {{body.path}} (e.g. {{body.action}}, {{body.release.tag_name}}), {{headers.name}}, {{query.name}}, {{body}}, or {{request}} (method, headers with credentials redacted, and body). For a sender that signs requests, first call request_secret so the user enters the secret privately (never ask for it in chat or invent one), then set signature with the returned secretRef, e.g. GitHub: {type:'webhook', signature:{header:'x-hub-signature-256', encoding:'hex', prefix:'sha256=', secretRef}}. The result's webhookUrl is the public URL to give the user; if it is absent, this environment has no SpecWithCode Connect managed tunnel, so tell the user to enable SpecWithCode Connect remote access rather than sharing a path. Omit projectId for this thread's project. In this thread's project, runs post into THIS thread by default (bindToCurrentThread=true), which suits an orchestrator that sees every trigger, delegates work, and can dedupe against what is in flight; with false each run goes to the project's coordinator, which answers it or starts the threads it needs. Elsewhere each run goes to that project's coordinator. Runtime settings inherit from this thread. Runs use the model this thread's next turn would use, and threads the coordinator starts use the project's recommended model on whichever provider has room; pass modelSelection only to pin one. For a watch whose condition a shell command can test (disk space, a URL's status, a file appearing), set check so the agent wakes only when the command exits 0 and quiet runs cost nothing (full-access threads only, since the command runs without approval).",
  parameters: OrchestratorMcpScheduleTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  parameters: OrchestratorMcpListScheduledTasksInput,
  description:
    "List recurring scheduled tasks in a project (omit projectId for the calling thread's project, or every project when there is no calling thread), including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and sending each run to the project's coordinator.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. The value is kept by the app and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one (e.g. schedule_task's signature.secretRef). It works once. Never ask for secrets in chat, and never invent one.",
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

const AskUserTool = Tool.make("ask_user", {
  description:
    "Ask the user a question you cannot answer from the request, the code or sensible defaults. It shows a decision card in this thread: your question as the title, then lettered options (A, B, C) with a bold label and a one-line description, your recommended choice badged, and a 'reply in chat' link for a free answer. The thread shows as Waiting on you and the user is notified. This returns at once: the user's answer arrives as your next user message (the question, then the chosen label or their text), so end your turn or keep working on something else. Never repeat the question in chat. Write repository paths as `path/to/file` and full URLs so they open from the card.",
  parameters: OrchestratorMcpAskUserInput,
  success: OrchestratorMcpAskUserResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the user a question")
  .annotate(Tool.Destructive, false);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Needs an agent running inside a SpecWithCode thread. Create one or more ORDINARY TOP-LEVEL SpecWithCode conversations. This is not delegation and does not create child agents/subagents. For delegated work, choose models from orchestrator_capabilities. Prefer native subagents only when they support the chosen model; otherwise call delegate_task, including for same-provider work. Use create_threads for a batch of separate top-level threads sharing this checkout. Prefer studio_thread_launch for a single thread. Both require the user to request separate/new/top-level threads or conversations. Each entry may override provider, model, options, effort (target.effort, e.g. 'xhigh'), runtime mode, and interaction mode; omitted settings inherit. Project, branch, and worktree always inherit and cannot be overridden here. For independent implementation or a PR stack in its own worktree, use studio_thread_launch with workspaceStrategy instead of asking the agent to create a worktree in its prompt.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create SpecWithCode threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("studio_thread_list", {
  description:
    "List project threads, newest first. A project coordinator with machine omitted discovers every explicit logical-project binding, including archived history. Read partial and members before treating results as complete; unavailable or unauthorized machines are explicit. Use each returned environment-scoped threadRef or threadLink for follow-up tools. Pass machine to list only that machine. Omit projectId for the calling thread's project. Filter by status, title, settled state or includeArchived, and paginate with nextCursor. Pages use current snapshots and can shift as threads change.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "List SpecWithCode threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("studio_thread_read", {
  description:
    "Read durable state and a paginated timeline from any SpecWithCode thread in this environment. The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result from this parent thread's direct app-owned child acknowledges that child's automatic completion delivery. Continue with afterPosition=nextPosition. Recover long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  // Another machine's work reaches only the projects its grant here covers.
  dependencies: [...dependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "Read a SpecWithCode thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadUpdateTool = Tool.make("studio_thread_update", {
  description:
    "Update metadata for a thread. Omit threadId to update this thread. Use action='rename' with title, action='regenerate_title' with no extra field, action='link_pull_request' with pullRequest, or action='unlink_pull_request'. Workspace and branch changes are intentionally not supported. clientRequestId makes retries idempotent.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...threadMetadataDependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "Update SpecWithCode thread metadata")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("studio_thread_send", {
  description:
    "Send a message to any SpecWithCode thread in this environment. The target cannot have broader permission modes than the caller. Do not use a delegated task's childThreadId to start another review round here; use delegate_task with the full review context and a new clientRequestId for that round. Thread messages do not create a new delegated task or reopen a completed task. mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn. clientRequestId makes retries idempotent. To route a message the user wrote, pass forwardMessageId instead of message: SpecWithCode delivers the user's words unchanged, shown as theirs and routed by you, never retyped. A thread's queue is held after Stop, a restart or a provider failure. A message sent here (other than /compact or /logout) releases it: the held messages run after this one, in their order (releasedHeldMessages). queueHeld=true means this message is waiting in a held queue and was NOT delivered; check notice and heldQueuedMessages before reporting a handoff as delivered. When you tell the user where the message went, name the thread with the result's threadLink copied verbatim, never its bare title.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  // Another machine's work reaches only the projects its grant here covers.
  dependencies: [...dependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "Send to a SpecWithCode thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("studio_thread_wait", {
  description:
    "Wait for a SpecWithCode thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use studio_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result. Use it for short checks, not to sit on another thread's long work: send what you need with studio_thread_send, end your turn, and its reply wakes you.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  // Another machine's work reaches only the projects its grant here covers.
  dependencies: [...dependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "Wait for a SpecWithCode thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("studio_thread_interrupt", {
  description:
    "Request interruption of a running turn in any SpecWithCode thread in this environment. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  // Another machine's work reaches only the projects its grant here covers.
  dependencies: [...dependencies, ProjectService.ProjectService],
})
  .annotate(Tool.Title, "Interrupt a SpecWithCode thread")
  .annotate(Tool.Destructive, true);

const ThreadsStopAllTool = Tool.make("studio_threads_stop_all", {
  description:
    "Stop every running thread in a project (omit projectId for this thread's project), except the calling thread. Each stops like the user's Stop button: its running turn is interrupted, its queue is held, and the tasks it delegated stop too. Stopped threads never resume on their own; use studio_threads_continue_all or studio_thread_send to restart them. Threads running in broader modes than the caller are skipped. Use only when the user asks to stop all work. Returns one result per thread; link threads with their threadLink.",
  parameters: OrchestratorMcpThreadsStopAllInput,
  success: OrchestratorMcpThreadsBulkResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop all running SpecWithCode threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const ThreadsContinueAllTool = Tool.make("studio_threads_continue_all", {
  description:
    "Continue every thread in a project (omit projectId for this thread's project), except the calling thread, whose latest run was interrupted, including runs the user stopped. Each gets the Continue button's message, 'Continue where you left off.', on its current model. Retrying continues each interrupted run once. Threads running in broader modes than the caller are skipped. Use only when the user asks to resume stopped work. Returns one result per thread; link threads with their threadLink.",
  parameters: OrchestratorMcpThreadsContinueAllInput,
  success: OrchestratorMcpThreadsBulkResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Continue all interrupted SpecWithCode threads")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ThreadMigrateTool = Tool.make("studio_thread_migrate", {
  description:
    "Move threads this coordinator owns to another machine through handoff. Each thread keeps its owner, the coordinator that started it; only where it runs moves. Pass threadIds, or omit them to move every running handoff-mode thread of this project. Returns one result per thread: moved, stayed with the exact reason, or skipped. A machine that is offline, not granted, or not signed in is refused, never substituted.",
  parameters: OrchestratorMcpThreadMigrateInput,
  success: OrchestratorMcpThreadMigrateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, ProjectService.ProjectService, HandoffMode.HandoffMode],
})
  .annotate(Tool.Title, "Move SpecWithCode threads to another machine")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const HandoffReadyListTool = Tool.make("studio_handoff_ready_list", {
  description:
    "List this project's threads that another machine replicated here through handoff mode and that this machine can continue, such as M4's threads when M4 is closed. Each row names the source machine, the checkpoint time, whether the source is unreachable and whether it can be continued now (false while the source still renews its lease).",
  parameters: OrchestratorMcpHandoffReadyListInput,
  success: OrchestratorMcpHandoffReadyListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, HandoffMode.HandoffMode],
})
  .annotate(Tool.Title, "List SpecWithCode threads ready to continue here")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const ThreadContinueHereTool = Tool.make("studio_thread_continue_here", {
  description:
    "Continue one handoff-ready thread from studio_handoff_ready_list on this machine, in one call. Returns the thread that continues the work here. Refused while the source machine still renews the thread's lease, so two machines never run it; a thread already continued here returns that thread.",
  parameters: OrchestratorMcpThreadContinueHereInput,
  success: OrchestratorMcpThreadContinueHereResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [...dependencies, ProjectService.ProjectService, HandoffMode.HandoffMode],
})
  .annotate(Tool.Title, "Continue a SpecWithCode thread on this machine")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  RequestSecretTool,
  AskUserTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
  ThreadsStopAllTool,
  ThreadsContinueAllTool,
  ThreadMigrateTool,
  HandoffReadyListTool,
  ThreadContinueHereTool,
);

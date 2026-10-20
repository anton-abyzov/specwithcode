export type StudioMcpToolLogo = "studio-code";

export interface StudioMcpToolPresentation {
  readonly displayName: string;
  readonly logo: StudioMcpToolLogo;
}

export type StudioMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "thread-stop-all"
  | "thread-continue-all"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "queue-resume"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render";

export interface StudioMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "studio-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: StudioMcpToolSummaryAction;
}

function tool(
  labels: StudioMcpToolDefinition["labels"],
  summaryAction: StudioMcpToolSummaryAction,
  icon: StudioMcpToolDefinition["icon"] = "studio-code",
  displayName = `${labels[0]} ${labels[3]}`,
): StudioMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const STUDIO_MCP_SERVER_ALIASES = new Set(["studio-code", "studio_code", "studiocode", "studio"]);

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const STUDIO_MCP_TOOLS: Readonly<Record<string, StudioMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  ask_user: tool(["Ask", "Asking", "Asked", "the user"], "question-respond"),
  create_threads: tool(["Create", "Creating", "Created", "SpecWithCode threads"], "thread-create"),
  studio_thread_start: tool(
    ["Start", "Starting", "Started", "a SpecWithCode thread"],
    "thread-create",
  ),
  studio_thread_list: tool(["List", "Listing", "Listed", "SpecWithCode threads"], "thread-list"),
  studio_thread_read: tool(["Read", "Reading", "Read", "a SpecWithCode thread"], "thread-read"),
  studio_thread_send: tool(["Send", "Sending", "Sent", "to a SpecWithCode thread"], "thread-send"),
  studio_thread_wait: tool(
    ["Wait", "Waiting", "Waited", "for a SpecWithCode thread"],
    "thread-wait",
  ),
  studio_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a SpecWithCode thread"],
    "thread-interrupt",
  ),
  studio_threads_stop_all: tool(
    ["Stop", "Stopping", "Stopped", "all running SpecWithCode threads"],
    "thread-stop-all",
  ),
  studio_threads_continue_all: tool(
    ["Continue", "Continuing", "Continued", "all interrupted SpecWithCode threads"],
    "thread-continue-all",
  ),
  studio_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  studio_worktree_status: tool(
    ["Get", "Getting", "Got", "thread worktree status"],
    "worktree-status",
  ),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  chrome_profiles: tool(
    ["List", "Listing", "Listed", "connected Chrome profiles"],
    "browser",
    "browser",
  ),
  chrome_tabs: tool(["List", "Listing", "Listed", "tabs in Chrome"], "browser", "browser"),
  chrome_open: tool(["Open", "Opening", "Opened", "a tab in Chrome"], "browser", "browser"),
  chrome_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "a Chrome tab"],
    "browser",
    "browser",
  ),
  chrome_snapshot: tool(["Read", "Reading", "Read", "a Chrome tab"], "browser", "browser"),
  chrome_click: tool(["Click", "Clicking", "Clicked", "in Chrome"], "browser", "browser"),
  chrome_type: tool(["Type", "Typing", "Typed", "in Chrome"], "browser", "browser"),
  chrome_press: tool(["Press", "Pressing", "Pressed", "a key in Chrome"], "browser", "browser"),
  chrome_screenshot: tool(
    ["Capture", "Capturing", "Captured", "a Chrome tab"],
    "browser",
    "browser",
  ),
  chrome_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in Chrome"],
    "browser",
    "browser",
  ),
  chrome_close: tool(["Close", "Closing", "Closed", "a Chrome tab"], "browser", "browser"),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  studio_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  studio_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  studio_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  studio_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  studio_queue_reorder: tool(
    ["Reorder", "Reordering", "Reordered", "a queued run"],
    "queue-reorder",
  ),
  studio_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  studio_queue_resume: tool(["Resume", "Resuming", "Resumed", "a held queue"], "queue-resume"),
  studio_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  studio_pending_request_read: tool(
    ["Read", "Reading", "Read", "pending questions"],
    "question-read",
  ),
  studio_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  studio_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  studio_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  studio_thread_fork: tool(
    ["Fork", "Forking", "Requested a fork of", "this thread"],
    "thread-fork",
  ),
  studio_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  studio_thread_search: tool(
    ["Search", "Searching", "Searched", "thread content"],
    "thread-search",
  ),
  studio_thread_transfers: tool(
    ["Read", "Reading", "Read", "thread transfers"],
    "thread-transfers",
  ),
  studio_thread_organize: tool(
    ["Organize", "Organizing", "Organized", "a thread"],
    "thread-organize",
  ),
  studio_thread_update: tool(
    ["Update", "Updating", "Updated", "SpecWithCode thread metadata"],
    "thread-update",
  ),
  studio_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  studio_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  studio_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  studio_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  studio_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  studio_thread_launch: tool(
    ["Launch", "Launching", "Launched", "a project thread"],
    "thread-create",
  ),
  studio_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  studio_machine_list: tool(["List", "Listing", "Listed", "worker machines"], "environment-read"),
  studio_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  studio_project_create: tool(
    ["Register", "Registering", "Registered", "a project"],
    "project-create",
  ),
  studio_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  studio_project_request: tool(
    ["Ask to change", "Asking to change", "Asked to change", "a project"],
    "project-update",
  ),
  studio_project_delete: tool(
    ["Ask to delete", "Asking to delete", "Asked to delete", "a project"],
    "project-delete",
  ),
  studio_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  studio_route_targets: tool(["List", "Listing", "Listed", "projects to route to"], "project-list"),
  studio_project_route: tool(
    ["Route", "Routing", "Routed", "a request to a project"],
    "thread-send",
  ),
  studio_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  studio_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  studio_thread_send_attachments: tool(
    ["Send", "Sending", "Sent", "attachments"],
    "attachment-send",
  ),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
};

/**
 * The Studio orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const STUDIO_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(STUDIO_MCP_TOOLS));

function normalizeStudioMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected Studio server prefixes its tools:
 * `mcp__studio-code__x` (Claude/Cursor), `studio-code.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveStudioMcpToolName(value: string): string | null {
  const label = normalizeStudioMcpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      STUDIO_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>studio-code|studio_code|studiocode|studio)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
      label,
    );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  // Agents prefix with either the injected server key (`studio-code`) or the
  // name the server advertises on initialize (`SpecWeave Studio`).
  const prefixed =
    /^(?:mcp[-_]{1,2})?(?:studio[-_ ]?code|specweave[-_ ]?studio)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
      label,
    );
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(STUDIO_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 registers one server per thread, `studio-code-<thread>`, and joins
  // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
  // known tool name that ends the label.
  if (!/^studio-code-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(STUDIO_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

/** The bare Studio tool name (`html_render`) for any provider's spelling of it. */
export function resolveStudioMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveStudioMcpToolName(toolName);
  return name !== null && Object.hasOwn(STUDIO_MCP_TOOLS, name) ? name : null;
}

export function resolveStudioMcpToolDefinition(
  toolName: string | null | undefined,
): StudioMcpToolDefinition | null {
  const name = toolName == null ? null : resolveStudioMcpToolName(toolName);
  return name !== null && Object.hasOwn(STUDIO_MCP_TOOLS, name) ? STUDIO_MCP_TOOLS[name]! : null;
}

export function resolveStudioMcpToolPresentation(
  toolName: string | null | undefined,
): StudioMcpToolPresentation | null {
  const definition = resolveStudioMcpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "studio-code" };
}

export function resolveStudioMcpToolSummaryAction(
  toolName: string | null | undefined,
): StudioMcpToolSummaryAction | null {
  return resolveStudioMcpToolDefinition(toolName)?.summaryAction ?? null;
}

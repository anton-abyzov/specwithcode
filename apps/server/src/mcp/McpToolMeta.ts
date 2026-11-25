/**
 * Tool-search hints for studio-code tools (1483).
 *
 * Claude Code loads MCP tools deferred and finds them through tool search.
 * A tool whose `_meta["anthropic/alwaysLoad"]` is true is loaded up front, so
 * the few an agent needs on most turns cost no search round trip. Every other
 * tool carries `_meta["anthropic/searchHint"]`, a short phrase from its
 * toolkit that tool search matches next to the name and description. Other
 * clients ignore both keys.
 */

import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { ChromeToolkit } from "./toolkits/chrome/tools.ts";
import { ComputerToolkit } from "./toolkits/computer/tools.ts";
import { CoordinatorMessageToolkit } from "./toolkits/coordinatorMessage/tools.ts";
import { DecisionToolkit } from "./toolkits/decision/tools.ts";
import { DesignScreenshotToolkit, DesignToolkit } from "./toolkits/design/tools.ts";
import { DesignSystemsToolkit } from "./toolkits/designSystems/tools.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { FileTransferToolkit } from "./toolkits/fileTransfer/tools.ts";
import { GoogleToolkit } from "./toolkits/google/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { MachinesToolkit } from "./toolkits/machines/tools.ts";
import { DocumentToolkit } from "./toolkits/office/document.ts";
import { OfficeToolkit } from "./toolkits/office/tools.ts";
import { WhiteboardToolkit } from "./toolkits/office/whiteboard.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ProjectConnectionsToolkit } from "./toolkits/projectConnections/tools.ts";
import { ProjectKnowledgeToolkit } from "./toolkits/projectKnowledge/tools.ts";
import { ProjectMemoryToolkit } from "./toolkits/projectMemory/tools.ts";
import { ProjectPlanToolkit } from "./toolkits/projectPlan/tools.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import { ReportToolkit } from "./toolkits/report/tools.ts";
import { ResetAnnouncementToolkit } from "./toolkits/resetAnnouncements/tools.ts";
import { SpecweaveToolkit } from "./toolkits/specweave/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

export const ALWAYS_LOAD_KEY = "anthropic/alwaysLoad";
export const SEARCH_HINT_KEY = "anthropic/searchHint";

/** Loaded up front in Claude threads: the tools an agent needs on most turns. */
export const ALWAYS_LOAD_TOOLS: ReadonlySet<string> = new Set([
  "ask_user",
  "request_secret",
  "studio_thread_send",
  "delegate_task",
  "studio_report_save",
  "advisor",
]);

/** Only the tool names are read. */
type AnyToolkit = { readonly tools: Readonly<Record<string, unknown>> };

/** Each toolkit's search hint: the toolkit's name, then what its tools work on. */
const TOOLKIT_HINTS: ReadonlyArray<{
  readonly hint: string;
  readonly toolkits: ReadonlyArray<AnyToolkit>;
}> = [
  {
    hint: "orchestrator: threads, subagents, delegation, routines",
    toolkits: [OrchestratorToolkit],
  },
  { hint: "thread: queue, pending requests, thread settings", toolkits: [ThreadToolkit] },
  { hint: "attachment: files attached to threads, uploads", toolkits: [AttachmentToolkit] },
  { hint: "project: projects, launches, routing, links", toolkits: [ProjectToolkit] },
  { hint: "machines: fleet machines and their access", toolkits: [MachinesToolkit] },
  { hint: "file transfer: send files between machines", toolkits: [FileTransferToolkit] },
  { hint: "decision: record a decision", toolkits: [DecisionToolkit] },
  { hint: "project memory: lasting project notes", toolkits: [ProjectMemoryToolkit] },
  { hint: "project knowledge: search specs, reports, memory", toolkits: [ProjectKnowledgeToolkit] },
  { hint: "report: save reports and documents", toolkits: [ReportToolkit] },
  { hint: "reset announcements: usage reset notices", toolkits: [ResetAnnouncementToolkit] },
  { hint: "office: spreadsheets, Excel sheets", toolkits: [OfficeToolkit] },
  { hint: "office: whiteboard, Excalidraw drawing", toolkits: [WhiteboardToolkit] },
  { hint: "office: Word documents, docx", toolkits: [DocumentToolkit] },
  {
    hint: "coordinator message: messages between coordinators",
    toolkits: [CoordinatorMessageToolkit],
  },
  { hint: "project plan: claim and report plan items", toolkits: [ProjectPlanToolkit] },
  {
    hint: "project connections: the project's MCP servers and apps",
    toolkits: [ProjectConnectionsToolkit],
  },
  { hint: "google: Gmail, Calendar, Drive", toolkits: [GoogleToolkit] },
  { hint: "environment: machine environment and preferences", toolkits: [EnvironmentToolkit] },
  { hint: "preview controls: preview servers", toolkits: [PreviewControlsToolkit] },
  { hint: "preview: headless browser, page checks, screenshots", toolkits: [PreviewToolkit] },
  { hint: "worktree: git worktrees, handoff, merge back", toolkits: [WorktreeToolkit] },
  { hint: "pull requests: GitHub PRs, watch and link", toolkits: [PullRequestsToolkit] },
  { hint: "device: iOS simulator and phones", toolkits: [DeviceToolkit] },
  { hint: "html: render HTML pages and visuals", toolkits: [HtmlToolkit] },
  {
    hint: "design: designs and design systems",
    toolkits: [DesignToolkit, DesignScreenshotToolkit, DesignSystemsToolkit],
  },
  { hint: "chrome: the user's signed-in Chrome", toolkits: [ChromeToolkit] },
  { hint: "computer: desktop apps, screen, mouse, keyboard", toolkits: [ComputerToolkit] },
  { hint: "specweave: increments, tasks, pickup, verify", toolkits: [SpecweaveToolkit] },
];

const HINT_BY_TOOL: ReadonlyMap<string, string> = new Map(
  TOOLKIT_HINTS.flatMap(({ hint, toolkits }) =>
    toolkits.flatMap((toolkit) => Object.keys(toolkit.tools).map((name) => [name, hint] as const)),
  ),
);

/** For a tool no toolkit above lists; the test keeps every registered tool off it. */
export const FALLBACK_SEARCH_HINT = "SpecWithCode studio-code tools";

/** The `_meta` keys a tool is advertised with. */
export const toolMeta = (name: string): Record<string, string | boolean> =>
  ALWAYS_LOAD_TOOLS.has(name)
    ? { [ALWAYS_LOAD_KEY]: true }
    : { [SEARCH_HINT_KEY]: HINT_BY_TOOL.get(name) ?? FALLBACK_SEARCH_HINT };

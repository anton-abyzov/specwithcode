import {
  BrowserExtensionToolError,
  ChromeClickInput,
  ChromeCloseInput,
  ChromeCloseResult,
  ChromeEvaluateInput,
  ChromeEvaluateResult,
  ChromeNavigateInput,
  ChromeOpenInput,
  ChromePageResult,
  ChromePressInput,
  ChromeProfilesInput,
  ChromeProfilesResult,
  ChromeScreenshotInput,
  ChromeScreenshotResult,
  ChromeSnapshotInput,
  ChromeSnapshotResult,
  ChromeTabsInput,
  ChromeTabsResult,
  ChromeTypeInput,
  OrchestratorMcpFailure,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BrowserExtension from "../../../browserExtension/BrowserExtension.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BrowserExtension.BrowserExtension,
];

const ChromeToolFailure = Schema.Union([BrowserExtensionToolError, OrchestratorMcpFailure]);

/**
 * The user's own Chrome, through the SpecWithCode Browser extension. Unlike
 * preview_* (a headless browser with no logins), these act in a real Chrome
 * profile with the user's sessions, so they are for tasks the user asked for.
 */
const USER_CHROME =
  "Acts in the user's real, signed-in Chrome profile through the SpecWithCode Browser extension; use preview_* for testing your own app.";

const make = <
  const Name extends string,
  P extends Schema.Struct<Schema.Struct.Fields>,
  S extends Schema.Top,
>(
  name: Name,
  title: string,
  description: string,
  parameters: P,
  success: S,
  flags: { readonly readonly: boolean; readonly destructive: boolean },
) =>
  Tool.make(name, {
    description: `${description} ${USER_CHROME}`,
    parameters,
    success,
    failure: ChromeToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, flags.readonly)
    .annotate(Tool.Destructive, flags.destructive)
    .annotate(Tool.Idempotent, flags.readonly)
    .annotate(Tool.OpenWorld, true);

const READ = { readonly: true, destructive: false } as const;
const ACT = { readonly: false, destructive: false } as const;

const ChromeProfilesTool = make(
  "chrome_profiles",
  "List Chrome profiles",
  "List the Chrome profiles paired with SpecWithCode on this machine. Call first when you do not know the profile names.",
  ChromeProfilesInput,
  ChromeProfilesResult,
  READ,
);
const ChromeTabsTool = make(
  "chrome_tabs",
  "List Chrome tabs",
  "List open tabs in a paired Chrome profile, with ids for the other chrome_* tools.",
  ChromeTabsInput,
  ChromeTabsResult,
  READ,
);
const ChromeOpenTool = make(
  "chrome_open",
  "Open Chrome tab",
  "Open a URL in a new tab in the user's Chrome. The tab joins the blue SpecWithCode tab group and becomes this thread's current tab.",
  ChromeOpenInput,
  ChromePageResult,
  ACT,
);
const ChromeNavigateTool = make(
  "chrome_navigate",
  "Navigate Chrome tab",
  "Load a URL in a tab, or go back, forward or reload.",
  ChromeNavigateInput,
  ChromePageResult,
  ACT,
);
const ChromeSnapshotTool = make(
  "chrome_snapshot",
  "Read Chrome page",
  "Read a tab's visible text and its interactive elements; each element has a ref for chrome_click and chrome_type.",
  ChromeSnapshotInput,
  ChromeSnapshotResult,
  READ,
);
const ChromeClickTool = make(
  "chrome_click",
  "Click in Chrome",
  "Click an element by ref from chrome_snapshot, or by CSS selector.",
  ChromeClickInput,
  ChromePageResult,
  ACT,
);
const ChromeTypeTool = make(
  "chrome_type",
  "Type in Chrome",
  "Type text into an input, textarea or editable element by ref or selector. Never type passwords or payment details unless the user gave them to you for this.",
  ChromeTypeInput,
  ChromePageResult,
  ACT,
);
const ChromePressTool = make(
  "chrome_press",
  "Press key in Chrome",
  "Press one key in a tab, such as Enter, Escape or ArrowDown.",
  ChromePressInput,
  ChromePageResult,
  ACT,
);
export const ChromeScreenshotTool = make(
  "chrome_screenshot",
  "Screenshot Chrome tab",
  "Capture a tab as a PNG image.",
  ChromeScreenshotInput,
  ChromeScreenshotResult,
  READ,
);
const ChromeEvaluateTool = make(
  "chrome_evaluate",
  "Run JavaScript in Chrome",
  "Evaluate a JavaScript expression in a tab and return its JSON value. Prefer chrome_snapshot for reading pages.",
  ChromeEvaluateInput,
  ChromeEvaluateResult,
  ACT,
);
const ChromeCloseTool = make(
  "chrome_close",
  "Close Chrome tab",
  "Close a tab an agent opened or used. The user's other tabs are never closed.",
  ChromeCloseInput,
  ChromeCloseResult,
  { readonly: false, destructive: true },
);

export const ChromeStandardToolkit = Toolkit.make(
  ChromeProfilesTool,
  ChromeTabsTool,
  ChromeOpenTool,
  ChromeNavigateTool,
  ChromeSnapshotTool,
  ChromeClickTool,
  ChromeTypeTool,
  ChromePressTool,
  ChromeEvaluateTool,
  ChromeCloseTool,
);

export const ChromeScreenshotToolkit = Toolkit.make(ChromeScreenshotTool);

export const ChromeToolkit = Toolkit.make(
  ChromeProfilesTool,
  ChromeTabsTool,
  ChromeOpenTool,
  ChromeNavigateTool,
  ChromeSnapshotTool,
  ChromeClickTool,
  ChromeTypeTool,
  ChromePressTool,
  ChromeScreenshotTool,
  ChromeEvaluateTool,
  ChromeCloseTool,
);

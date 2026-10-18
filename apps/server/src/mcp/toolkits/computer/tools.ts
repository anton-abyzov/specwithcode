import {
  ComputerToolActionResult,
  ComputerToolClickInput,
  ComputerToolDragInput,
  ComputerToolKeyInput,
  ComputerToolMoveInput,
  ComputerToolOpenInput,
  ComputerToolScreenshotInput,
  ComputerToolScreenshotResult,
  ComputerToolScrollInput,
  ComputerToolTypeInput,
  ComputerUseToolError,
  OrchestratorMcpFailure,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ComputerUseBroker from "../../../computerUse/ComputerUseBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ComputerUseBroker.ComputerUseBroker,
];

/** What a computer tool fails with, including the access gate's refusal. */
const ComputerToolFailure = Schema.Union([ComputerUseToolError, OrchestratorMcpFailure]);

const COORDINATES = "Coordinates are pixels of the latest computer_screenshot image.";

const action = <const Name extends string, P extends Schema.Struct.Fields>(
  name: Name,
  title: string,
  description: string,
  parameters: Schema.Struct<P>,
  destructive: boolean,
) =>
  Tool.make(name, {
    description,
    parameters,
    success: ComputerToolActionResult,
    failure: ComputerToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, title)
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, destructive)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true);

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description:
    "Computer use: see the user's own computer desktop (the Mac running the SpecWithCode app), as an image. Use the computer_* tools when the user asks you to change something on their computer or work in a native app: System Settings (mouse or trackpad speed, display, sound, keyboard, notifications), Finder, Notes, Calendar, or any other installed app. Prefer them over shell edits such as `defaults write`, which often need a logout to apply. Start with this screenshot, act with computer_open, computer_click, computer_type and computer_key, and take another screenshot to confirm the result. These are this session's computer-use tools: where a computer-use skill names mcp__computer-use__* tools or a request_access step, use these instead; the machine's Agent computer access setting already grants access. Ask the user before deleting data, sending messages, purchases or changing security settings. For websites use the chrome_* or preview_* tools instead.",
  parameters: ComputerToolScreenshotInput,
  success: ComputerToolScreenshotResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot computer")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerClickTool = action(
  "computer_click",
  "Click on computer",
  `Computer use: click on the user's desktop. ${COORDINATES} Pass count 2 for a double click and button "right" for a context menu.`,
  ComputerToolClickInput,
  true,
);

const ComputerMoveTool = action(
  "computer_move",
  "Move pointer",
  `Computer use: move the pointer without clicking, for hover menus and tooltips. ${COORDINATES}`,
  ComputerToolMoveInput,
  false,
);

const ComputerDragTool = action(
  "computer_drag",
  "Drag on computer",
  `Computer use: press at one point, drag to another and release, for sliders, windows and files. ${COORDINATES}`,
  ComputerToolDragInput,
  true,
);

const ComputerScrollTool = action(
  "computer_scroll",
  "Scroll on computer",
  `Computer use: scroll the view under a point. ${COORDINATES}`,
  ComputerToolScrollInput,
  false,
);

const ComputerTypeTool = action(
  "computer_type",
  "Type on computer",
  "Computer use: enter text into the focused field on the user's desktop. Click the field first. Any language and keyboard layout works.",
  ComputerToolTypeInput,
  true,
);

const ComputerKeyTool = action(
  "computer_key",
  "Press keys on computer",
  "Computer use: press a key or shortcut on the user's desktop, such as return, escape, tab, cmd+space, cmd+comma or cmd+q.",
  ComputerToolKeyInput,
  true,
);

const ComputerOpenTool = action(
  "computer_open",
  "Open app on computer",
  "Computer use: open or bring forward an application by name (System Settings, Finder, Notes), or a System Settings pane by its x-apple.systempreferences: URL, for example x-apple.systempreferences:com.apple.Mouse-Settings.extension or com.apple.Trackpad-Settings.extension. Take a screenshot afterwards.",
  ComputerToolOpenInput,
  false,
);

export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerClickTool,
  ComputerMoveTool,
  ComputerDragTool,
  ComputerScrollTool,
  ComputerTypeTool,
  ComputerKeyTool,
  ComputerOpenTool,
);

export const ComputerToolkit = Toolkit.make(
  ComputerScreenshotTool,
  ComputerClickTool,
  ComputerMoveTool,
  ComputerDragTool,
  ComputerScrollTool,
  ComputerTypeTool,
  ComputerKeyTool,
  ComputerOpenTool,
);

import { BrowserExtensionToolError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as BrowserExtension from "../../../browserExtension/BrowserExtension.ts";
import { ChromeTools } from "../../../browserExtension/chromeTools.ts";
import { BrowserRelayError } from "../../../browserExtension/relayHub.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ChromeScreenshotToolkit, ChromeStandardToolkit, ChromeToolkit } from "./tools.ts";

const toolsByHub = new WeakMap<object, ChromeTools>();

/** Browser access is the same per-thread switch the preview tools use. */
const requireChromeAccess = McpInvocationContext.requireThreadMcpCapability("preview").pipe(
  Effect.mapError(
    () =>
      new BrowserExtensionToolError({
        code: "invalid_request",
        reason: "Browser access is turned off for this thread. Ask the user to turn it on.",
      }),
  ),
);

export const toToolError = (error: unknown): BrowserExtensionToolError =>
  error instanceof BrowserRelayError
    ? new BrowserExtensionToolError({ code: error.code, reason: error.message })
    : new BrowserExtensionToolError({
        code: "page_error",
        reason: error instanceof Error ? error.message.slice(0, 500) : "Chrome reported an error.",
      });

/** Runs one chrome_* action as the calling thread. */
const run = <A>(action: (tools: ChromeTools, threadId: string) => A | Promise<A>) =>
  Effect.gen(function* () {
    const scope = yield* requireChromeAccess;
    const extension = yield* BrowserExtension.BrowserExtension;
    let tools = toolsByHub.get(extension.hub);
    if (!tools) {
      tools = new ChromeTools(extension.hub);
      toolsByHub.set(extension.hub, tools);
    }
    const bound = tools;
    return yield* Effect.tryPromise({
      try: async () => action(bound, scope.thread.threadId),
      catch: toToolError,
    });
  });

const handlers = {
  chrome_profiles: McpToolAccess.readsAsCaller(() =>
    run((tools, threadId) => tools.profiles(threadId)),
  ),
  chrome_tabs: McpToolAccess.readsAsCaller((input) =>
    run((tools, threadId) => tools.tabs(threadId, input.profile)),
  ),
  chrome_open: McpToolAccess.actsAsCaller((input) =>
    run((tools, threadId) => tools.open(threadId, input)),
  ),
  chrome_navigate: McpToolAccess.actsAsCaller((input) =>
    run((tools, threadId) => tools.navigate(threadId, input)),
  ),
  chrome_snapshot: McpToolAccess.readsAsCaller((input) =>
    run((tools, threadId) => tools.snapshot(threadId, input)),
  ),
  chrome_click: McpToolAccess.actsAsCaller((input) =>
    run((tools, threadId) => tools.click(threadId, input)),
  ),
  chrome_type: McpToolAccess.actsAsCaller((input) =>
    run((tools, threadId) => tools.type(threadId, input)),
  ),
  chrome_press: McpToolAccess.actsAsCaller((input) =>
    run((tools, threadId) => tools.press(threadId, input)),
  ),
  chrome_screenshot: McpToolAccess.readsAsCaller((input) =>
    run((tools, threadId) => tools.screenshot(threadId, input)),
  ),
  chrome_evaluate: McpToolAccess.actsAsCaller((input) =>
    run((tools, threadId) => tools.evaluateExpression(threadId, input)),
  ),
  chrome_close: McpToolAccess.actsAsCaller((input) =>
    run((tools, threadId) => tools.close(threadId, input)),
  ),
} satisfies McpToolAccess.Handlers<typeof ChromeToolkit.tools>;

const { chrome_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(ChromeStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(ChromeScreenshotToolkit, {
  chrome_screenshot,
});

import {
  type ComputerToolActionResult,
  type ComputerUseAction,
  type ComputerUseActionResult,
  ComputerUseToolError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as ComputerUseBroker from "../../../computerUse/ComputerUseBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerScreenshotToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

const requireComputerAccess = McpInvocationContext.requireThreadMcpCapability("computer").pipe(
  Effect.mapError(
    () =>
      new ComputerUseToolError({
        reason:
          "Computer use is turned off for this project. Ask the user to turn on Agent computer access in SpecWithCode Settings, then send another message.",
      }),
  ),
);

const run = (action: ComputerUseAction) =>
  Effect.gen(function* () {
    const scope = yield* requireComputerAccess;
    const broker = yield* ComputerUseBroker.ComputerUseBroker;
    return yield* broker.invoke(action, { threadId: scope.thread.threadId });
  });

/** Everything but the image: action tools report where things stand afterwards. */
const summary = (result: ComputerUseActionResult): ComputerToolActionResult => ({
  platform: result.platform,
  permissions: result.permissions,
  ...(result.display === undefined ? {} : { display: result.display }),
  ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
  ...(result.frontmostApplication === undefined
    ? {}
    : { frontmostApplication: result.frontmostApplication }),
});

const act = (action: ComputerUseAction) => run(action).pipe(Effect.map(summary));

const handlers = {
  computer_screenshot: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const result = yield* run({ kind: "screenshot" });
      if (result.screenshot === undefined) {
        return yield* new ComputerUseToolError({
          reason: "The desktop app returned no screenshot.",
        });
      }
      return {
        platform: result.platform,
        ...(result.display === undefined ? {} : { display: result.display }),
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
        ...(result.frontmostApplication === undefined
          ? {}
          : { frontmostApplication: result.frontmostApplication }),
        screenshot: result.screenshot,
      };
    }),
  ),
  computer_click: McpToolAccess.actsAsCaller((input) => act({ kind: "click", ...input })),
  computer_move: McpToolAccess.actsAsCaller((input) => act({ kind: "move", ...input })),
  computer_drag: McpToolAccess.actsAsCaller((input) => act({ kind: "drag", ...input })),
  computer_scroll: McpToolAccess.actsAsCaller((input) => act({ kind: "scroll", ...input })),
  computer_type: McpToolAccess.actsAsCaller((input) => act({ kind: "type", ...input })),
  computer_key: McpToolAccess.actsAsCaller((input) => act({ kind: "key", ...input })),
  computer_open: McpToolAccess.actsAsCaller((input) =>
    input.application === undefined && input.url === undefined
      ? Effect.fail(
          new ComputerUseToolError({ reason: "Pass an application name or a settings url." }),
        )
      : act({ kind: "open", ...input }),
  ),
} satisfies McpToolAccess.Handlers<typeof ComputerToolkit.tools>;

const { computer_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toWorkerLayer(ComputerStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toWorkerLayer(ComputerScreenshotToolkit, {
  computer_screenshot,
});

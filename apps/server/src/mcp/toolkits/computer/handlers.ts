import {
  type AccessRequestSubject,
  type ComputerToolActionResult,
  type ComputerUseAction,
  type ComputerUseActionResult,
  ComputerUseToolError,
} from "@specweave-studio/contracts";
import { teamRulesToolRefusal } from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../../../teamRules/TeamRules.ts";
import * as Effect from "effect/Effect";

import * as AccessGate from "../../../access/accessGate.ts";
import * as AccessRequests from "../../../access/AccessRequests.ts";
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

/** Actions that change something inside an app. */
const INPUT_ACTIONS: ReadonlySet<ComputerUseAction["kind"]> = new Set([
  "click",
  "drag",
  "scroll",
  "type",
  "key",
]);

/** System Settings panes open by URL, in System Settings. */
const SYSTEM_SETTINGS = "System Settings";

type Broker = ComputerUseBroker.ComputerUseBroker["Service"];

const nonEmpty = (name: string | undefined) =>
  name === undefined || name.trim().length === 0 ? undefined : name.trim();

/** What the agent is told when the app an input action would reach is unknown. */
export const UNKNOWN_TARGET_REFUSAL =
  "Could not tell which app is in front, so the action did not run. Take a screenshot and try again.";

/**
 * The apps an action reaches, read just before it runs: the app being
 * opened; for a click, drag or scroll, the app owning the topmost window
 * under each point (the frontmost app when the desktop app cannot say); for
 * typing and keys, the frontmost app. Screenshots and pointer moves change
 * nothing, so they reach no app. Input whose app cannot be told is refused,
 * never run unchecked.
 */
const targetApps = (action: ComputerUseAction, broker: Broker, threadId: string) =>
  Effect.gen(function* () {
    if (action.kind === "open") return [action.application ?? SYSTEM_SETTINGS];
    if (!INPUT_ACTIONS.has(action.kind)) return [];
    let frontmost: string | undefined | null = null;
    const readFrontmost = Effect.gen(function* () {
      if (frontmost === null) {
        const status = yield* broker.invoke({ kind: "status" }, { threadId });
        frontmost = nonEmpty(status.frontmostApplication);
      }
      return frontmost;
    });
    const at = (x: number, y: number) =>
      broker.invoke({ kind: "appAt", x, y }, { threadId }).pipe(
        Effect.map((result) => nonEmpty(result.application?.name)),
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((name) => (name === undefined ? readFrontmost : Effect.succeed(name))),
      );
    const names =
      action.kind === "click" || action.kind === "scroll"
        ? [yield* at(action.x, action.y)]
        : action.kind === "drag"
          ? [yield* at(action.fromX, action.fromY), yield* at(action.toX, action.toY)]
          : [yield* readFrontmost];
    const unique: Array<string> = [];
    for (const name of names) {
      if (name === undefined) {
        return yield* new ComputerUseToolError({ reason: UNKNOWN_TARGET_REFUSAL });
      }
      const key = AccessGate.appGrantKey(name);
      if (!unique.some((other) => AccessGate.appGrantKey(other) === key)) unique.push(name);
    }
    return unique;
  });

/**
 * Asks the user before an agent first opens or controls an app, with the
 * access request card. An Allow lasts for the thread or the machine. Input
 * never reaches SpecWithCode itself, where the cards are answered, and after
 * a card the target is read again: the user answered in SpecWithCode, so the
 * app in front may have changed.
 */
const requireAppAccess = (
  action: ComputerUseAction,
  scope: McpInvocationContext.McpThreadInvocationScope,
  broker: Broker,
) =>
  Effect.gen(function* () {
    const threadId = scope.thread.threadId;
    const input = INPUT_ACTIONS.has(action.kind);
    const names = yield* targetApps(action, broker, threadId);
    if (input && names.some(AccessGate.isSpecWithCodeApp)) {
      return yield* new ComputerUseToolError({ reason: AccessGate.SELF_CONTROL_REFUSAL });
    }
    // Bringing SpecWithCode forward changes nothing in it; input there is refused above.
    if (action.kind === "open" && names.every(AccessGate.isSpecWithCodeApp)) return;
    const access = yield* AccessRequests.AccessRequests;
    const isAllowed = (name: string) =>
      access.isAllowed(
        threadId as Parameters<typeof access.isAllowed>[0],
        AccessGate.appGrantKey(name),
      );
    // Already allowed by name: no lookup and no card.
    const missing: Array<string> = [];
    for (const name of names) if (!(yield* isAllowed(name))) missing.push(name);
    if (missing.length === 0) return;

    const subjects: Array<AccessRequestSubject> = [];
    for (const name of missing) subjects.push(yield* AccessGate.appSubject(name));
    const title = AccessGate.accessTitle(subjects);
    const labels = title.replace(/^Use /, "");
    const verb = action.kind === "open" ? "open" : "work in";
    const result = yield* AccessGate.ensureAccess({
      scope,
      subjects,
      reason: `The agent wants to ${verb} ${labels} on this Mac.`,
      timeoutMs: AccessGate.IMPLICIT_ACCESS_TIMEOUT_MS,
    }).pipe(
      Effect.mapError(
        (error) =>
          new ComputerUseToolError({
            reason: `Could not ask the user for access to ${labels}: ${error.message}`,
          }),
      ),
    );
    if (result.status !== "allowed") {
      return yield* new ComputerUseToolError({
        reason: AccessGate.accessRefusal(result.status, title),
      });
    }
    if (!input || !result.asked) return;

    // The user answered in SpecWithCode: never act on an app they did not allow.
    const grantedKeys = new Set(subjects.map((subject) => subject.key));
    const now = yield* targetApps(action, broker, threadId);
    for (const name of now) {
      if (AccessGate.isSpecWithCodeApp(name)) {
        return yield* new ComputerUseToolError({
          reason: `The app in front changed while the user was answering: SpecWithCode is there now. ${AccessGate.SELF_CONTROL_REFUSAL} Bring ${labels} forward with computer_open, then try again.`,
        });
      }
      if (grantedKeys.has(AccessGate.appGrantKey(name)) || (yield* isAllowed(name))) continue;
      return yield* new ComputerUseToolError({
        reason: `The app in front changed while the user was answering: ${name} is there now, not ${labels}, which the user allowed. Bring ${labels} forward with computer_open, then try again.`,
      });
    }
  });

const allowed = Effect.gen(function* () {
  // Team rules come first: with them off the capability is gone too, and the
  // project's switch is not what the user should go looking for.
  const refused = teamRulesToolRefusal(yield* currentTeamRules, "computerUse");
  if (refused !== null) return yield* new ComputerUseToolError({ reason: refused.message });
  return yield* requireComputerAccess;
});

/** A screenshot changes nothing in any app, so it needs no app access. */
const look = (action: ComputerUseAction) =>
  Effect.gen(function* () {
    const scope = yield* allowed;
    const broker = yield* ComputerUseBroker.ComputerUseBroker;
    return yield* broker.invoke(action, { threadId: scope.thread.threadId });
  });

const run = (action: ComputerUseAction) =>
  Effect.gen(function* () {
    const scope = yield* allowed;
    const broker = yield* ComputerUseBroker.ComputerUseBroker;
    yield* requireAppAccess(action, scope, broker);
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
      const result = yield* look({ kind: "screenshot" });
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

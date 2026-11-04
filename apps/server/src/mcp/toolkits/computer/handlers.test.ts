import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ComputerUseAction,
  type ComputerUseActionResult,
  ComputerUseToolError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import { TEAM_RULES_NONE } from "@specweave-studio/shared/teamRules";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as AccessGate from "../../../access/accessGate.ts";
import * as AccessRequests from "../../../access/AccessRequests.ts";
import * as ComputerUseBroker from "../../../computerUse/ComputerUseBroker.ts";
import * as ServerConfig from "../../../config.ts";
import { TeamRules, teamRulesOf } from "../../../teamRules/TeamRules.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import type { AccessRequestCardInput } from "../../OrchestratorMcpService.ts";

const threadId = ThreadId.make("thread-computer-test");
const invocation = {
  environmentId: EnvironmentId.make("environment-computer-test"),
  requestNamespace: "provider-session-computer-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-computer-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(["computer"]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const base: ComputerUseActionResult = {
  platform: "darwin",
  permissions: { screenRecording: true, accessibility: true },
  frontmostApplication: "Notes",
};

/**
 * The computer toolkit against a desktop app whose frontmost app is Notes,
 * with `allowed` grant keys and the user answering any card with `answer`.
 * `frontmost` lists what each status read reports in turn (the last one
 * repeats); `appAt` names the app under a point, defaulting to the frontmost
 * app, and "fail" makes the lookup fail.
 */
const harness = (input: {
  readonly allowed: ReadonlyArray<string>;
  readonly answer: "allowed" | "denied";
  readonly frontmost?: ReadonlyArray<string>;
  readonly appAt?: (x: number, y: number, frontmost: string) => string | undefined | "fail";
}) => {
  AccessGate.clearAppSubjectCache();
  const actions: Array<ComputerUseAction> = [];
  const asked: Array<AccessRequestCardInput> = [];
  const frontmostQueue = [...(input.frontmost ?? ["Notes"])];
  let answeredCards = 0;
  // After a card, the next reads see the next frontmost app.
  const frontmost = () => frontmostQueue[Math.min(answeredCards, frontmostQueue.length - 1)]!;
  const layer = McpHttpServer.layerComputerToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(McpToolAccessTestkit.noProjectsLayer),
    Layer.provideMerge(
      Layer.mock(ComputerUseBroker.ComputerUseBroker)({
        invoke: (action) =>
          Effect.suspend(() => {
            actions.push(action);
            const front = { ...base, frontmostApplication: frontmost() };
            if (action.kind === "appInfo") {
              return Effect.succeed({ ...front, application: { name: action.application } });
            }
            if (action.kind === "appAt") {
              const name = (input.appAt ?? ((_x, _y, app) => app))(action.x, action.y, frontmost());
              if (name === "fail") {
                return Effect.fail(new ComputerUseToolError({ reason: "No desktop app." }));
              }
              return Effect.succeed(
                name === undefined ? front : { ...front, application: { name } },
              );
            }
            if (action.kind === "screenshot") {
              return Effect.succeed({
                ...front,
                screenshot: { mimeType: "image/png" as const, data: "AAAA", width: 10, height: 10 },
              });
            }
            return Effect.succeed(front);
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(AccessRequests.AccessRequests)({
        isAllowed: (_threadId, key) => Effect.succeed(input.allowed.includes(key)),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
        requestAccess: (_scope, card) =>
          Effect.sync(() => {
            asked.push(card);
            answeredCards += 1;
            return input.answer === "allowed"
              ? { status: "allowed" as const, scope: "thread" as const }
              : { status: "denied" as const };
          }),
      }),
    ),
    Layer.provideMerge(Layer.succeed(TeamRules, teamRulesOf(TEAM_RULES_NONE))),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-mcp-computer-test-" })),
    Layer.provide(NodeServices.layer),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });
  return { layer, call, actions, asked };
};

const text = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("\n");

it.effect("asks before typing into an app the thread may not use, and refuses on Deny", () => {
  const { layer, call, actions, asked } = harness({ allowed: [], answer: "denied" });
  return Effect.gen(function* () {
    const result = yield* call("computer_type", { text: "milk" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("The user did not allow this (Use Notes)");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      accessTitle: "Use Notes",
      reason: "The agent wants to work in Notes on this Mac.",
      subjects: [{ kind: "app", key: "app:notes", label: "Notes" }],
    });
    // The frontmost app was read, but nothing was typed.
    expect(actions.map((action) => action.kind)).toEqual(["status", "appInfo"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("types once the user allows the frontmost app", () => {
  const { layer, call, actions, asked } = harness({ allowed: [], answer: "allowed" });
  return Effect.gen(function* () {
    const result = yield* call("computer_click", { x: 5, y: 5 });
    expect(result.isError).toBe(false);
    expect(asked).toHaveLength(1);
    // The app under the point is read again after the card, before the click.
    expect(actions.map((action) => action.kind)).toEqual(["appAt", "appInfo", "appAt", "click"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("works in an app already allowed without a card", () => {
  const { layer, call, actions, asked } = harness({ allowed: ["app:notes"], answer: "denied" });
  return Effect.gen(function* () {
    const result = yield* call("computer_key", { keys: "cmd+n" });
    expect(result.isError).toBe(false);
    expect(asked).toHaveLength(0);
    // Allowed by name: no app lookup at all.
    expect(actions.map((action) => action.kind)).toEqual(["status", "key"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("asks for the app being opened, by its own name", () => {
  const { layer, call, actions, asked } = harness({ allowed: [], answer: "allowed" });
  return Effect.gen(function* () {
    const result = yield* call("computer_open", { application: "Calendar" });
    expect(result.isError).toBe(false);
    expect(asked[0]).toMatchObject({
      accessTitle: "Use Calendar",
      reason: "The agent wants to open Calendar on this Mac.",
    });
    // Opening does not ask which app is frontmost.
    expect(actions.map((action) => action.kind)).toEqual(["appInfo", "open"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("takes screenshots and moves the pointer without a card", () => {
  const { layer, call, actions, asked } = harness({ allowed: [], answer: "denied" });
  return Effect.gen(function* () {
    const shot = yield* call("computer_screenshot", {});
    expect(shot.isError).toBe(false);
    const moved = yield* call("computer_move", { x: 1, y: 1 });
    expect(moved.isError).toBe(false);
    expect(asked).toHaveLength(0);
    expect(actions.map((action) => action.kind)).toEqual(["screenshot", "move"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("refuses when the app in front changed while the user answered", () => {
  const { layer, call, actions, asked } = harness({
    allowed: [],
    answer: "allowed",
    frontmost: ["Notes", "Mail"],
  });
  return Effect.gen(function* () {
    const result = yield* call("computer_type", { text: "milk" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("The app in front changed");
    expect(text(result)).toContain("Mail is there now, not Notes");
    expect(text(result)).toContain("computer_open");
    expect(asked).toHaveLength(1);
    expect(actions.some((action) => action.kind === "type")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("refuses when SpecWithCode is in front after the user answered there", () => {
  const { layer, call, actions } = harness({
    allowed: [],
    answer: "allowed",
    frontmost: ["Notes", "SpecWithCode"],
  });
  return Effect.gen(function* () {
    const result = yield* call("computer_key", { keys: "return" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("SpecWithCode is there now");
    expect(text(result)).toContain("Bring Notes forward with computer_open");
    expect(actions.some((action) => action.kind === "key")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("goes ahead when the app in front changed to another allowed app", () => {
  const { layer, call, actions } = harness({
    allowed: ["app:mail"],
    answer: "allowed",
    frontmost: ["Notes", "Mail"],
  });
  return Effect.gen(function* () {
    const result = yield* call("computer_type", { text: "milk" });
    expect(result.isError).toBe(false);
    expect(actions.at(-1)?.kind).toBe("type");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("never clicks or types in SpecWithCode, and shows no card", () => {
  const { layer, call, actions, asked } = harness({
    allowed: ["app:specwithcode", "app:specwithcode (dev)"],
    answer: "allowed",
    frontmost: ["SpecWithCode (Dev)"],
  });
  return Effect.gen(function* () {
    for (const [name, args] of [
      ["computer_click", { x: 1, y: 1 }],
      ["computer_drag", { fromX: 1, fromY: 1, toX: 2, toY: 2 }],
      ["computer_scroll", { x: 1, y: 1, direction: "down" }],
      ["computer_type", { text: "allow" }],
      ["computer_key", { keys: "return" }],
    ] as const) {
      const result = yield* call(name, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(AccessGate.SELF_CONTROL_REFUSAL);
    }
    expect(asked).toHaveLength(0);
    expect(actions.map((action) => action.kind)).not.toContain("appInfo");
    expect(
      actions.filter((action) => !["status", "appAt"].includes(action.kind)).map((a) => a.kind),
    ).toEqual([]);
    // Bringing SpecWithCode forward and looking at it stay allowed.
    const opened = yield* call("computer_open", { application: "SpecWithCode" });
    expect(opened.isError).toBe(false);
    const shot = yield* call("computer_screenshot", {});
    expect(shot.isError).toBe(false);
    expect(asked).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("gates a click on the app under the point, not the frontmost app", () => {
  const { layer, call, actions, asked } = harness({
    allowed: ["app:notes"],
    answer: "denied",
    appAt: (x) => (x > 100 ? "Terminal" : "Notes"),
  });
  return Effect.gen(function* () {
    const inNotes = yield* call("computer_click", { x: 10, y: 10 });
    expect(inNotes.isError).toBe(false);
    expect(asked).toHaveLength(0);
    const inTerminal = yield* call("computer_click", { x: 500, y: 10 });
    expect(inTerminal.isError).toBe(true);
    expect(asked[0]).toMatchObject({ accessTitle: "Use Terminal" });
    expect(actions.filter((action) => action.kind === "click")).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("gates a drag on the apps under both ends, in one card", () => {
  const { layer, call, asked } = harness({
    allowed: [],
    answer: "denied",
    appAt: (x) => (x > 100 ? "Finder" : "Notes"),
  });
  return Effect.gen(function* () {
    const result = yield* call("computer_drag", { fromX: 10, fromY: 10, toX: 500, toY: 10 });
    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      accessTitle: "Use Notes and Finder",
      reason: "The agent wants to work in Notes and Finder on this Mac.",
    });
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("falls back to the frontmost app when the app under the point is unknown", () => {
  const { layer, call, actions, asked } = harness({
    allowed: [],
    answer: "denied",
    appAt: () => "fail",
  });
  return Effect.gen(function* () {
    const result = yield* call("computer_click", { x: 10, y: 10 });
    expect(result.isError).toBe(true);
    expect(asked[0]).toMatchObject({ accessTitle: "Use Notes" });
    expect(actions.map((action) => action.kind)).toEqual(["appAt", "status", "appInfo"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("refuses input when neither the point nor the frontmost app can be told", () => {
  const { layer, call, actions, asked } = harness({
    allowed: [],
    answer: "allowed",
    frontmost: [""],
    appAt: () => undefined,
  });
  return Effect.gen(function* () {
    for (const [name, args] of [
      ["computer_click", { x: 10, y: 10 }],
      ["computer_drag", { fromX: 10, fromY: 10, toX: 20, toY: 20 }],
      ["computer_scroll", { x: 10, y: 10, direction: "down" }],
      ["computer_type", { text: "hello" }],
      ["computer_key", { keys: "cmd+a" }],
    ] as const) {
      const result = yield* call(name, args);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(
        "Could not tell which app is in front, so the action did not run.",
      );
    }
    expect(asked).toHaveLength(0);
    expect(actions.filter((action) => !["status", "appAt"].includes(action.kind))).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("gates a scroll on the app under the point", () => {
  const { layer, call, actions, asked } = harness({
    allowed: ["app:notes"],
    answer: "denied",
    appAt: (x) => (x > 100 ? "Terminal" : "Notes"),
  });
  return Effect.gen(function* () {
    const inNotes = yield* call("computer_scroll", { x: 10, y: 10, direction: "down" });
    expect(inNotes.isError).toBe(false);
    const inTerminal = yield* call("computer_scroll", { x: 500, y: 10, direction: "down" });
    expect(inTerminal.isError).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ accessTitle: "Use Terminal" });
    expect(actions.filter((action) => action.kind === "scroll")).toHaveLength(1);
    expect(actions.some((action) => action.kind === "status")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

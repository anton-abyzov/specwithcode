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
  type ChromePeerInput,
  ChromePressInput,
  ChromeProfilesInput,
  ChromeProfilesResult,
  ChromeScreenshotInput,
  ChromeScreenshotResult,
  ChromeSnapshotInput,
  ChromeSnapshotResult,
  ChromeTabsInput,
  ChromeTabsResult,
  type ChromeToolName,
  ChromeTypeInput,
  OrchestratorMcpFailure,
  type OrchestratorMcpMachineRef,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BrowserExtension from "../../../browserExtension/BrowserExtension.ts";
import { ChromeTools } from "../../../browserExtension/chromeTools.ts";
import { BrowserRelayError } from "../../../browserExtension/relayHub.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { workerClientName } from "../../../fleet/workerGrantMint.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ChromeScreenshotToolkit, ChromeStandardToolkit, ChromeToolkit } from "./tools.ts";

const toolsByHub = new WeakMap<object, ChromeTools>();

/** A page action on another machine waits for loads there, plus the trip. */
const REMOTE_TIMEOUT_MS = 60_000;
/** Looking for a machine with Chrome should not hold a call up for long. */
const PROBE_TIMEOUT_MS = 8_000;
const MAX_REMEMBERED = 500;
/** The answer carries the image twice; this keeps it well under the fleet client's cap. */
const MAX_PEER_SCREENSHOT_CHARS = 8 * 1024 * 1024;

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

const toolsFor = (hub: object & ConstructorParameters<typeof ChromeTools>[0]) => {
  let tools = toolsByHub.get(hub);
  if (!tools) {
    tools = new ChromeTools(hub);
    toolsByHub.set(hub, tools);
  }
  return tools;
};

/** Each chrome_* action's input and answer, for checking calls that cross machines. */
const actions = {
  chrome_profiles: { input: ChromeProfilesInput, success: ChromeProfilesResult },
  chrome_tabs: { input: ChromeTabsInput, success: ChromeTabsResult },
  chrome_open: { input: ChromeOpenInput, success: ChromePageResult },
  chrome_navigate: { input: ChromeNavigateInput, success: ChromePageResult },
  chrome_snapshot: { input: ChromeSnapshotInput, success: ChromeSnapshotResult },
  chrome_click: { input: ChromeClickInput, success: ChromePageResult },
  chrome_type: { input: ChromeTypeInput, success: ChromePageResult },
  chrome_press: { input: ChromePressInput, success: ChromePageResult },
  chrome_screenshot: { input: ChromeScreenshotInput, success: ChromeScreenshotResult },
  chrome_evaluate: { input: ChromeEvaluateInput, success: ChromeEvaluateResult },
  chrome_close: { input: ChromeCloseInput, success: ChromeCloseResult },
} as const;

type Answer<N extends ChromeToolName> = (typeof actions)[N]["success"]["Type"];

type Compiled = (value: unknown) => Effect.Effect<unknown, Schema.SchemaError>;
/** Each action's schemas compiled once; these schemas need no services. */
const compiled = (make: (entry: (typeof actions)[ChromeToolName]) => unknown) =>
  Object.fromEntries(Object.entries(actions).map(([name, entry]) => [name, make(entry)])) as Record<
    ChromeToolName,
    Compiled
  >;
const decodeInput = compiled((entry) => Schema.decodeUnknownEffect(entry.input));
const decodeAnswer = compiled((entry) => Schema.decodeUnknownEffect(entry.success));
const encodeAnswer = compiled((entry) => Schema.encodeUnknownEffect(entry.success));

const perform = (tools: ChromeTools, threadId: string, action: ChromeToolName, input: never) => {
  switch (action) {
    case "chrome_profiles":
      return tools.profiles(threadId);
    case "chrome_tabs":
      return tools.tabs(threadId, (input as { profile?: string }).profile);
    case "chrome_open":
      return tools.open(threadId, input);
    case "chrome_navigate":
      return tools.navigate(threadId, input);
    case "chrome_snapshot":
      return tools.snapshot(threadId, input);
    case "chrome_click":
      return tools.click(threadId, input);
    case "chrome_type":
      return tools.type(threadId, input);
    case "chrome_press":
      return tools.press(threadId, input);
    case "chrome_screenshot":
      return tools.screenshot(threadId, input);
    case "chrome_evaluate":
      return tools.evaluateExpression(threadId, input);
    case "chrome_close":
      return tools.close(threadId, input);
  }
};

/** One chrome_* action in this machine's Chrome, as the thread `threadId` names. */
const runLocal = <N extends ChromeToolName>(threadId: string, action: N, input: unknown) =>
  Effect.gen(function* () {
    const extension = yield* BrowserExtension.BrowserExtension;
    const tools = toolsFor(extension.hub);
    return (yield* Effect.tryPromise({
      try: async () => perform(tools, threadId, action, input as never),
      catch: toToolError,
    })) as Answer<N>;
  });

// ── Chrome on another machine ───────────────────────────────────────────────

/** The machine whose Chrome each thread here used last, so later calls go there too. */
const machineByThread = new Map<string, string>();
const remember = (threadId: string, machineId: string) => {
  machineByThread.delete(threadId);
  machineByThread.set(threadId, machineId);
  if (machineByThread.size > MAX_REMEMBERED)
    machineByThread.delete(machineByThread.keys().next().value!);
};

const asToolFailure = (error: OrchestratorMcpFailure) =>
  error.code === "unknown_machine"
    ? new BrowserExtensionToolError({ code: "invalid_request", reason: error.message })
    : error;

const withoutMachine = (input: Record<string, unknown>) => {
  const { machine: _machine, ...rest } = input;
  return rest;
};

/** Sends one chrome_* call to `machine` for the calling thread and checks the answer. */
const forward = <N extends ChromeToolName>(
  machine: OrchestratorMcpMachineRef,
  threadId: string,
  action: N,
  input: Record<string, unknown>,
  timeoutMs = REMOTE_TIMEOUT_MS,
) =>
  Effect.gen(function* () {
    const workers = yield* RemoteWorkers.RemoteWorkers;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const descriptor = yield* environment.getDescriptor;
    const context = yield* readCaller().pipe(Effect.orElseSucceed(() => undefined));
    const caller: ChromePeerInput["caller"] = {
      environmentId: descriptor.environmentId,
      machine: descriptor.label.slice(0, 100),
      threadId: threadId.slice(0, 200),
      title: (context?.caller?.title ?? "").slice(0, 200),
    };
    const answer = yield* workers
      .proxy({
        machine,
        tool: "chrome_peer",
        arguments: { action, input: withoutMachine(input), caller },
        timeoutMs,
      })
      .pipe(
        Effect.mapError((error) =>
          error.code === "machine_unsupported"
            ? new OrchestratorMcpFailure({
                code: "machine_unsupported",
                message: `${machine.label} runs a SpecWithCode version that cannot lend its Chrome yet. Update SpecWithCode there.`,
              })
            : error,
        ),
      );
    const decoded: unknown = yield* decodeAnswer[action](answer).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `${machine.label} sent a Chrome answer this machine could not read.`,
          }),
      ),
    );
    return decoded as Answer<N>;
  });

/** Machines whose grant lets this one call them, in the order Settings lists them. */
const usableMachines = Effect.gen(function* () {
  const workers = yield* RemoteWorkers.RemoteWorkers;
  if (!workers.enabled) return [];
  const listed = yield* workers
    .listMachines({ projectId: undefined, probe: false })
    .pipe(Effect.orElseSucceed(() => ({ machines: [] })));
  return listed.machines
    .filter((machine) => machine.status === "ready" || machine.status === "grant_expiring")
    .map(({ id, label, environmentId }): OrchestratorMcpMachineRef => ({
      id,
      label,
      environmentId,
    }));
});

const isFleetFailure = Schema.is(OrchestratorMcpFailure);
const isChromeFailure = Schema.is(BrowserExtensionToolError);

/** The owner on the other machine has not allowed this one, or declined it. */
const WAITS_FOR_OWNER = "waits for the owner to allow this machine";
const OWNER_DECLINED = "The owner declined Chrome on";
const needsOwner = (error: unknown) =>
  isFleetFailure(error) &&
  (error.message.includes(WAITS_FOR_OWNER) || error.message.includes(OWNER_DECLINED));

/**
 * Each usable machine's profiles. A machine that does not answer is left out;
 * one whose owner has not allowed this machine is kept in `waiting` so the
 * agent can say what to do.
 */
const remoteProfiles = (threadId: string) =>
  Effect.gen(function* () {
    const machines = yield* usableMachines;
    const rows = yield* Effect.forEach(
      machines,
      (machine) =>
        forward(machine, threadId, "chrome_profiles", {}, PROBE_TIMEOUT_MS).pipe(
          Effect.map((result) => ({ machine, result, waiting: undefined as string | undefined })),
          Effect.catch((error) =>
            Effect.succeed(
              needsOwner(error)
                ? {
                    machine,
                    result: { profiles: [] },
                    waiting: (error as OrchestratorMcpFailure).message,
                  }
                : null,
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    const answered = rows.filter((row) => row !== null);
    return {
      rows: answered.filter((row) => row.waiting === undefined),
      waiting: answered.flatMap((row) => (row.waiting === undefined ? [] : [row.waiting])),
    };
  });

type Route =
  | { readonly kind: "local" }
  | {
      readonly kind: "remote";
      readonly machine: OrchestratorMcpMachineRef;
      /** Chosen because this thread used it last, not named or found just now. */
      readonly remembered?: boolean;
    };

/**
 * Where a call goes: the machine it names; else this machine when a profile
 * is paired here; else the machine this thread used last; else the first
 * connected machine with a paired profile.
 */
const route = (threadId: string, named: string | undefined) =>
  Effect.gen(function* () {
    const workers = yield* RemoteWorkers.RemoteWorkers;
    if (named !== undefined) {
      const target = yield* workers.resolveMachine(named).pipe(Effect.mapError(asToolFailure));
      if (target.kind === "remote") remember(threadId, target.machine.id);
      else machineByThread.delete(threadId);
      return target as Route;
    }
    const extension = yield* BrowserExtension.BrowserExtension;
    if (extension.hub.profiles().length > 0 || !workers.enabled) return { kind: "local" } as Route;
    const machines = yield* usableMachines;
    const last = machines.find((machine) => machine.id === machineByThread.get(threadId));
    if (last) return { kind: "remote", machine: last, remembered: true } as Route;
    const probed = yield* remoteProfiles(threadId);
    const found = probed.rows.find((row) => row.result.profiles.length > 0);
    if (found === undefined) {
      if (probed.waiting.length > 0)
        return yield* new BrowserExtensionToolError({
          code: "needs_approval",
          reason: probed.waiting.join(" "),
        });
      return { kind: "local" } as Route;
    }
    remember(threadId, found.machine.id);
    return { kind: "remote", machine: found.machine } as Route;
  });

/** chrome_profiles: this machine's profiles, then those of every connected machine. */
const listProfiles = (threadId: string, named: string | undefined) =>
  Effect.gen(function* () {
    const workers = yield* RemoteWorkers.RemoteWorkers;
    if (named !== undefined) {
      const target = yield* workers.resolveMachine(named).pipe(Effect.mapError(asToolFailure));
      if (target.kind === "remote") {
        const result = yield* forward(target.machine, threadId, "chrome_profiles", {});
        return {
          profiles: result.profiles.map((profile) => ({ ...profile, machine: target.machine.id })),
          hint:
            result.profiles.length === 0
              ? `No Chrome profile is paired on ${target.machine.label}.`
              : `These profiles are on ${target.machine.label}: pass machine "${target.machine.id}" to the other chrome_* tools, with profile when there are several. Without machine they use this machine's Chrome when one is paired here.`,
        };
      }
    }
    const local = yield* runLocal(threadId, "chrome_profiles", {});
    if (named !== undefined) return local;
    const probed = yield* remoteProfiles(threadId);
    const remote = probed.rows.filter((row) => row.result.profiles.length > 0);
    const waiting = probed.waiting.length > 0 ? ` ${probed.waiting.join(" ")}` : "";
    if (remote.length === 0)
      return waiting === "" ? local : { ...local, hint: `${local.hint ?? ""}${waiting}`.trim() };
    const where = remote
      .map(({ machine }) => `${machine.label} (machine "${machine.id}")`)
      .join(", ");
    return {
      profiles: [
        ...local.profiles,
        ...remote.flatMap(({ machine, result }) =>
          result.profiles.map((profile) => ({ ...profile, machine: machine.id })),
        ),
      ],
      hint:
        (local.profiles.length === 0
          ? `No Chrome profile is paired on this machine, so the chrome_* tools use Chrome on ${where} when machine is omitted. Pass machine and profile to choose.`
          : `Profiles with a machine are on another computer (${where}): pass that machine, and profile, to the other chrome_* tools. Without machine they use this machine's Chrome.`) +
        waiting,
    };
  });

/**
 * A call may move to another machine only when it names no tab or element of
 * the old one and repeating it cannot do something twice.
 */
const movable = (action: ChromeToolName, input: Record<string, unknown>) =>
  (action === "chrome_open" || action === "chrome_tabs") &&
  input.tabId === undefined &&
  input.ref === undefined;

/**
 * The machine refused before acting: it cannot lend Chrome or has none paired
 * any more. "Unreachable" also covers a call that timed out after it was sent,
 * so only chrome_tabs, which changes nothing, moves on that.
 */
const machineGone = (error: unknown, action: ChromeToolName) =>
  (isFleetFailure(error) &&
    ((error.code === "machine_unreachable" && action === "chrome_tabs") ||
      error.code === "machine_unsupported" ||
      error.code === "machine_not_authorized" ||
      /not connected|no chrome profile is paired/i.test(error.message))) ||
  (isChromeFailure(error) && error.code === "not_connected");

/** Runs one chrome_* action as the calling thread, here or on the machine with the Chrome. */
const run = <N extends ChromeToolName>(action: N, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const scope = yield* requireChromeAccess;
    const threadId = scope.thread.threadId;
    const named = typeof input.machine === "string" ? input.machine : undefined;
    if (action === "chrome_profiles") return (yield* listProfiles(threadId, named)) as Answer<N>;
    const target = yield* route(threadId, named);
    if (target.kind === "local") return yield* runLocal(threadId, action, input);
    if (!target.remembered || !movable(action, input))
      return yield* forward(target.machine, threadId, action, input);
    // The machine this thread used last may be gone or have lost its Chrome:
    // look again once. Only for calls that mean the same thing anywhere.
    return yield* forward(target.machine, threadId, action, input).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!machineGone(error, action)) return yield* error;
          machineByThread.delete(threadId);
          const next = yield* route(threadId, undefined);
          if (next.kind === "remote" && next.machine.id !== target.machine.id)
            return yield* forward(next.machine, threadId, action, input);
          return yield* error;
        }),
      ),
    );
  });

// ── chrome_peer: the receiving side ─────────────────────────────────────────

const notForAgents = new BrowserExtensionToolError({
  code: "invalid_request",
  reason:
    "chrome_peer is for other SpecWithCode machines in the owner's fleet. Agents use the chrome_* tools.",
});

/**
 * Only another machine's worker grant may call chrome_peer: an MCP client
 * signed in under that machine's worker name, with more than read access,
 * and allowed by the owner in Settings › Chrome here. The name is the
 * client's own choice, so the owner's answer for that one grant is what
 * lets it in.
 */
const requirePeer = (caller: ChromePeerInput["caller"]) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const client = scope.client;
    if (
      client === undefined ||
      scope.thread !== undefined ||
      client.access === "read-only" ||
      client.label !== workerClientName(caller.environmentId)
    )
      return yield* notForAgents;
    const extension = yield* BrowserExtension.BrowserExtension;
    const state = extension.peerAccess({
      id: client.sessionId,
      machine: caller.machine || "Another machine",
      label: client.label,
      environmentId: caller.environmentId,
    });
    if (state === "allowed") return client;
    const here = extension.hub.machineName();
    return yield* new BrowserExtensionToolError({
      code: "needs_approval",
      reason:
        state === "declined"
          ? `The owner declined Chrome on ${here} for this machine. They can allow it in Settings › Chrome on ${here}.`
          : `Chrome on ${here} waits for the owner to allow this machine: ask them to click Allow in Settings › Chrome on ${here}, then try again.`,
    });
  });

/** How a thread on another machine is known in this machine's tab ownership. */
export const peerThreadKey = (caller: ChromePeerInput["caller"]) =>
  `peer:${caller.environmentId}:${caller.threadId}`;

const peer = (payload: ChromePeerInput) =>
  Effect.gen(function* () {
    const client = yield* requirePeer(payload.caller);
    const input: unknown = yield* decodeInput[payload.action](payload.input).pipe(
      Effect.mapError(
        () =>
          new BrowserExtensionToolError({
            code: "invalid_request",
            reason: `The ${payload.action} request was not valid.`,
          }),
      ),
    );
    const extension = yield* BrowserExtension.BrowserExtension;
    const key = peerThreadKey(payload.caller);
    extension.hub.nameThread(key, {
      title: payload.caller.title || "Untitled thread",
      machine: payload.caller.machine,
    });
    // Access taken back while this call ran: let go of what it just took.
    const stillAllowed = Effect.suspend(() =>
      Effect.promise(async () => {
        if (extension.peerState(client.sessionId) !== "allowed")
          await extension.hub.stopThreadsWithPrefix(`peer:${payload.caller.environmentId}:`);
      }),
    );
    const result = yield* runLocal(key, payload.action, input).pipe(Effect.ensuring(stillAllowed));
    if (
      payload.action === "chrome_screenshot" &&
      (result as Answer<"chrome_screenshot">).screenshot.data.length > MAX_PEER_SCREENSHOT_CHARS
    )
      return yield* new BrowserExtensionToolError({
        code: "invalid_request",
        reason:
          "That screenshot is too large to send to another machine. Take it without fullPage, or scroll and take several.",
      });
    const encoded: unknown = yield* encodeAnswer[payload.action](result).pipe(Effect.orDie);
    return encoded as Record<string, unknown>;
  });

const handlers = {
  chrome_profiles: McpToolAccess.readsAsCaller((input) => run("chrome_profiles", input)),
  chrome_tabs: McpToolAccess.readsAsCaller((input) => run("chrome_tabs", input)),
  chrome_open: McpToolAccess.actsAsCaller((input) => run("chrome_open", input)),
  chrome_navigate: McpToolAccess.actsAsCaller((input) => run("chrome_navigate", input)),
  chrome_snapshot: McpToolAccess.readsAsCaller((input) => run("chrome_snapshot", input)),
  chrome_click: McpToolAccess.actsAsCaller((input) => run("chrome_click", input)),
  chrome_type: McpToolAccess.actsAsCaller((input) => run("chrome_type", input)),
  chrome_press: McpToolAccess.actsAsCaller((input) => run("chrome_press", input)),
  chrome_screenshot: McpToolAccess.readsAsCaller((input) => run("chrome_screenshot", input)),
  chrome_evaluate: McpToolAccess.actsAsCaller((input) => run("chrome_evaluate", input)),
  chrome_close: McpToolAccess.actsAsCaller((input) => run("chrome_close", input)),
  // Checks its own caller: another machine, never an agent.
  chrome_peer: McpToolAccess.reads(peer),
} satisfies McpToolAccess.Handlers<typeof ChromeToolkit.tools>;

const { chrome_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(ChromeStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(ChromeScreenshotToolkit, {
  chrome_screenshot,
});

/** For tests: one chrome_* call as a thread here, and chrome_peer as another machine sends it. */
export { peer as runChromePeer, run as runChromeTool };

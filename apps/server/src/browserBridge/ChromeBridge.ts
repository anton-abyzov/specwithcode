import {
  type BrowserBridgeCheck,
  type BrowserBridgeStatus,
  WS_METHODS,
  WsBrowserBridgeRpcGroup,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { makeClaudeEnvironment, resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  chromeInstalled,
  chromeProfileNames,
  chromeRunning,
  claudeChromeFacts,
  defaultChromeBridgePaths,
  liveExtensionConnections,
  nativeHostInstalled,
  providerWiring,
} from "./chromeBridgeFacts.ts";
import {
  BROWSER_MCP_FLAG,
  type BrowserMcpToolCall,
  CHECK_CALLS,
  callBrowserMcp,
  classifyBrowserCheck,
  RECONNECT_CALLS,
} from "./chromeBridgeProbe.ts";

const CHECK_TIMEOUT_MS = 20_000;
/** switch_browser waits up to two minutes for a click in Chrome. */
const RECONNECT_TIMEOUT_MS = 150_000;

/**
 * The last check outlives any one client connection, so every window on this
 * machine shows the same result and time. One check runs at a time.
 */
let lastCheck: BrowserBridgeCheck | null = null;
const checks = Semaphore.makeUnsafe(1);

/** The browser server as the configured Claude instance would start it, with its config folder. */
const claudeLaunch = Effect.gen(function* () {
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
  const claude = settings.providers.claudeAgent;
  const baseEnv = yield* HostProcessEnvironment;
  const env = yield* makeClaudeEnvironment(claude, baseEnv);
  const configDir =
    claude.homePath.trim() || baseEnv.CLAUDE_CONFIG_DIR?.trim()
      ? yield* resolveClaudeHomePath(claude, baseEnv)
      : null;
  const spawn = yield* resolveSpawnCommand(claude.binaryPath || "claude", [BROWSER_MCP_FLAG], {
    env,
  });
  return { command: { command: spawn.command, args: spawn.args, env }, configDir };
});

const runCheck = (calls: ReadonlyArray<BrowserMcpToolCall>, timeoutMs: number) =>
  checks.withPermits(1)(
    Effect.gen(function* () {
      const { command } = yield* claudeLaunch;
      const started = yield* Clock.currentTimeMillis;
      const outcome = yield* Effect.promise(() => callBrowserMcp(command, calls, timeoutMs));
      const finished = yield* Clock.currentTimeMillis;
      const check = classifyBrowserCheck(
        outcome,
        DateTime.formatIso(DateTime.makeUnsafe(finished)),
        finished - started,
      );
      lastCheck = check;
      return check;
    }),
  );

const status = Effect.gen(function* () {
  const { configDir } = yield* claudeLaunch;
  const paths = defaultChromeBridgePaths(configDir);
  const claude = claudeChromeFacts(paths.claudeFile);
  const running = yield* Effect.promise(() => chromeRunning());
  return {
    platform: yield* HostProcessPlatform,
    chrome: { installed: chromeInstalled(paths.home), running },
    extension: {
      nativeHostInstalled: nativeHostInstalled(paths.home),
      liveConnections: liveExtensionConnections(paths.tmpDirs),
      pairedBrowserName: claude.pairedBrowserName,
    },
    claudeAccount: claude.account,
    chromeProfiles: chromeProfileNames(paths.home),
    providers: providerWiring(paths, claude),
    lastCheck,
  } satisfies BrowserBridgeStatus;
});

/** Failures to read settings still answer, as an unchecked machine rather than an RPC error. */
const orUnavailable = <A, E>(effect: Effect.Effect<A, E, never>, fallback: A) =>
  effect.pipe(Effect.orElseSucceed(() => fallback));

export const layerRpcHandlers = WsBrowserBridgeRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<ServerSettings.ServerSettingsService | Path.Path>();
    const platform = yield* HostProcessPlatform;
    const run = <A, E>(
      effect: Effect.Effect<A, E, ServerSettings.ServerSettingsService | Path.Path>,
    ) => effect.pipe(Effect.provideContext(context));
    const failedCheck = (message: string): BrowserBridgeCheck => ({
      state: "error",
      browsers: [],
      message,
      checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      durationMs: 0,
    });
    return {
      [WS_METHODS.browserBridgeStatus]: () =>
        orUnavailable(run(status), {
          platform,
          chrome: { installed: false, running: false },
          extension: { nativeHostInstalled: false, liveConnections: 0, pairedBrowserName: null },
          claudeAccount: null,
          chromeProfiles: null,
          providers: [],
          lastCheck,
        }),
      [WS_METHODS.browserBridgeTest]: () =>
        orUnavailable(
          run(runCheck(CHECK_CALLS, CHECK_TIMEOUT_MS)),
          failedCheck("SpecWithCode could not read its Claude settings."),
        ),
      [WS_METHODS.browserBridgeReconnect]: () =>
        orUnavailable(
          run(runCheck(RECONNECT_CALLS, RECONNECT_TIMEOUT_MS)),
          failedCheck("SpecWithCode could not read its Claude settings."),
        ),
    };
  }),
);

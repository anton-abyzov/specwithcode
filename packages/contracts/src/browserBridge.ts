import * as Schema from "effect/Schema";
import { Rpc } from "effect/rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";

/**
 * Chrome as agents reach it on one machine: the Claude in Chrome extension,
 * reached through Claude Code's built-in browser MCP server. Each machine's
 * server reports its own Chrome; nothing here crosses machines.
 */
export const BROWSER_BRIDGE_RPC_METHODS = {
  browserBridgeStatus: "browserBridge.status",
  browserBridgeTest: "browserBridge.test",
  browserBridgeReconnect: "browserBridge.reconnect",
} as const;

/** Where the extension stands after a live round trip through the browser MCP server. */
export const BrowserBridgeCheckState = Schema.Literals([
  /** At least one Chrome answered, and its tabs could be read. */
  "connected",
  /** Chrome answered but more than one is connected and none is chosen yet. */
  "choose_browser",
  /** The MCP server ran, but no extension is reachable. */
  "not_connected",
  /** Claude Code is missing, so the browser MCP server cannot start. */
  "cli_missing",
  /** The MCP server did not answer in time. */
  "timeout",
  /** Anything else; `message` carries the server's own words. */
  "error",
]);
export type BrowserBridgeCheckState = typeof BrowserBridgeCheckState.Type;

export const BrowserBridgeBrowser = Schema.Struct({
  name: Schema.String,
  deviceId: Schema.optionalKey(Schema.String),
  platform: Schema.optionalKey(Schema.String),
  onThisComputer: Schema.optionalKey(Schema.Boolean),
  inUse: Schema.optionalKey(Schema.Boolean),
});
export type BrowserBridgeBrowser = typeof BrowserBridgeBrowser.Type;

export const BrowserBridgeCheck = Schema.Struct({
  state: BrowserBridgeCheckState,
  browsers: Schema.Array(BrowserBridgeBrowser),
  /** Tabs in the agents' tab group; 0 when the group is empty. Absent when unreadable. */
  tabCount: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.String),
  checkedAt: Schema.String,
  durationMs: Schema.Number,
});
export type BrowserBridgeCheck = typeof BrowserBridgeCheck.Type;

/** How one provider reaches Chrome on this machine. */
export const BrowserBridgeProviderWiring = Schema.Struct({
  provider: Schema.Literals(["claude", "codex", "copilot", "gemini"]),
  route: Schema.Literals([
    /** Claude Code's own browser tools. */
    "built_in",
    /** An MCP entry that runs Claude Code's browser server, shared with Claude Code. */
    "shared_bridge",
    /** The provider's own Chrome extension (Codex). */
    "own_extension",
    /** Claude Code threads start without it: SpecWithCode Browser is paired and preferred. */
    "specwithcode_browser",
    "turned_off",
    "not_set_up",
    "not_installed",
  ]),
});
export type BrowserBridgeProviderWiring = typeof BrowserBridgeProviderWiring.Type;

export const BrowserBridgeStatus = Schema.Struct({
  platform: Schema.String,
  chrome: Schema.Struct({ installed: Schema.Boolean, running: Schema.Boolean }),
  extension: Schema.Struct({
    /** Chrome can launch Claude Code's native host for the extension. */
    nativeHostInstalled: Schema.Boolean,
    /** Extension pages talking to this machine right now (one per open Chrome profile). */
    liveConnections: Schema.Number,
    /** The name this machine's Chrome was given when it was last chosen for agents. */
    pairedBrowserName: Schema.NullOr(Schema.String),
  }),
  /** The Claude account Claude Code is signed in to; the extension must use the same one. */
  claudeAccount: Schema.NullOr(Schema.String),
  /** Chrome profile names, or null when macOS privacy settings hide them. */
  chromeProfiles: Schema.NullOr(Schema.Array(Schema.String)),
  providers: Schema.Array(BrowserBridgeProviderWiring),
  lastCheck: Schema.NullOr(BrowserBridgeCheck),
});
export type BrowserBridgeStatus = typeof BrowserBridgeStatus.Type;

export const browserBridgeRpcs = [
  Rpc.make(BROWSER_BRIDGE_RPC_METHODS.browserBridgeStatus, {
    payload: Schema.Struct({}),
    success: BrowserBridgeStatus,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(BROWSER_BRIDGE_RPC_METHODS.browserBridgeTest, {
    payload: Schema.Struct({}),
    success: BrowserBridgeCheck,
    error: EnvironmentAuthorizationError,
  }),
  /** Asks every Chrome with the extension to show Connect, and waits up to two minutes for a click. */
  Rpc.make(BROWSER_BRIDGE_RPC_METHODS.browserBridgeReconnect, {
    payload: Schema.Struct({}),
    success: BrowserBridgeCheck,
    error: EnvironmentAuthorizationError,
  }),
] as const;

import * as Schema from "effect/Schema";
import { Rpc } from "effect/rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";

/**
 * The SpecWithCode Browser extension: one install per Chrome profile, paired
 * with the SpecWithCode service on the same machine over a loopback
 * WebSocket. Agents of every provider reach the paired profiles through the
 * `chrome_*` tools on `studio-code`. Each machine reports only its own Chrome.
 */
export const BROWSER_EXTENSION_RPC_METHODS = {
  browserExtensionStatus: "browserExtension.status",
  browserExtensionPairing: "browserExtension.pairing",
  browserExtensionTest: "browserExtension.test",
  browserExtensionReconnect: "browserExtension.reconnect",
  browserExtensionStop: "browserExtension.stop",
  browserExtensionInstallFolder: "browserExtension.installFolder",
} as const;

/** Where agents' Chrome tools send people when no profile answers. */
export const BROWSER_EXTENSION_NOT_CONNECTED_MESSAGE =
  "The SpecWithCode Browser extension is not connected on this machine.";

export const BrowserExtensionLease = Schema.Struct({
  threadId: Schema.String,
  since: Schema.String,
  lastActionAt: Schema.String,
});
export type BrowserExtensionLease = typeof BrowserExtensionLease.Type;

/** One thread acting in a profile: threads share it, each in its own tabs. */
export const BrowserExtensionThreadUse = Schema.Struct({
  threadId: Schema.String,
  tabs: Schema.Number,
  since: Schema.String,
  lastActionAt: Schema.String,
});
export type BrowserExtensionThreadUse = typeof BrowserExtensionThreadUse.Type;

export const BrowserExtensionProfile = Schema.Struct({
  id: Schema.String,
  /** The name the user gave this Chrome profile when pairing. */
  label: Schema.String,
  extensionVersion: Schema.String,
  /** For example "Chrome 141". */
  browser: Schema.String,
  connectedAt: Schema.String,
  /** Tabs an agent is controlling right now. */
  attachedTabs: Schema.Number,
  /** The most recently active thread; kept for apps that predate `threads`. */
  lease: Schema.NullOr(BrowserExtensionLease),
  /** Every thread acting in this profile now, most recent first. */
  threads: Schema.optionalKey(Schema.Array(BrowserExtensionThreadUse)),
});
export type BrowserExtensionProfile = typeof BrowserExtensionProfile.Type;

export const BrowserExtensionAction = Schema.Struct({
  at: Schema.String,
  profile: Schema.String,
  threadId: Schema.String,
  tool: Schema.String,
  url: Schema.optionalKey(Schema.String),
});
export type BrowserExtensionAction = typeof BrowserExtensionAction.Type;

export const BrowserExtensionStatus = Schema.Struct({
  /** The loopback address the extension connects to. */
  relayUrl: Schema.String,
  /** The version the app ships for Load unpacked. */
  bundledVersion: Schema.String,
  /** The Chrome Web Store page, once the listing is public. */
  storeUrl: Schema.NullOr(Schema.String),
  profiles: Schema.Array(BrowserExtensionProfile),
  recentActions: Schema.Array(BrowserExtensionAction),
});
export type BrowserExtensionStatus = typeof BrowserExtensionStatus.Type;

export const BrowserExtensionPairing = Schema.Struct({
  pairingCode: Schema.String,
  relayUrl: Schema.String,
});
export type BrowserExtensionPairing = typeof BrowserExtensionPairing.Type;

export const BrowserExtensionProfileCheck = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  ok: Schema.Boolean,
  tabCount: Schema.optionalKey(Schema.Number),
  roundTripMs: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.String),
});
export type BrowserExtensionProfileCheck = typeof BrowserExtensionProfileCheck.Type;

export const BrowserExtensionCheck = Schema.Struct({
  state: Schema.Literals(["connected", "not_connected", "error"]),
  profiles: Schema.Array(BrowserExtensionProfileCheck),
  message: Schema.optionalKey(Schema.String),
  checkedAt: Schema.String,
});
export type BrowserExtensionCheck = typeof BrowserExtensionCheck.Type;

export const BrowserExtensionInstallFolder = Schema.Struct({
  path: Schema.String,
  version: Schema.String,
});
export type BrowserExtensionInstallFolder = typeof BrowserExtensionInstallFolder.Type;

export const browserExtensionRpcs = [
  Rpc.make(BROWSER_EXTENSION_RPC_METHODS.browserExtensionStatus, {
    payload: Schema.Struct({}),
    success: BrowserExtensionStatus,
    error: EnvironmentAuthorizationError,
  }),
  /** The pairing code is a secret; `reset` replaces it and disconnects every paired profile. */
  Rpc.make(BROWSER_EXTENSION_RPC_METHODS.browserExtensionPairing, {
    payload: Schema.Struct({ reset: Schema.optionalKey(Schema.Boolean) }),
    success: BrowserExtensionPairing,
    error: EnvironmentAuthorizationError,
  }),
  Rpc.make(BROWSER_EXTENSION_RPC_METHODS.browserExtensionTest, {
    payload: Schema.Struct({}),
    success: BrowserExtensionCheck,
    error: EnvironmentAuthorizationError,
  }),
  /** Asks every paired profile to reconnect, then checks them. */
  Rpc.make(BROWSER_EXTENSION_RPC_METHODS.browserExtensionReconnect, {
    payload: Schema.Struct({}),
    success: BrowserExtensionCheck,
    error: EnvironmentAuthorizationError,
  }),
  /** Lets go of one thread's tabs in a profile, or with no threadId of all of them. */
  Rpc.make(BROWSER_EXTENSION_RPC_METHODS.browserExtensionStop, {
    payload: Schema.Struct({
      profileId: Schema.String,
      threadId: Schema.optionalKey(Schema.String),
    }),
    success: BrowserExtensionStatus,
    error: EnvironmentAuthorizationError,
  }),
  /** Writes the bundled extension to a folder Chrome can Load unpacked. */
  Rpc.make(BROWSER_EXTENSION_RPC_METHODS.browserExtensionInstallFolder, {
    payload: Schema.Struct({}),
    success: BrowserExtensionInstallFolder,
    error: EnvironmentAuthorizationError,
  }),
] as const;

// ── MCP tools (`chrome_*` on studio-code) ───────────────────────────────────

export class BrowserExtensionToolError extends Schema.TaggedError<BrowserExtensionToolError>()(
  "BrowserExtensionToolError",
  {
    code: Schema.Literals([
      "not_connected",
      "choose_profile",
      "profile_not_found",
      "profile_in_use",
      "tab_in_use",
      "tab_not_found",
      "element_not_found",
      "page_error",
      "timeout",
      "invalid_request",
    ]),
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const ProfileParam = Schema.optional(
  Schema.String.annotate({
    description:
      "Chrome profile name from chrome_profiles. Omit when only one profile is connected.",
  }),
);
const TabParam = Schema.optional(
  Schema.Int.annotate({
    description:
      "Tab id from chrome_tabs or chrome_open. Omit to use the tab this thread used last in that profile.",
  }),
);
const RefParam = Schema.optional(
  Schema.String.annotate({ description: "Element ref from chrome_snapshot, such as e12." }),
);
const SelectorParam = Schema.optional(
  Schema.String.annotate({ description: "CSS selector, used when there is no ref." }),
);

export const ChromeProfilesInput = Schema.Struct({
  verbose: Schema.optional(
    Schema.Boolean.annotate({ description: "Unused; present so the input is an object." }),
  ),
});
export const ChromeProfilesResult = Schema.Struct({
  profiles: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      browser: Schema.String,
      agentTabs: Schema.Number,
      inUseByAnotherThread: Schema.Boolean,
    }),
  ),
  hint: Schema.String,
});

export const ChromeTabsInput = Schema.Struct({ profile: ProfileParam });
export const ChromeTabSummary = Schema.Struct({
  tabId: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  active: Schema.Boolean,
  /** Opened or used by an agent; sits in the SpecWithCode tab group. */
  agentTab: Schema.Boolean,
  /** This thread drives the tab. */
  thisThread: Schema.optional(Schema.Boolean),
  /** Another thread drives the tab; leave it alone and use chrome_open. */
  anotherThread: Schema.optional(Schema.Boolean),
});
export const ChromeTabsResult = Schema.Struct({
  profile: Schema.String,
  tabs: Schema.Array(ChromeTabSummary),
});

export const ChromeOpenInput = Schema.Struct({
  url: Schema.String.annotate({ description: "Absolute http(s) URL to open in a new tab." }),
  profile: ProfileParam,
});
export const ChromePageResult = Schema.Struct({
  profile: Schema.String,
  tabId: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  dialog: Schema.optional(Schema.String),
});

export const ChromeNavigateInput = Schema.Struct({
  url: Schema.optional(Schema.String.annotate({ description: "Absolute URL to load." })),
  action: Schema.optional(
    Schema.Literals(["back", "forward", "reload"]).annotate({
      description: "Instead of url: go back, forward or reload.",
    }),
  ),
  tabId: TabParam,
  profile: ProfileParam,
});

export const ChromeSnapshotInput = Schema.Struct({
  tabId: TabParam,
  profile: ProfileParam,
  maxTextChars: Schema.optional(
    Schema.Int.annotate({ description: "Visible text budget, 1000-60000. Defaults to 12000." }),
  ),
});
export const ChromeSnapshotElement = Schema.Struct({
  ref: Schema.String,
  role: Schema.String,
  name: Schema.String,
  href: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  checked: Schema.optional(Schema.Boolean),
  disabled: Schema.optional(Schema.Boolean),
});
export const ChromeSnapshotResult = Schema.Struct({
  profile: Schema.String,
  tabId: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  text: Schema.String,
  textTruncated: Schema.Boolean,
  elements: Schema.Array(ChromeSnapshotElement),
  dialog: Schema.optional(Schema.String),
});

export const ChromeClickInput = Schema.Struct({
  ref: RefParam,
  selector: SelectorParam,
  tabId: TabParam,
  profile: ProfileParam,
});

export const ChromeTypeInput = Schema.Struct({
  text: Schema.String.annotate({ description: "Text to type into the element." }),
  ref: RefParam,
  selector: SelectorParam,
  clear: Schema.optional(
    Schema.Boolean.annotate({ description: "Replace the current value. Defaults to true." }),
  ),
  submit: Schema.optional(
    Schema.Boolean.annotate({ description: "Press Enter afterwards. Defaults to false." }),
  ),
  tabId: TabParam,
  profile: ProfileParam,
});

export const ChromePressInput = Schema.Struct({
  key: Schema.String.annotate({
    description:
      "Key to press: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End, Space, or one character.",
  }),
  tabId: TabParam,
  profile: ProfileParam,
});

export const ChromeScreenshotInput = Schema.Struct({
  tabId: TabParam,
  profile: ProfileParam,
  fullPage: Schema.optional(
    Schema.Boolean.annotate({ description: "Capture the whole page, not just the viewport." }),
  ),
});
export const ChromeScreenshotResult = Schema.Struct({
  profile: Schema.String,
  tabId: Schema.Int,
  url: Schema.String,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});

export const ChromeEvaluateInput = Schema.Struct({
  expression: Schema.String.annotate({
    description:
      "JavaScript expression evaluated in the page; promises are awaited. The result must be JSON-serializable.",
  }),
  tabId: TabParam,
  profile: ProfileParam,
});
export const ChromeEvaluateResult = Schema.Struct({
  profile: Schema.String,
  tabId: Schema.Int,
  value: Schema.Unknown,
});

export const ChromeCloseInput = Schema.Struct({ tabId: TabParam, profile: ProfileParam });
export const ChromeCloseResult = Schema.Struct({ profile: Schema.String, closed: Schema.Int });

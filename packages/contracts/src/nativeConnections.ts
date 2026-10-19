import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

export const NativeConnectionProvider = Schema.Literals(["codex", "claude"]);
export const NativeConnectionSource = Schema.Struct({
  id: Schema.String,
  provider: NativeConnectionProvider,
  scope: Schema.Literals(["user", "project", "local"]),
  status: Schema.Literals(["read", "missing", "unreadable", "invalid", "too_large"]),
});
export const NativeConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: NativeConnectionProvider,
  sourceId: Schema.String,
  scope: Schema.Literals(["user", "project", "local"]),
  transport: Schema.Literals(["stdio", "http", "sse", "unknown"]),
  state: Schema.Literals(["configured", "disabled", "invalid"]),
  shadowed: Schema.Boolean,
  /** A user declaration the other tool can run as written: no relative paths or tool-only keys. */
  portable: Schema.optionalKey(Schema.Boolean),
  /** An enabled Codex plugin of the same name already provides this server. */
  pluginProvided: Schema.optionalKey(Schema.Boolean),
  /** Declared by this enabled plugin rather than by a configuration file. */
  plugin: Schema.optionalKey(Schema.String),
  /** Outside project context: the private project (folder name) that declares it. */
  project: Schema.optionalKey(Schema.String),
  /** Turned off by SpecWithCode: the tool has no off switch, so its entry is kept aside. */
  parked: Schema.optionalKey(Schema.Boolean),
});
export type NativeConnection = typeof NativeConnection.Type;
/** AI tools whose MCP declarations are listed read-only beside Codex and Claude Code. */
export const NativeOtherTool = Schema.Literals([
  "claude-desktop",
  "gemini",
  "copilot",
  "cursor",
  "opencode",
  "windsurf",
]);
export type NativeOtherTool = typeof NativeOtherTool.Type;
export const NativeOtherToolConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  transport: Schema.Literals(["stdio", "http", "sse", "unknown"]),
  state: Schema.Literals(["configured", "disabled", "invalid"]),
  parked: Schema.optionalKey(Schema.Boolean),
  /** A declaration every other tool can run as written. */
  portable: Schema.optionalKey(Schema.Boolean),
});
export const NativeOtherToolInventory = Schema.Struct({
  tool: NativeOtherTool,
  status: Schema.Literals(["read", "missing", "unreadable", "invalid", "too_large"]),
  connections: Schema.Array(NativeOtherToolConnection),
});
export type NativeOtherToolInventory = typeof NativeOtherToolInventory.Type;
/** Every tool whose user configuration the library can edit. */
export const NativeTool = Schema.Literals([
  "codex",
  "claude",
  "claude-desktop",
  "gemini",
  "copilot",
  "cursor",
  "opencode",
  "windsurf",
]);
export type NativeTool = typeof NativeTool.Type;
/** An installed Codex or Claude Code plugin, on or off. */
export const NativePlugin = Schema.Struct({
  provider: NativeConnectionProvider,
  key: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  /** A project or local settings file decides it, so the user toggle would not take effect. */
  overridden: Schema.optionalKey(Schema.Boolean),
  /** Installed by the user's ChatGPT account: Codex loads it whatever config.toml says. */
  account: Schema.optionalKey(Schema.Boolean),
  /** False when nothing SpecWithCode writes would change it, such as an account plugin without skills. */
  switchable: Schema.optionalKey(Schema.Boolean),
});
export type NativePlugin = typeof NativePlugin.Type;
/** One file a change writes, with the entries it adds or removes; values are masked. */
export const NativeConnectionChangeFile = Schema.Struct({
  tool: Schema.String,
  path: Schema.String,
  lines: Schema.Array(Schema.String),
});
export const NativeConnectionChange = Schema.Struct({
  /** Pass to `undo`; absent on a preview, which writes nothing. */
  id: Schema.optionalKey(Schema.String),
  preview: Schema.Boolean,
  files: Schema.Array(NativeConnectionChangeFile),
});
export type NativeConnectionChange = typeof NativeConnectionChange.Type;
export const NativeConnectionsInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type NativeConnectionsInput = typeof NativeConnectionsInput.Type;
export const NativeConnectionsSnapshot = Schema.Struct({
  observedAt: Schema.String,
  sources: Schema.Array(NativeConnectionSource),
  connections: Schema.Array(NativeConnection),
  truncated: Schema.Boolean,
  runtime: Schema.Literal("unverified"),
  /** Separate from `connections` so clients that predate it still decode the snapshot. */
  otherTools: Schema.optionalKey(Schema.Array(NativeOtherToolInventory)),
  plugins: Schema.optionalKey(Schema.Array(NativePlugin)),
  /** Set on an apply result: what was (or, for a preview, would be) written. */
  change: Schema.optionalKey(NativeConnectionChange),
});
export type NativeConnectionsSnapshot = typeof NativeConnectionsSnapshot.Type;
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
/** A server to add: a command with arguments and environment, or a URL with headers. */
export const NativeServerInput = Schema.Struct({
  command: Schema.optionalKey(Text(1000)),
  args: Schema.optionalKey(Schema.Array(Text(4000)).check(Schema.isMaxLength(64))),
  env: Schema.optionalKey(Schema.Record(Text(200), Text(8000))),
  url: Schema.optionalKey(Text(2000)),
  headers: Schema.optionalKey(Schema.Record(Text(200), Text(8000))),
});
export type NativeServerInput = typeof NativeServerInput.Type;
/**
 * Edit user-scope MCP declarations on the execution machine. Every action but
 * `undo` takes `preview` to report what it would write without writing.
 * - enable, disable, remove, copy (Codex and Claude Code to each other), copyAll: `connectionId`
 * - add: `name`, `tools`, `server`
 * - plugin: `provider`, `pluginKey`, `enabled`
 * - undo: `changeId` from an earlier result
 */
export const NativeConnectionApplyInput = Schema.Struct({
  action: Schema.Literals([
    "enable",
    "copy",
    "disable",
    "remove",
    "copyAll",
    "add",
    "plugin",
    "undo",
  ]),
  connectionId: Schema.optionalKey(Text(200)),
  preview: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Text(80)),
  tools: Schema.optionalKey(Schema.Array(NativeTool).check(Schema.isMaxLength(8))),
  server: Schema.optionalKey(NativeServerInput),
  provider: Schema.optionalKey(NativeConnectionProvider),
  pluginKey: Schema.optionalKey(Text(200)),
  enabled: Schema.optionalKey(Schema.Boolean),
  changeId: Schema.optionalKey(Text(80)),
});
export type NativeConnectionApplyInput = typeof NativeConnectionApplyInput.Type;
const NATIVE_CONNECTIONS_ERROR_MESSAGES = {
  project_not_found: "This project is no longer available on the selected machine.",
  unavailable: "Connection discovery is unavailable on this machine.",
  not_found: "That connection is no longer declared. Refresh configurations and retry.",
  not_portable:
    "This declaration only runs in the tool that declares it, for example because it uses a relative path.",
  exists: "The other tool already declares a connection with this name.",
  changed: "The configuration file changed while saving. Refresh configurations and retry.",
  write_failed: "The configuration file could not be updated. Edit it by hand instead.",
  invalid_input: "Check the name, command or URL and try again.",
  unsupported: "No selected tool can run this server, or the tool cannot change it from here.",
  undo_unavailable:
    "This change can no longer be undone: a file changed since, or the backup is gone.",
} as const;
export class NativeConnectionsError extends Schema.TaggedError<NativeConnectionsError>()(
  "NativeConnectionsError",
  {
    code: Schema.Literals([
      "project_not_found",
      "unavailable",
      "not_found",
      "not_portable",
      "exists",
      "changed",
      "write_failed",
      "invalid_input",
      "unsupported",
      "undo_unavailable",
    ]),
  },
) {
  override get message(): string {
    return NATIVE_CONNECTIONS_ERROR_MESSAGES[this.code];
  }
}

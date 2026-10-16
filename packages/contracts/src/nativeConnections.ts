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
});
export type NativeConnection = typeof NativeConnection.Type;
export const NativeConnectionsInput = Schema.Struct({ projectId: Schema.optional(ProjectId) });
export type NativeConnectionsInput = typeof NativeConnectionsInput.Type;
export const NativeConnectionsSnapshot = Schema.Struct({
  observedAt: Schema.String,
  sources: Schema.Array(NativeConnectionSource),
  connections: Schema.Array(NativeConnection),
  truncated: Schema.Boolean,
  runtime: Schema.Literal("unverified"),
});
export type NativeConnectionsSnapshot = typeof NativeConnectionsSnapshot.Type;
/**
 * Turn a disabled user declaration back on, or add one tool's user declaration
 * to the other tool's user configuration. Names a discovered connection only.
 */
export const NativeConnectionApplyInput = Schema.Struct({
  action: Schema.Literals(["enable", "copy"]),
  connectionId: Schema.String.check(Schema.isMaxLength(200)),
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
    ]),
  },
) {
  override get message(): string {
    return NATIVE_CONNECTIONS_ERROR_MESSAGES[this.code];
  }
}

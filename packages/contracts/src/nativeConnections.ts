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
export class NativeConnectionsError extends Schema.TaggedError<NativeConnectionsError>()(
  "NativeConnectionsError",
  { code: Schema.Literals(["project_not_found", "unavailable"]) },
) {
  override get message(): string {
    return this.code === "project_not_found"
      ? "This project is no longer available on the selected machine."
      : "Connection discovery is unavailable on this machine.";
  }
}

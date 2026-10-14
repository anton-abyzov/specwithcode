export * from "./nativeConnections.ts";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
export const ProjectConnectionConfig = Schema.Struct({
  name: Text,
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(2048))).check(Schema.isMaxLength(32)),
  /** Names of host environment variables, never their values. */
  envKeys: Schema.Array(Text).check(Schema.isMaxLength(24)),
});
export type ProjectConnectionConfig = typeof ProjectConnectionConfig.Type;
export const ProjectConnectionTool = Schema.Struct({
  name: Text,
  description: Schema.String.check(Schema.isMaxLength(4096)),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
});
export type ProjectConnectionTool = typeof ProjectConnectionTool.Type;
export const ProjectConnection = Schema.Struct({
  id: Text,
  ...ProjectConnectionConfig.fields,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.Literals(["configured", "ready", "unavailable", "revoked"]),
  checkedAt: Schema.NullOr(Schema.String),
  tools: Schema.Array(ProjectConnectionTool),
  allowedTools: Schema.Array(Text),
});
export type ProjectConnection = typeof ProjectConnection.Type;
export const ProjectConnectionsReadInput = Schema.Struct({ projectId: ProjectId });
export const ProjectConnectionsReadResult = Schema.Struct({
  connections: Schema.Array(ProjectConnection),
});
export const ProjectConnectionSaveInput = Schema.Struct({
  projectId: ProjectId,
  id: Text,
  expectedRevision: Schema.NullOr(Schema.Int),
  config: ProjectConnectionConfig,
  allowedTools: Schema.Array(Text).check(Schema.isMaxLength(200)),
});
export type ProjectConnectionSaveInput = typeof ProjectConnectionSaveInput.Type;
export const ProjectConnectionActionInput = Schema.Struct({
  projectId: ProjectId,
  id: Text,
  expectedRevision: Schema.Int,
});
export type ProjectConnectionActionInput = typeof ProjectConnectionActionInput.Type;
export const ProjectConnectionCallInput = Schema.Struct({
  ...ProjectConnectionActionInput.fields,
  tool: Text,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  commandId: CommandId,
});
export type ProjectConnectionCallInput = typeof ProjectConnectionCallInput.Type;
export const ProjectConnectionCallResult = Schema.Struct({
  isError: Schema.Boolean,
  /** External content is untrusted. No tool output can grant another capability. */
  content: Schema.String,
});
export type ProjectConnectionCallResult = typeof ProjectConnectionCallResult.Type;
export class ProjectConnectionError extends Schema.TaggedError<ProjectConnectionError>()(
  "ProjectConnectionError",
  {
    projectId: ProjectId,
    code: Schema.Literals([
      "not_found",
      "conflict",
      "invalid",
      "unavailable",
      "denied",
      "changed",
      "outcome_unknown",
      "operation_failed",
    ]),
  },
) {
  override get message(): string {
    return {
      not_found: "This project or connection no longer exists.",
      conflict: "Connection settings changed. Reload before continuing.",
      invalid:
        "Check the executable, arguments and environment variable names. Store credentials only on the execution device.",
      unavailable:
        "The connection is unavailable. Check the tool installation and sign-in on this project's device, then check again.",
      denied:
        "This tool has not been allowed for this project, or the project is paused or archived.",
      changed:
        "The connection's tool definition changed. Check the connection and review its allowed tools again.",
      outcome_unknown:
        "The earlier call may have run. Check its result in the connected service before submitting a new request.",
      operation_failed: "The connection operation failed. Reload to check its saved state.",
    }[this.code];
  }
}

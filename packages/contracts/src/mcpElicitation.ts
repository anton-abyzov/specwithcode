import * as Schema from "effect/Schema";

/**
 * What an MCP server asked for in an `mcp-elicitation` request, carried on its
 * `approval_request` turn item so a client can draw the form. Absent on
 * requests whose provider gives no form (today's Codex approvals), which keep
 * the generic approval card.
 */
export const OrchestrationV2McpElicitation = Schema.Struct({
  /** The MCP server that asked, as the thread's configuration names it. */
  serverName: Schema.String,
  mode: Schema.Literals(["form", "url"]),
  message: Schema.String,
  /** The form's JSON Schema (form mode only); see `@specweave-studio/shared/mcpElicitationForm`. */
  requestedSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type OrchestrationV2McpElicitation = typeof OrchestrationV2McpElicitation.Type;

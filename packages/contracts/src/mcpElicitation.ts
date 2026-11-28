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
  /** The link to open, exactly as the server sent it (URL mode only); see `@specweave-studio/shared/mcpElicitationUrl`. */
  url: Schema.optional(Schema.String),
});
export type OrchestrationV2McpElicitation = typeof OrchestrationV2McpElicitation.Type;

/**
 * The answer a URL card's "I'm done, continue" sends with its `accept`. Only
 * that card sends it, so an accept without it (Full access, an automatic
 * responder, an agent) is refused (1498).
 */
export const MCP_ELICITATION_URL_DONE_ANSWER = { linkDone: true } as const;

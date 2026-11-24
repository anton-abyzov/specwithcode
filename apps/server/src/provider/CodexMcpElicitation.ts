import type { ProviderApprovalDecision, ProviderApprovalOption } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "@specweave-studio/effect-codex-app-server/schema";

/** The name SpecWithCode's MCP server is attached under in every Codex thread. */
const STUDIO_MCP_SERVER_NAME = "studio-code";

const NullableMcpElicitationString = Schema.NullOr(Schema.String);
const McpElicitationMetadata = Schema.Struct({
  app: Schema.optionalKey(NullableMcpElicitationString),
  app_name: Schema.optionalKey(NullableMcpElicitationString),
  appName: Schema.optionalKey(NullableMcpElicitationString),
  connector_name: Schema.optionalKey(NullableMcpElicitationString),
  connectorName: Schema.optionalKey(NullableMcpElicitationString),
  allowPersistentApproval: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  persist: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
  target: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
  tool_params: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        app_name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
});
const McpElicitationFormField = Schema.Struct({
  type: Schema.optionalKey(NullableMcpElicitationString),
  title: Schema.optionalKey(NullableMcpElicitationString),
  description: Schema.optionalKey(NullableMcpElicitationString),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          const: Schema.String,
          title: Schema.optionalKey(NullableMcpElicitationString),
        }),
      ),
    ),
  ),
});
const McpElicitationForm = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, McpElicitationFormField)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const isMcpElicitationMetadata = Schema.is(McpElicitationMetadata);
const isMcpElicitationForm = Schema.is(McpElicitationForm);

type McpElicitationPersistenceDecision = Extract<
  ProviderApprovalDecision,
  "acceptForSession" | "acceptAlways"
>;

function mcpElicitationPersistenceDecision(
  value: string,
): McpElicitationPersistenceDecision | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (
    normalized.includes("always") ||
    normalized.includes("permanent") ||
    normalized.includes("forever") ||
    normalized.includes("persistent")
  ) {
    return "acceptAlways";
  }
  return null;
}

function mcpElicitationFormFields(payload: EffectCodexSchema.McpServerElicitationRequestParams) {
  if (payload.mode === "url" || !isMcpElicitationForm(payload.requestedSchema)) {
    return undefined;
  }
  return payload.requestedSchema;
}

function mcpElicitationFieldOptions(field: typeof McpElicitationFormField.Type) {
  if (field.oneOf) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index],
  }));
}

function isMcpElicitationPersistenceField(
  key: string,
  field: typeof McpElicitationFormField.Type,
): boolean {
  return (
    mcpElicitationPersistenceDecision(key) !== null ||
    key.toLowerCase() === "persist" ||
    mcpElicitationPersistenceDecision(field.title ?? "") !== null ||
    mcpElicitationPersistenceDecision(field.description ?? "") !== null
  );
}

/** Returns the app and approval choices advertised by an MCP elicitation. */
export function describeMcpElicitation(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
): { readonly appName: string; readonly options: ReadonlyArray<ProviderApprovalOption> } {
  const metadata = isMcpElicitationMetadata(payload._meta) ? payload._meta : undefined;
  const appName =
    metadata?.app_name ??
    metadata?.appName ??
    metadata?.app ??
    metadata?.target?.app ??
    metadata?.target?.name ??
    metadata?.tool_params?.app_name ??
    metadata?.tool_params?.app ??
    payload.message.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1] ??
    metadata?.connector_name ??
    metadata?.connectorName ??
    payload.serverName;
  const persistenceOptions = new Map<McpElicitationPersistenceDecision, string>();
  const persist = metadata?.persist;
  for (const value of typeof persist === "string" ? [persist] : (persist ?? [])) {
    const decision = mcpElicitationPersistenceDecision(value);
    if (decision) persistenceOptions.set(decision, "");
  }
  if (metadata?.allowPersistentApproval) {
    persistenceOptions.set("acceptAlways", "");
  }

  const form = mcpElicitationFormFields(payload);
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    for (const option of mcpElicitationFieldOptions(field)) {
      const decision = mcpElicitationPersistenceDecision(option.value);
      if (decision) persistenceOptions.set(decision, option.label ?? "");
    }
    if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      persistenceOptions.set("acceptAlways", field.title ?? "");
    }
  }

  return {
    appName,
    options: [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      ...(persistenceOptions.has("acceptForSession") &&
      toMcpElicitationResponse(payload, "acceptForSession").action === "accept"
        ? [
            {
              decision: "acceptForSession" as const,
              label: persistenceOptions.get("acceptForSession") || "Always allow this session",
            },
          ]
        : []),
      ...(persistenceOptions.has("acceptAlways") &&
      toMcpElicitationResponse(payload, "acceptAlways").action === "accept"
        ? [
            {
              decision: "acceptAlways" as const,
              label: persistenceOptions.get("acceptAlways") || "Always allow",
            },
          ]
        : []),
      { decision: "accept", label: "Approve" },
    ],
  };
}

/** Converts a Studio approval decision into the MCP elicitation wire response. */
export function toMcpElicitationResponse(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
  decision: ProviderApprovalDecision,
): EffectCodexSchema.McpServerElicitationRequestResponse {
  if (decision === "decline" || decision === "cancel") {
    return { action: decision };
  }

  if (payload.mode === "url") {
    return { action: "decline" };
  }

  const persist =
    decision === "acceptForSession"
      ? "session"
      : decision === "acceptAlways"
        ? "always"
        : undefined;
  const form = mcpElicitationFormFields(payload);
  const content: Record<string, Schema.Json> = {};

  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const options = mcpElicitationFieldOptions(field);
    const chosenOption = options.find((option) =>
      persist
        ? mcpElicitationPersistenceDecision(option.value) === decision
        : /once|accept|approve|allow/i.test(option.value) &&
          mcpElicitationPersistenceDecision(option.value) === null,
    );
    if (chosenOption) {
      content[key] = chosenOption.value;
    } else if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      content[key] = decision === "acceptAlways";
    } else if (field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }

  if (form?.required?.some((key) => !Object.hasOwn(content, key))) {
    return { action: "decline" };
  }

  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}

/**
 * Codex asks before each call to an MCP tool that is not marked read-only,
 * SpecWithCode's own studio-code tools included (delegate_task, for one).
 * Claude pre-approves every studio-code tool in every mode, so a Codex thread
 * runs them without a card too. The studio-code endpoint still checks each
 * call's scope and grants, and refuses an advisor's changing tools.
 * Returns the response to send, or undefined to show the person the request.
 */
export function studioMcpToolApprovalAutoResponse(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
): EffectCodexSchema.McpServerElicitationRequestResponse | undefined {
  if (payload.serverName !== STUDIO_MCP_SERVER_NAME || payload.mode === "url") return undefined;
  const meta: unknown = payload._meta;
  const kind =
    typeof meta === "object" && meta !== null && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)["codex_approval_kind"]
      : undefined;
  if (kind !== "mcp_tool_call") return undefined;
  const response = toMcpElicitationResponse(payload, "accept");
  return response.action === "accept" ? response : undefined;
}

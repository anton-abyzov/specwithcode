import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

/** No commands, paths, environment values or credentials are accepted here. */
const ToolId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,160}$/));
const BinaryName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,79}$/));
export const WorkflowRequirements = Schema.Struct({
  tools: Schema.optionalKey(Schema.Array(ToolId).check(Schema.isMaxLength(64))),
  binaries: Schema.optionalKey(Schema.Array(BinaryName).check(Schema.isMaxLength(32))),
  platforms: Schema.optionalKey(
    Schema.Array(Schema.Literals(["darwin", "linux", "win32"])).check(Schema.isMaxLength(3)),
  ),
});
export type WorkflowRequirements = typeof WorkflowRequirements.Type;
export const WorkflowDeclaration = Schema.Union([
  Schema.Struct({ state: Schema.Literal("undeclared") }),
  Schema.Struct({ state: Schema.Literal("invalid"), reason: Schema.String }),
  Schema.Struct({ state: Schema.Literal("declared"), requires: WorkflowRequirements }),
]);
export type WorkflowDeclaration = typeof WorkflowDeclaration.Type;
export const CapabilityState = Schema.Literals([
  "available",
  "missing",
  "denied",
  "unsupported",
  "stale",
  "error",
  "unknown",
]);
export type CapabilityState = typeof CapabilityState.Type;
export const WorkflowCapabilityScope = Schema.Struct({
  environmentId: Schema.NullOr(Schema.String),
  instanceId: Schema.String,
  workspaceRoot: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  providerThreadId: Schema.NullOr(Schema.String),
  nativeThreadId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
});
export type WorkflowCapabilityScope = typeof WorkflowCapabilityScope.Type;
export const RuntimeToolInventory = Schema.Struct({
  scope: WorkflowCapabilityScope,
  observedAt: Schema.String,
  /** Whole native tool inventory, including built-ins; false for MCP-only or lazy discovery. */
  complete: Schema.Boolean,
  state: CapabilityState,
  source: Schema.String,
  tools: Schema.Array(Schema.String),
  /** Only server names and public states. Never raw SDK errors, URLs or auth material. */
  servers: Schema.Array(Schema.Struct({ name: Schema.String, state: CapabilityState })),
});
export type RuntimeToolInventory = typeof RuntimeToolInventory.Type;
export const WorkflowEvidence = Schema.Struct({
  state: CapabilityState,
  observedAt: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
export const WorkflowDependencyCheck = Schema.Struct({
  kind: Schema.Literals(["tool", "binary", "platform", "declaration"]),
  id: Schema.String,
  state: CapabilityState,
  stage: Schema.Literals(["configured", "discovered", "registered", "checked"]),
  observedAt: Schema.NullOr(Schema.String),
  reason: Schema.String,
});
export type WorkflowDependencyCheck = typeof WorkflowDependencyCheck.Type;
export const WorkflowPreflight = Schema.Struct({
  scope: WorkflowCapabilityScope,
  status: Schema.Literals(["ready", "blocked", "unknown"]),
  checkedAt: Schema.String,
  declaration: WorkflowDeclaration,
  configured: WorkflowEvidence,
  discovered: WorkflowEvidence,
  registered: WorkflowEvidence,
  checked: WorkflowEvidence,
  checks: Schema.Array(WorkflowDependencyCheck),
});
export type WorkflowPreflight = typeof WorkflowPreflight.Type;

export const WORKFLOW_INVENTORY_TTL_MS = 60_000;
/** An old observation never proves current absence or readiness. */
export function inventoryIsFresh(inventory: RuntimeToolInventory, now: number): boolean {
  const at = Date.parse(inventory.observedAt);
  return Number.isFinite(at) && at <= now && now - at < WORKFLOW_INVENTORY_TTL_MS;
}

/** Deterministic evaluation; the caller supplies facts from the execution host. */
export function evaluateWorkflow(input: {
  scope: WorkflowCapabilityScope;
  declaration: WorkflowDeclaration;
  enabled: boolean;
  discoveredAt: string;
  now: number;
  platform: string;
  binaries: ReadonlyMap<string, CapabilityState>;
  inventory?: RuntimeToolInventory | undefined;
}): WorkflowPreflight {
  const at = DateTime.formatIso(DateTime.makeUnsafe(input.now));
  const evidence = (state: CapabilityState, reason: string, observedAt: string | null = at) => ({
    state,
    reason,
    observedAt,
  });
  const declaration = input.declaration;
  const inventory =
    input.inventory &&
    Object.keys(input.scope).every(
      (key) =>
        input.scope[key as keyof WorkflowCapabilityScope] ===
        input.inventory!.scope[key as keyof WorkflowCapabilityScope],
    )
      ? input.inventory
      : undefined;
  const fresh = inventory !== undefined && inventoryIsFresh(inventory, input.now);
  const registered =
    inventory === undefined
      ? evidence("unknown", "No tool inventory for this live session.", null)
      : !fresh
        ? evidence("stale", "The session tool inventory needs refreshing.", inventory.observedAt)
        : evidence(
            inventory.state,
            `Native tool inventory: ${inventory.source}. Service authentication is not checked.`,
            inventory.observedAt,
          );
  const checks: WorkflowDependencyCheck[] = [];
  const add = (
    kind: WorkflowDependencyCheck["kind"],
    id: string,
    state: CapabilityState,
    stage: WorkflowDependencyCheck["stage"],
    reason: string,
    observedAt: string | null = at,
  ) => checks.push({ kind, id, state, stage, reason, observedAt });
  if (!input.enabled)
    add(
      "declaration",
      "skill",
      "denied",
      "configured",
      "This skill is disabled for the selected provider.",
    );
  if (declaration.state === "invalid")
    add("declaration", "requires", "error", "configured", declaration.reason);
  if (declaration.state === "declared") {
    const requires = declaration.requires;
    if (requires.platforms?.length)
      add(
        "platform",
        input.platform,
        requires.platforms.includes(input.platform as "darwin") ? "available" : "unsupported",
        "checked",
        requires.platforms.includes(input.platform as "darwin")
          ? "The execution host platform is supported."
          : `Requires ${requires.platforms.join(" or ")}; this host is ${input.platform}.`,
      );
    for (const name of requires.binaries ?? []) {
      const state = input.binaries.get(name) ?? "unknown";
      add(
        "binary",
        name,
        state,
        "checked",
        state === "available"
          ? "Executable found on the execution PATH; no command was run."
          : state === "missing"
            ? "Executable not found on the execution PATH. Install it on this machine."
            : "Executable access could not be established on this machine.",
      );
    }
    for (const name of requires.tools ?? []) {
      const state = !inventory
        ? "unknown"
        : !fresh
          ? "stale"
          : inventory.tools.includes(name)
            ? "available"
            : (inventory.servers.find(
                (server) =>
                  name.startsWith(`mcp__${server.name}__`) && server.state !== "available",
              )?.state ??
              (inventory.state !== "available"
                ? "unknown"
                : inventory.complete
                  ? "missing"
                  : "unknown"));
      add(
        "tool",
        name,
        state,
        "registered",
        state === "available"
          ? "Registered in this session. Service authentication and action permissions remain unchecked."
          : state === "missing"
            ? "Not registered in this session. Configure the tool for this provider on this machine."
            : state === "stale"
              ? "Session inventory is stale; refresh before relying on it."
              : "The session has not established this tool's availability.",
        inventory?.observedAt ?? null,
      );
    }
  }
  const blocked = checks.some((check) =>
    ["missing", "denied", "unsupported", "error"].includes(check.state),
  );
  const unknown =
    declaration.state === "undeclared" || checks.some((check) => check.state !== "available");
  return {
    scope: input.scope,
    declaration,
    checkedAt: at,
    status: blocked ? "blocked" : unknown ? "unknown" : "ready",
    configured: evidence(
      declaration.state === "invalid" ? "error" : input.enabled ? "available" : "denied",
      "Configuration is separate from runtime capability.",
    ),
    discovered: evidence(
      "available",
      "Provider discovery found the skill. Its full instructions may not have loaded.",
      input.discoveredAt,
    ),
    registered,
    checked: evidence(
      blocked ? "error" : unknown ? "unknown" : "available",
      declaration.state === "undeclared"
        ? "This skill declares no dependencies; workflow readiness is unknown."
        : "Local dependency checks only. External service access has not been tested.",
    ),
    checks,
  };
}

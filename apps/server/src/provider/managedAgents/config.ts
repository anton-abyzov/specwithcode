import * as Schema from "effect/Schema";
import { ResponseStyle } from "@specweave-studio/contracts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";

export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

const ConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  environmentId: Schema.String,
  model: Schema.String,
  maxCostCents: Schema.String,
  timeoutSeconds: Schema.Number,
  globalInstructions: Schema.optionalKey(Schema.String),
  projectInstructions: Schema.optionalKey(Schema.String),
  responseStyle: Schema.optionalKey(ResponseStyle),
});
export type ManagedAgentsConfig = typeof ConfigSchema.Type;

export class ManagedAgentsConfigurationError extends Schema.TaggedError<ManagedAgentsConfigurationError>()(
  "ManagedAgentsConfigurationError",
  { field: Schema.String },
) {
  override get message(): string {
    return `Invalid Managed Agents beta configuration: ${this.field}.`;
  }
}

const decodeConfig = Schema.decodeUnknownSync(ConfigSchema);
export function parseManagedAgentsConfig(input: unknown): ManagedAgentsConfig {
  let config: ManagedAgentsConfig;
  try {
    config = decodeConfig(input);
  } catch {
    throw new ManagedAgentsConfigurationError({ field: "required fields" });
  }
  if (!/^env_[A-Za-z0-9]+$/.test(config.environmentId))
    throw new ManagedAgentsConfigurationError({ field: "environmentId" });
  if (!/^claude-[A-Za-z0-9.-]+$/.test(config.model))
    throw new ManagedAgentsConfigurationError({ field: "model" });
  if (!/^[1-9][0-9]*$/.test(config.maxCostCents) || BigInt(config.maxCostCents) > 10_000n)
    throw new ManagedAgentsConfigurationError({ field: "maxCostCents (1–10000 whole US cents)" });
  if (
    !Number.isInteger(config.timeoutSeconds) ||
    config.timeoutSeconds < 1 ||
    config.timeoutSeconds > 3600
  )
    throw new ManagedAgentsConfigurationError({ field: "timeoutSeconds (1–3600)" });
  if (
    (config.globalInstructions?.length ?? 0) > 16_000 ||
    (config.projectInstructions?.length ?? 0) > 16_000
  )
    throw new ManagedAgentsConfigurationError({
      field: "instructions (maximum 16000 characters per scope)",
    });
  return config;
}

/** Both the lead and every allowed worker receive these rules as their system. */
export function buildManagedAgentsSystem(
  sharedInstructions: string,
  responseStyle?: ResponseStyle | undefined,
): string {
  return [
    buildRuntimeInstructions({ harness: "Claude Managed Agents beta", responseStyle }),
    "Work only on the supplied text task. Do not assume local Claude Code settings, subscription authentication, local repositories, or Studio MCP tools are available. Use only predefined workflow workers; never define an inline worker. Every worker receives the same Studio and project rules. Keep the workflow small, use at most four worker calls, and report uncovered or failed work explicitly. A completed workflow is execution evidence, not proof that its answer is correct.",
    "When working in a worker thread, call studio_report_result with your complete plain-text answer before returning your workflow result. Include all answer markers required by your instructions; the response style's 5-line cap does not apply to this answer. This tool only records your answer for the Studio receipt; it performs no external action. After it acknowledges the report, return the same answer to the workflow.",
    sharedInstructions.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

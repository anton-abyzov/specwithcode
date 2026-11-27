/**
 * Who the SpecWeave ledger tools write as (1497).
 *
 * SpecWeave records a ledger event's `by` as `SPECWEAVE_AGENT`, else
 * `<SPECWEAVE_TOOL>@<host>`. Every thread's own process gets `SPECWEAVE_TOOL`
 * and `SPECWEAVE_STUDIO_THREAD_ID` from `specweaveAgentEnvironment`, so the
 * tools write with the same variables: a claim made here is then the agent's
 * own when it runs `specweave task done` in its shell. The slug follows what
 * each adapter passes; a provider whose slug is not known here gets null, and
 * the tools refuse rather than write as somebody else.
 */
import {
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
  type ServerSettings,
} from "@specweave-studio/contracts";

import { specweaveToolForAcpAgent } from "../../../orchestration-v2/Adapters/AcpRegistryAdapterV2.ts";
import { specweaveAgentEnvironment } from "../../../provider/RuntimeInstructions.ts";

/** Drivers whose adapters pass a fixed slug (ClaudeAdapterV2, CodexAdapterV2, OpenCodeAdapterV2, PiAdapterV2). */
const FIXED_SLUGS: ReadonlyMap<string, string> = new Map([
  [ProviderDriverKind.make("claudeAgent"), "claude"],
  [ProviderDriverKind.make("codex"), "codex"],
  [ProviderDriverKind.make("opencode"), "opencode"],
  [ProviderDriverKind.make("pi"), "pi"],
]);

const ACP_REGISTRY = ProviderDriverKind.make("acpRegistry");

/**
 * The SpecWeave tool slug a provider instance's threads run with, or null.
 * An instance with no settings entry is a built-in one whose id is its driver.
 */
export function specweaveToolForInstance(
  settings: Pick<ServerSettings, "providerInstances">,
  instanceId: ProviderInstanceId,
): string | null {
  const entry = settings.providerInstances[instanceId];
  const driver = entry?.driver ?? (instanceId as string);
  const fixed = FIXED_SLUGS.get(driver);
  if (fixed !== undefined) return fixed;
  if (driver !== ACP_REGISTRY) return null;
  const config = entry?.config;
  if (config === null || typeof config !== "object") return null;
  const { source, agentId } = config as { readonly source?: unknown; readonly agentId?: unknown };
  // A local install runs with an empty slug, so SpecWeave guesses; do not guess here.
  if (source === "local" || typeof agentId !== "string") return null;
  return specweaveToolForAcpAgent(agentId) || null;
}

/**
 * SpecWeave identity variables a provider instance can set for its own
 * processes (Settings > Providers > environment). The thread's shell gets them
 * on top of the server's environment, so the write must get them too.
 */
const IDENTITY_OVERRIDES: ReadonlySet<string> = new Set(["SPECWEAVE_AGENT", "SPECWEAVE_HOST"]);

/**
 * The variables a ledger write runs with: the caller's own thread and tool,
 * any SpecWeave identity its provider instance sets, an unknown model, and no
 * session id, so the CLI records no session marker for a session the server
 * does not have. The rest comes from the server's environment, which the
 * thread's own processes inherit too.
 */
export function ledgerWriteEnvironment(input: {
  readonly threadId: string;
  readonly tool: string;
  readonly instanceEnvironment?: ProviderInstanceEnvironment | undefined;
}): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const variable of input.instanceEnvironment ?? []) {
    if (IDENTITY_OVERRIDES.has(variable.name)) overrides[variable.name] = variable.value;
  }
  return {
    ...specweaveAgentEnvironment({ threadId: input.threadId, tool: input.tool }),
    ...overrides,
    SPECWEAVE_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_SESSION_ID: "",
  };
}

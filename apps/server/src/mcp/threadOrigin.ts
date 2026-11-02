import type {
  OrchestratorMcpOriginHint,
  OrchestrationV2ThreadOrigin,
  TeamRulesCarried,
} from "@specweave-studio/contracts";
import { teamRulesArrivingCarried } from "@specweave-studio/shared/teamRules";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import type { WorkGrantContext } from "./workGrantAccess.ts";

/** The app that sends fleet work between machines, as the badge names it. */
export const FLEET_ORIGIN_APP_LABEL = "SpecWithCode";

const MAX_LABEL_LENGTH = 80;

const cleanLabel = (value: string | undefined): string | undefined => {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  return trimmed.length > MAX_LABEL_LENGTH
    ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`
    : trimmed;
};

/**
 * Where a thread an MCP launch creates came from, for its header badge.
 * Another machine's fleet work wins, since its own client is only the grant's
 * transport; otherwise an outside client (OAuth or a static token) names
 * itself. A launch by a thread on this machine, or by this machine's own
 * user, records nothing.
 *
 * The sending machine's `originHint` (the client that asked there, or the
 * thread that started it) is display text only, taken only from that
 * machine's own call and cleaned like any label; the machine shown is always
 * the grant's.
 *
 * A carried ceiling follows the work: from the calling thread on this machine,
 * or from the sending machine's own call. A thread with no grant of its own
 * keeps it through its children, and a caller on this machine never sets it.
 */
export const launchOriginOf = (
  context: {
    readonly scope: Pick<McpInvocationScope, "client"> &
      Partial<Pick<McpInvocationScope, "environmentId">>;
    /** The calling thread on this machine, if any. */
    readonly caller: { readonly origin?: OrchestrationV2ThreadOrigin | undefined } | undefined;
  },
  work: Pick<WorkGrantContext, "origin" | "coordinatorLabel"> | undefined,
  originHint?: OrchestratorMcpOriginHint | undefined,
  delegated?: TeamRulesCarried | undefined,
): OrchestrationV2ThreadOrigin | undefined => {
  const inherited = context.caller?.origin?.carried;
  const carried =
    context.caller !== undefined
      ? inherited
      : work?.origin === undefined || context.scope.environmentId === undefined
        ? undefined
        : teamRulesArrivingCarried(delegated, context.scope.environmentId);
  if (work?.origin !== undefined) {
    const machineLabel = cleanLabel(work.coordinatorLabel);
    const hint = context.caller === undefined ? originHint : undefined;
    const environmentId = work.origin.coordinatorEnvironmentId;
    return {
      kind: "fleet_machine",
      label: cleanLabel(hint?.clientLabel) ?? FLEET_ORIGIN_APP_LABEL,
      ...(machineLabel === undefined ? {} : { machineLabel }),
      environmentId,
      ...(hint?.parentThreadId === undefined
        ? {}
        : { parentThreadRef: { environmentId, threadId: hint.parentThreadId } }),
      ...(carried === undefined ? {} : { carried }),
    };
  }
  if (context.caller !== undefined)
    return carried === undefined ? undefined : context.caller.origin;
  const label = cleanLabel(context.scope.client?.label);
  return label === undefined ? undefined : { kind: "mcp_client", label };
};

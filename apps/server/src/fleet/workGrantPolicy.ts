import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import {
  type AuthPrincipal,
  EnvironmentId,
  ORCHESTRATOR_MCP_DELEGATION_MAX_PATH,
  type OrchestratorMcpDelegation,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  type StudioWorkGrantAccounts,
  type StudioWorkGrantOwner,
  type StudioWorkGrantProjects,
  workGrantHopLimit,
} from "@specweave-studio/contracts/studioFleet";

/**
 * The rules a machine applies to work another machine starts on it. Pure, so
 * the worker's checks and the coordinator's pre-checks agree.
 */

/** The label a worker grant is minted under; the rest names the coordinator's environment. */
export const WORKER_CLIENT_LABEL_PREFIX = "SpecWithCode workers · ";

/** The coordinator a worker grant's client label names, or undefined for any other client. */
export function coordinatorOfWorkerLabel(label: string | undefined): EnvironmentId | undefined {
  if (label === undefined || !label.startsWith(WORKER_CLIENT_LABEL_PREFIX)) return undefined;
  const id = label.slice(WORKER_CLIENT_LABEL_PREFIX.length).trim();
  return id.length === 0 ? undefined : EnvironmentId.make(id);
}

export const coordinatorOfPrincipal = (principal: AuthPrincipal | undefined) =>
  principal?.kind === "coordinator" ? principal.environmentId : undefined;

/** Where a thread's work came from: the machines its launch came through. */
export interface WorkOrigin {
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly path: ReadonlyArray<EnvironmentId>;
  readonly hops: number;
}

/** What a grant allows, after defaults: the worker machine's own decision. */
export interface EffectiveWorkGrant {
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly projects: StudioWorkGrantProjects;
  readonly accounts: StudioWorkGrantAccounts;
  readonly owner: StudioWorkGrantOwner;
  readonly hopLimit: number;
  readonly revoked: boolean;
}

/** A grant from before scopes existed, and the fallback when no policy is kept. */
export const unscopedGrant = (coordinatorEnvironmentId: EnvironmentId): EffectiveWorkGrant => ({
  coordinatorEnvironmentId,
  projects: { kind: "all" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: workGrantHopLimit("self"),
  revoked: false,
});

/** A coordinator's first grant: its linked projects; another person's gets no sign-ins. */
export const newGrantDefaults = (owner: StudioWorkGrantOwner) => ({
  projects: { kind: "linked" } as StudioWorkGrantProjects,
  accounts: (owner === "self" ? { kind: "all" } : { kind: "none" }) as StudioWorkGrantAccounts,
  owner,
});

/** Names each machine on a path, by label where this machine knows one. */
export function describeDelegationPath(
  path: ReadonlyArray<string>,
  labels: ReadonlyMap<string, string>,
): string {
  return path.map((id) => labels.get(id) ?? id).join(" → ");
}

export type DelegationCheck =
  | { readonly ok: true; readonly origin: WorkOrigin }
  | {
      readonly ok: false;
      readonly code: "delegation_cycle" | "delegation_limit";
      readonly path: ReadonlyArray<EnvironmentId>;
      readonly hops: number;
      readonly limit: number;
    };

/**
 * The receiving machine's check. The path always ends with the machine whose
 * grant sent it, whatever the sender claimed; a sender too old to send a
 * path made one hop from itself.
 */
export function checkIncomingDelegation(input: {
  readonly ownEnvironmentId: EnvironmentId;
  readonly coordinatorEnvironmentId: EnvironmentId;
  readonly delegation: OrchestratorMcpDelegation | undefined;
  readonly hopLimit: number;
}): DelegationCheck {
  const claimed = input.delegation?.path ?? [];
  const path =
    claimed.at(-1) === input.coordinatorEnvironmentId
      ? [...claimed]
      : [...claimed, input.coordinatorEnvironmentId];
  const hops = Math.max(input.delegation?.hops ?? 1, path.length);
  if (path.includes(input.ownEnvironmentId))
    return { ok: false, code: "delegation_cycle", path, hops, limit: input.hopLimit };
  if (hops > input.hopLimit)
    return { ok: false, code: "delegation_limit", path, hops, limit: input.hopLimit };
  return {
    ok: true,
    origin: { coordinatorEnvironmentId: input.coordinatorEnvironmentId, path, hops },
  };
}

/**
 * What a launch from here to `targetEnvironmentId` carries: this thread's own
 * origin path with this machine added. Refused here already when the target
 * is on the path, so even a machine too old to check never sees the loop.
 */
export function outgoingDelegation(input: {
  readonly localEnvironmentId: EnvironmentId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly origin: WorkOrigin | undefined;
}):
  | { readonly ok: true; readonly delegation: OrchestratorMcpDelegation }
  | {
      readonly ok: false;
      readonly code: "delegation_cycle" | "delegation_limit";
      readonly path: ReadonlyArray<EnvironmentId>;
    } {
  const path = [...(input.origin?.path ?? []), input.localEnvironmentId];
  const hops = (input.origin?.hops ?? 0) + 1;
  if (path.includes(input.targetEnvironmentId))
    return { ok: false, code: "delegation_cycle", path: [...path, input.targetEnvironmentId] };
  if (
    path.length > ORCHESTRATOR_MCP_DELEGATION_MAX_PATH ||
    hops > ORCHESTRATOR_MCP_DELEGATION_MAX_PATH
  )
    return { ok: false, code: "delegation_limit", path };
  return { ok: true, delegation: { path, hops } };
}

/** The message a refused launch carries, naming the path. */
export function delegationRefusal(
  refusal: {
    readonly code: "delegation_cycle" | "delegation_limit";
    readonly path: ReadonlyArray<string>;
    readonly hops?: number;
    readonly limit?: number;
  },
  labels: ReadonlyMap<string, string>,
  ownEnvironmentId?: string,
): string {
  const path = describeDelegationPath(
    ownEnvironmentId === undefined || refusal.path.at(-1) === ownEnvironmentId
      ? refusal.path
      : [...refusal.path, ownEnvironmentId],
    labels,
  );
  return refusal.code === "delegation_cycle"
    ? `Refused: this launch would loop back to a machine it came from (${path}). Run the work on a machine not on that path, or here.`
    : `Refused: this launch came through ${path}, ${refusal.hops ?? "too many"} machine hops; this machine allows ${refusal.limit ?? "fewer"} for that sender. Start the work closer to where it began.`;
}

/**
 * Whether `project` here is one the grant covers. A personal assistant is
 * never covered: it is private to this machine, whatever the grant says.
 */
export function projectInGrant(
  projects: StudioWorkGrantProjects,
  coordinatorEnvironmentId: EnvironmentId,
  project: {
    readonly id: string;
    readonly workspaceSettings?:
      | {
          readonly kind?: string;
          readonly logicalProject?:
            | { readonly members: ReadonlyArray<{ readonly environmentId: string }> }
            | null
            | undefined;
        }
      | null
      | undefined;
  },
): boolean {
  if (isPersonalAssistantProject(project)) return false;
  switch (projects.kind) {
    case "all":
      return true;
    case "linked":
      return (
        project.workspaceSettings?.logicalProject?.members.some(
          (member) => member.environmentId === coordinatorEnvironmentId,
        ) ?? false
      );
    case "listed":
      return projects.projectIds.includes(project.id as never);
  }
}

/** Whether a turn on `instanceId` may run under the grant. */
export function accountInGrant(
  accounts: StudioWorkGrantAccounts,
  instanceId: ProviderInstanceId | string,
): boolean {
  switch (accounts.kind) {
    case "all":
      return true;
    case "none":
      return false;
    case "listed":
      return accounts.instanceIds.includes(instanceId as ProviderInstanceId);
  }
}

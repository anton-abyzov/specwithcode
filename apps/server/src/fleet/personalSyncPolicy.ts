import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import type { EnvironmentId } from "@specweave-studio/contracts";

import type { EffectiveWorkGrant } from "./workGrantPolicy.ts";

/**
 * Identity and membership gate for syncing a linked personal assistant across
 * the owner's own machines. Kept strictly separate from `workGrantPolicy.projectInGrant`
 * so personal assistants are never admitted into code-project work grants,
 * team grants, Away mode, or remote agent launches.
 */

export interface PersonalSyncCaller {
  readonly environmentId: EnvironmentId;
  readonly grant: Pick<EffectiveWorkGrant, "kind" | "legacy" | "revoked"> | undefined;
  readonly cloudUserId?: string | null | undefined;
}

export interface PersonalSyncLocal {
  readonly environmentId: EnvironmentId;
  readonly cloudUserId?: string | null | undefined;
}

export interface PersonalSyncTarget {
  readonly id: string;
  readonly workspaceSettings?:
    | {
        readonly kind?: string;
        readonly logicalProject?:
          | {
              readonly id: string;
              readonly members: ReadonlyArray<{ readonly environmentId: string }>;
            }
          | null
          | undefined;
      }
    | null
    | undefined;
}

export type PersonalSyncRefusalReason =
  | "not_personal"
  | "not_linked"
  | "same_machine"
  | "not_member"
  | "no_grant"
  | "grant_revoked"
  | "legacy_grant"
  | "not_own_grant"
  | "missing_cloud_user"
  | "cloud_user_mismatch";

export type PersonalSyncAccessResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: PersonalSyncRefusalReason };

function normalizeCloudUserId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Evaluates whether `caller` may participate in peer memory/settings sync for
 * a linked personal assistant on `local`.
 *
 * Requires:
 * - `project` is `kind: "personal"` and belongs to a `logicalProject`
 * - `caller` is a different machine and both machines are members of that `logicalProject`
 * - `caller.grant` is active, non-legacy, and `kind === "own"`
 * - both machines report the exact same non-empty `cloudUserId`
 */
export function personalSyncAccess(
  caller: PersonalSyncCaller,
  local: PersonalSyncLocal,
  project: PersonalSyncTarget,
  logicalProjectId?: string,
): PersonalSyncAccessResult {
  if (!isPersonalAssistantProject(project)) {
    return { allowed: false, reason: "not_personal" };
  }
  const logical = project.workspaceSettings?.logicalProject;
  if (!logical || (logicalProjectId !== undefined && logical.id !== logicalProjectId)) {
    return { allowed: false, reason: "not_linked" };
  }
  if (caller.environmentId === local.environmentId) {
    return { allowed: false, reason: "same_machine" };
  }
  const callerIsMember = logical.members.some((m) => m.environmentId === caller.environmentId);
  const localIsMember = logical.members.some((m) => m.environmentId === local.environmentId);
  if (!callerIsMember || !localIsMember) {
    return { allowed: false, reason: "not_member" };
  }
  if (!caller.grant) {
    return { allowed: false, reason: "no_grant" };
  }
  if (caller.grant.revoked) {
    return { allowed: false, reason: "grant_revoked" };
  }
  if (caller.grant.legacy === true) {
    return { allowed: false, reason: "legacy_grant" };
  }
  if (caller.grant.kind !== "own") {
    return { allowed: false, reason: "not_own_grant" };
  }
  const callerUser = normalizeCloudUserId(caller.cloudUserId);
  const localUser = normalizeCloudUserId(local.cloudUserId);
  if (!callerUser || !localUser) {
    return { allowed: false, reason: "missing_cloud_user" };
  }
  if (callerUser !== localUser) {
    return { allowed: false, reason: "cloud_user_mismatch" };
  }
  return { allowed: true };
}

export function isOwnPersonalSyncAllowed(
  caller: PersonalSyncCaller,
  local: PersonalSyncLocal,
  project: PersonalSyncTarget,
  logicalProjectId?: string,
): boolean {
  return personalSyncAccess(caller, local, project, logicalProjectId).allowed;
}

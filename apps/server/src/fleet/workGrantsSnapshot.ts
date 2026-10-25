import { EnvironmentId, type ProviderInstanceId } from "@specweave-studio/contracts";
import {
  type StudioWorkGrant,
  type StudioWorkGrantsSnapshot,
  workGrantHopLimit,
} from "@specweave-studio/contracts/studioFleet";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { coordinatorOfPrincipal } from "./workGrantPolicy.ts";
import * as WorkGrants from "./WorkGrants.ts";

/**
 * "Who can run work on this Mac": every coordinator machine with a grant
 * here, what it may use, and the projects and sign-ins the user can choose
 * from. Read on the machine doing the work, which owns the grants.
 */
export const workGrantsSnapshot = (input: {
  readonly ownEnvironmentId: EnvironmentId;
  /** Names this machine's fleet list gives coordinators, by environment id. */
  readonly labels: ReadonlyMap<string, string>;
}) =>
  Effect.gen(function* () {
    const grants = yield* WorkGrants.WorkGrants;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const now = yield* Clock.currentTimeMillis;
    const sessions = (yield* auth.listSessions()).flatMap((session) => {
      if (session.subject !== EnvironmentAuth.MCP_CLIENT_SUBJECT) return [];
      const coordinator = coordinatorOfPrincipal(session.principal);
      return coordinator === undefined ? [] : [{ coordinator, session }];
    });
    // A grant minted here but not used yet gets its policy now, so it can be seen and edited.
    for (const coordinator of new Set(sessions.map((entry) => entry.coordinator)))
      yield* grants.forCoordinator(coordinator);
    const policies = yield* grants.policies;
    const origins = yield* grants.origins;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const running = new Set(
      (yield* threads.getShellSnapshot({ maxAgeMs: 5_000 }).pipe(
        Effect.map((snapshot) => snapshot.threads),
        Effect.orElseSucceed(() => []),
      ))
        .filter((thread) => thread.activeRunId !== null && thread.deletedAt === null)
        .map((thread) => thread.id as string),
    );
    const rows: Array<StudioWorkGrant> = policies.map((policy) => {
      const live = sessions
        .filter((entry) => entry.coordinator === policy.coordinatorEnvironmentId)
        .map((entry) => DateTime.toEpochMillis(entry.session.expiresAt))
        .filter((expiresAt) => expiresAt > now);
      const expiresAt = live.length === 0 ? null : Math.max(...live);
      return {
        coordinatorEnvironmentId: EnvironmentId.make(policy.coordinatorEnvironmentId),
        machineLabel:
          input.labels.get(policy.coordinatorEnvironmentId) ?? policy.coordinatorEnvironmentId,
        projects: policy.legacy ? { kind: "all" } : policy.projects,
        accounts: policy.legacy ? { kind: "all" } : policy.accounts,
        owner: policy.owner,
        hopLimit: workGrantHopLimit(policy.owner),
        runtimeCap: policy.runtimeCap,
        expiresAt:
          expiresAt === null ? null : (DateTime.formatIso(DateTime.makeUnsafe(expiresAt)) as never),
        status: policy.revokedAt !== null ? "revoked" : expiresAt === null ? "expired" : "active",
        revokedAt: policy.revokedAt as never,
        interruptAt: policy.interruptedAt === null ? (policy.interruptAt as never) : null,
        runningThreads: origins.filter(
          (origin) =>
            origin.coordinatorEnvironmentId === policy.coordinatorEnvironmentId &&
            running.has(origin.threadId),
        ).length,
        legacy: policy.legacy,
      };
    });
    const projects = yield* ProjectService.ProjectService;
    const snapshot = yield* projects.snapshot.pipe(
      Effect.map((value) => value.projects),
      Effect.orElseSucceed(() => []),
    );
    const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
    return {
      grants: rows.toSorted((left, right) => left.machineLabel.localeCompare(right.machineLabel)),
      projects: snapshot
        .filter((project) => project.deletedAt === null)
        .map((project) => ({
          id: project.id,
          title: project.workspaceSettings?.logicalProject?.title ?? project.title,
          linkedTo: [
            ...new Set(
              (project.workspaceSettings?.logicalProject?.members ?? [])
                .map((member) => member.environmentId)
                .filter((environmentId) => environmentId !== input.ownEnvironmentId),
            ),
          ],
        })),
      accounts: providers.map((provider) => ({
        instanceId: provider.instanceId as ProviderInstanceId,
        label: provider.displayName ?? provider.instanceId,
        driver: provider.driver,
        account: Option.getOrNull(Option.fromNullishOr(provider.auth?.email)),
      })),
    } satisfies StudioWorkGrantsSnapshot;
  });

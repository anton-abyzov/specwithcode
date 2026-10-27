import {
  EnvironmentId,
  type MachineNicknames,
  type Project,
  type ProjectId,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  type StudioWorkGrant,
  type StudioWorkGrantsSnapshot,
  workGrantHopLimit,
} from "@specweave-studio/contracts/studioFleet";
import { normalizeMachineNickname } from "@specweave-studio/shared/machineNicknames";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { isAutomatedProject } from "@specweave-studio/shared/projectOrigin";
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

type WorkGrantProjectChoice = StudioWorkGrantsSnapshot["projects"][number];

/**
 * The projects "Chosen projects" offers: the person's own, live ones. The
 * machine's "No project" folder, archived projects and projects a check made
 * for itself are left out, except one a grant still covers: one a "listed"
 * grant names, or one linked to a coordinator whose grant is "linked". Those
 * stay, marked with why they are not offered, so access is never understated.
 * The personal assistant is never listed: no grant can cover it.
 */
export const workGrantProjectChoices = (input: {
  readonly projects: ReadonlyArray<Project>;
  readonly ownEnvironmentId: EnvironmentId;
  readonly scratchProjectIds: ReadonlySet<ProjectId>;
  readonly chosenProjectIds: ReadonlySet<ProjectId>;
  /** Coordinators whose grant covers every project linked to them. */
  readonly linkedCoordinators?: ReadonlySet<string>;
}): Array<WorkGrantProjectChoice> =>
  input.projects.flatMap((project) => {
    if (project.deletedAt !== null || isPersonalAssistantProject(project)) return [];
    const unavailable = input.scratchProjectIds.has(project.id)
      ? "scratch"
      : project.workspaceSettings?.archived === true
        ? "archived"
        : isAutomatedProject(project)
          ? "automated"
          : undefined;
    const linkedTo = [
      ...new Set(
        (project.workspaceSettings?.logicalProject?.members ?? [])
          .map((member) => member.environmentId)
          .filter((environmentId) => environmentId !== input.ownEnvironmentId),
      ),
    ];
    const covered =
      input.chosenProjectIds.has(project.id) ||
      linkedTo.some((environmentId) => input.linkedCoordinators?.has(environmentId) === true);
    if (unavailable !== undefined && !covered) return [];
    return [
      {
        id: project.id,
        title: project.workspaceSettings?.logicalProject?.title ?? project.title,
        linkedTo,
        ...(unavailable === undefined ? {} : { unavailable }),
      },
    ];
  });

/**
 * Coordinator names by environment id: the name this machine's fleet list gives
 * it, else the nickname paired machines share. A coordinator that is in neither
 * is left out, and the screen names it by a short id.
 */
export const coordinatorLabels = (
  machines: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>,
  nicknames: MachineNicknames | undefined,
): Map<string, string> => {
  const labels = new Map<string, string>();
  for (const [environmentId, entry] of Object.entries(nicknames ?? {})) {
    const name = normalizeMachineNickname(entry.name);
    if (name !== "") labels.set(environmentId, name);
  }
  for (const machine of machines) {
    const label = machine.label.trim();
    if (label !== "") labels.set(machine.environmentId, label);
  }
  return labels;
};

/**
 * The machine's projects for the grants snapshot. A failed read still answers, so the
 * grants stay visible and revocable, and says so with `projectsUnreadable`.
 */
export const readGrantProjects = <E, R>(
  snapshot: Effect.Effect<{ readonly projects: ReadonlyArray<Project> }, E, R>,
) =>
  snapshot.pipe(
    Effect.map((value) => ({ projects: value.projects, flag: {} })),
    Effect.orElseSucceed(() => ({
      projects: [] as ReadonlyArray<Project>,
      flag: { projectsUnreadable: true as const },
    })),
  );

/**
 * "Who can run work on this Mac": every coordinator machine with a grant
 * here, what it may use, and the projects and sign-ins the user can choose
 * from. Read on the machine doing the work, which owns the grants.
 */
export const workGrantsSnapshot = (input: {
  readonly ownEnvironmentId: EnvironmentId;
  /** Coordinator names by environment id; see {@link coordinatorLabels}. */
  readonly labels: ReadonlyMap<string, string>;
  /** Whether a project is this machine's Scratch project ("No project"). */
  readonly isScratch?: (projectId: ProjectId) => Effect.Effect<boolean>;
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
    const read = yield* readGrantProjects(projects.snapshot);
    const snapshot = read.projects;
    const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
    const isScratch = input.isScratch;
    const scratch =
      isScratch === undefined
        ? []
        : yield* Effect.filter(snapshot, (project) => isScratch(project.id));
    return {
      grants: rows.toSorted((left, right) => left.machineLabel.localeCompare(right.machineLabel)),
      projects: workGrantProjectChoices({
        projects: snapshot,
        ownEnvironmentId: input.ownEnvironmentId,
        scratchProjectIds: new Set(scratch.map((project) => project.id)),
        chosenProjectIds: new Set(
          policies.flatMap((policy) =>
            !policy.legacy && policy.projects.kind === "listed" ? policy.projects.projectIds : [],
          ),
        ),
        linkedCoordinators: new Set(
          policies.flatMap((policy) =>
            !policy.legacy && policy.projects.kind === "linked"
              ? [policy.coordinatorEnvironmentId]
              : [],
          ),
        ),
      }),
      ...read.flag,
      accounts: providers.map((provider) => ({
        instanceId: provider.instanceId as ProviderInstanceId,
        label: provider.displayName ?? provider.instanceId,
        driver: provider.driver,
        account: Option.getOrNull(Option.fromNullishOr(provider.auth?.email)),
      })),
    } satisfies StudioWorkGrantsSnapshot;
  });

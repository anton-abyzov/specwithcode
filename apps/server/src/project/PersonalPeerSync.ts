/**
 * What a linked personal assistant seat takes from a peer beside memory
 * (1448 AC-05, AC-07, AC-10): the shared settings, newest first, and the
 * members another seat removed. Pure helpers, plus the wiring that writes them
 * through `ProjectService`.
 *
 * @module PersonalPeerSync
 */
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type EnvironmentId,
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  ProjectIconOverride,
  type ProjectRepository,
  projectRepositoryIdentity,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import type { LinkedPersonalSettings } from "../handoff/linkedSyncWire.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { PERSONAL_SEAT_LEFT_MESSAGE, PERSONAL_SEAT_REMOVED_MESSAGE } from "./LinkedPeerRoute.ts";
import { rememberRemoval, removalStands } from "./linkMembership.ts";
import type * as ProjectService from "./ProjectService.ts";

const isIconOverride = Schema.is(ProjectIconOverride);

const repositoryKey = (url: string) => projectRepositoryIdentity(url) ?? url.trim().toLowerCase();

export interface PersonalSettingsPatch {
  readonly stamp: string;
  readonly title?: string;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly instructions?: string;
  readonly repositories?: ReadonlyArray<ProjectRepository>;
}

const MAX_STAMP_SKEW_MS = 10 * 60 * 1000;

/** A shared-settings stamp as epoch milliseconds; null unless it is an ISO date and time. */
export const parseSettingsStamp = (stamp: string | null | undefined): number | null => {
  if (typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(stamp)) return null;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The settings this seat takes from a peer: all of the peer's shared settings
 * when its `sharedSettingsUpdatedAt` is newer than this seat's, else none. Both
 * stamps are read as ISO times; a peer stamp that is not one never wins, and an
 * equal time changes nothing. The peer's repository list replaces this seat's
 * (a repository removed there is removed here), and each repository this seat
 * already had keeps its own local folder. A per-machine change (pause, runner,
 * memory flags) never moves the stamp, so it can never make stale settings win.
 * An icon kind this version does not know leaves this seat's icon as it is.
 * A stamp more than ten minutes ahead of this machine's clock is ignored, so a
 * peer with a fast clock cannot make its settings win over every later edit.
 */
export function computePersonalSettingsPatch(
  project: Project,
  peer: LinkedPersonalSettings,
  nowMs: number = Date.now(),
): PersonalSettingsPatch | null {
  const peerMs = parseSettingsStamp(peer.updatedAt);
  if (peerMs === null || peer.updatedAt === null) return null;
  if (peerMs > nowMs + MAX_STAMP_SKEW_MS) return null;
  const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
  const localMs = parseSettingsStamp(settings.sharedSettingsUpdatedAt);
  if (localMs !== null && peerMs <= localMs) return null;

  const localRepos = settings.environment?.repositories ?? [];
  const localByKey = new Map(localRepos.map((repo) => [repositoryKey(repo.url), repo]));
  const seen = new Set<string>();
  const nextRepos: ProjectRepository[] = [];
  for (const repo of peer.repositoryUrls) {
    const url = repo.url.trim();
    if (url.length === 0) continue;
    const key = repositoryKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const local = localByKey.get(key);
    nextRepos.push(local ?? { id: repo.id, url, localPath: null });
  }
  const sameRepos =
    nextRepos.length === localRepos.length &&
    nextRepos.every((repo, index) => repo === localRepos[index]);

  const icon = peer.icon === null || isIconOverride(peer.icon) ? peer.icon : undefined;
  const sameIcon =
    icon === undefined || JSON.stringify(icon) === JSON.stringify(project.projectIcon ?? null);

  return {
    stamp: peer.updatedAt,
    ...(peer.title !== project.title ? { title: peer.title } : {}),
    ...(sameIcon ? {} : { projectIcon: icon ?? null }),
    ...(peer.instructions !== settings.instructions ? { instructions: peer.instructions } : {}),
    ...(sameRepos ? {} : { repositories: nextRepos }),
  };
}

export type PersonalRemovalPatch =
  | { readonly kind: "unlink-self" }
  | {
      readonly kind: "remove";
      readonly logicalProject: LogicalProject;
      readonly coordinatorBinding: ProjectCoordinatorBinding;
    };

type MemberRef = Pick<LogicalProjectMember, "environmentId" | "projectId">;
const keyOf = (entry: MemberRef) => `${entry.environmentId}:${entry.projectId}`;

/**
 * What this seat does with the members a peer's binding lists as removed: it
 * unlinks itself when it is among them (its local copy stays, 1448 AC-07), or
 * when no other seat would be left; otherwise it drops those members too, and
 * remembers only the ones it drops now, each entry as the peer recorded it.
 * A removal older than a later link of the same seat (`relinkedMembers` on
 * either binding) no longer counts, nor one that names another link of it.
 */
export function computePersonalRemovalPatch(
  project: Project,
  selfEnvironmentId: EnvironmentId,
  peerBinding: ProjectCoordinatorBinding | null,
): PersonalRemovalPatch | null {
  const settings = project.workspaceSettings;
  const identity = settings?.logicalProject;
  if (identity === undefined) return null;
  const current = settings?.coordinatorBinding ?? { epoch: 0, state: "active" as const };
  const listed = new Map(identity.members.map((member) => [keyOf(member), member]));
  const standing = (peerBinding?.removedMembers ?? []).filter((entry) => {
    const member = listed.get(keyOf(entry));
    return (
      member !== undefined &&
      (entry.linkId === undefined ||
        member.linkId === undefined ||
        entry.linkId === member.linkId) &&
      removalStands(entry, peerBinding?.relinkedMembers ?? [], current.relinkedMembers ?? [])
    );
  });
  if (standing.length === 0) return null;
  const selfKey = `${selfEnvironmentId}:${project.id}`;
  if (!listed.has(selfKey)) return null;
  if (standing.some((entry) => keyOf(entry) === selfKey)) return { kind: "unlink-self" };

  const byKey = new Map(standing.map((entry) => [keyOf(entry), entry]));
  const remaining = identity.members.filter((member) => !byKey.has(keyOf(member)));
  if (remaining.length <= 1) return { kind: "unlink-self" };
  return {
    kind: "remove",
    logicalProject: { ...identity, members: remaining },
    coordinatorBinding: {
      ...current,
      removedMembers: [...(current.removedMembers ?? []), ...byKey.values()],
    },
  };
}

/**
 * What this seat does when peer `left` answered that it left the link (1448
 * C1): it drops only that seat, remembering it as removed now, and unlinks
 * itself only when no other seat would be left.
 */
export function computeLeftPeerPatch(
  project: Project,
  selfEnvironmentId: EnvironmentId,
  left: MemberRef,
  nowMs: number,
): PersonalRemovalPatch | null {
  const settings = project.workspaceSettings;
  const identity = settings?.logicalProject;
  if (identity === undefined) return null;
  if (!identity.members.some((member) => keyOf(member) === `${selfEnvironmentId}:${project.id}`))
    return null;
  const listed = identity.members.find((member) => keyOf(member) === keyOf(left));
  if (listed === undefined || keyOf(listed) === `${selfEnvironmentId}:${project.id}`) return null;
  const remaining = identity.members.filter((member) => member !== listed);
  if (remaining.length <= 1) return { kind: "unlink-self" };
  const current = settings?.coordinatorBinding ?? { epoch: 0, state: "active" as const };
  return {
    kind: "remove",
    logicalProject: { ...identity, members: remaining },
    coordinatorBinding: rememberRemoval(current, listed, nowMs),
  };
}

const FORMER_LINKS_LIMIT = 8;

/**
 * The unlinked identity a personal seat takes when it leaves: a fresh id listing
 * only itself, and a binding that remembers the link it left (`formerLinks`,
 * newest last), so a seat still on that link is told this one left.
 */
export const unlinkedPersonalIdentity = (
  project: Project,
  selfEnvironmentId: EnvironmentId,
  leftAt: string,
) =>
  Effect.gen(function* () {
    const settings = project.workspaceSettings;
    const identity = settings?.logicalProject;
    const self = identity?.members.find(
      (member) => member.environmentId === selfEnvironmentId && member.projectId === project.id,
    );
    if (identity === undefined || self === undefined) return null;
    const logicalProject: LogicalProject = {
      id: `logical:${yield* randomUuidV4}`,
      title: project.title,
      coordinatorId: self.coordinatorThreadId,
      members: [self],
    };
    const coordinatorBinding: ProjectCoordinatorBinding = {
      epoch: 0,
      state: "active",
      routineOwner: true,
      formerLinks: [
        ...(settings?.coordinatorBinding?.formerLinks ?? []).filter(
          (entry) => entry.logicalProjectId !== identity.id,
        ),
        { logicalProjectId: identity.id, members: identity.members.slice(0, 64), leftAt },
      ].slice(-FORMER_LINKS_LIMIT),
    };
    return { logicalProject, coordinatorBinding };
  });

/**
 * Whether this machine lets `environmentId` sync a personal seat with it: it
 * holds an active, non-legacy, own grant for that machine. Each seat checks its
 * own side, so a one-way pairing never syncs. Unknown grants refuse.
 */
export const personalPeerAllowed = (
  grants: WorkGrants.WorkGrantsShape,
  environmentId: EnvironmentId,
) =>
  Effect.gen(function* () {
    if (!grants.enabled || grants.peekPolicy === undefined) return false;
    const record = yield* grants.peekPolicy(environmentId);
    if (record === undefined) return false;
    const grant = WorkGrants.effectiveGrant(
      record,
      yield* grants.managers,
      yield* Clock.currentTimeMillis,
    );
    return grant.kind === "own" && grant.legacy !== true && !grant.revoked;
  }).pipe(Effect.orElseSucceed(() => false));

/** The fields a settings patch writes, in the order a field-by-field retry applies them. */
const PATCH_FIELDS = ["title", "projectIcon", "instructions", "repositories"] as const;
type PatchField = (typeof PATCH_FIELDS)[number];

/** Every non-empty subset of `fields`, largest first, each in `fields` order. */
const fieldSubsets = (
  fields: ReadonlyArray<PatchField>,
): ReadonlyArray<ReadonlyArray<PatchField>> =>
  Array.from({ length: (1 << fields.length) - 1 }, (_, index) =>
    fields.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0),
  ).toSorted((left, right) => right.length - left.length);

/** The `projects.update` input that writes `fields` of `patch` onto `project`. */
const settingsUpdate = (
  project: Project,
  patch: PersonalSettingsPatch,
  fields: ReadonlyArray<PatchField>,
) => {
  const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
  const title = fields.includes("title") ? patch.title : undefined;
  const projectIcon = fields.includes("projectIcon") ? patch.projectIcon : undefined;
  const instructions = fields.includes("instructions") ? patch.instructions : undefined;
  const repositories = fields.includes("repositories") ? patch.repositories : undefined;
  const touchesSettings = instructions !== undefined || repositories !== undefined;
  return {
    projectId: project.id,
    commandId: CommandId.make(
      `personal-settings-sync:${project.id}:${settings.revision}:${patch.stamp}:${fields.join(",")}`,
    ),
    sharedSettingsStamp: patch.stamp,
    ...(title !== undefined ? { title } : {}),
    ...(projectIcon !== undefined ? { projectIcon } : {}),
    ...(touchesSettings
      ? {
          workspaceSettings: {
            expectedRevision: settings.revision,
            ...(instructions !== undefined ? { instructions } : {}),
            ...(repositories !== undefined
              ? {
                  environment: {
                    additionalFolders: settings.environment?.additionalFolders ?? [],
                    repositories,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
};

/** The `LinkedPeerSync` hooks for personal seats, wired to this server's projects. */
export const personalPeerSyncDeps = (
  projects: Pick<ProjectService.ProjectService["Service"], "update">,
  environment: Pick<ServerEnvironment.ServerEnvironment["Service"], "getEnvironmentId">,
  grants?: WorkGrants.WorkGrantsShape,
) => {
  const unlinkSelf = (project: Project, reason: string) =>
    Effect.gen(function* () {
      const selfEnvironmentId = yield* environment.getEnvironmentId;
      const leftAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      const fresh = yield* unlinkedPersonalIdentity(project, selfEnvironmentId, leftAt);
      if (fresh === null) return false;
      const revision = project.workspaceSettings?.revision ?? 0;
      yield* projects.update({
        projectId: project.id,
        commandId: CommandId.make(`personal-unlink-sync:${project.id}:${revision}`),
        ownership: { mode: "unlink", expectedRevision: revision, ...fresh },
      });
      yield* Effect.logInfo("Linked personal assistant seat unlinked itself", { reason });
      return true;
    });

  /** Writes a removal patch; true when this seat unlinked itself. */
  const applyRemoval = (project: Project, patch: PersonalRemovalPatch, reason: string) =>
    Effect.gen(function* () {
      if (patch.kind === "unlink-self") return yield* unlinkSelf(project, reason);
      const revision = project.workspaceSettings?.revision ?? 0;
      yield* projects.update({
        projectId: project.id,
        commandId: CommandId.make(`personal-remove-sync:${project.id}:${revision}`),
        ownership: {
          mode: "remove-member",
          expectedRevision: revision,
          logicalProject: patch.logicalProject,
          coordinatorBinding: patch.coordinatorBinding,
        },
      });
      return false;
    });

  return {
    syncPersonalSettings: ({
      project,
      peerSettings,
    }: {
      readonly project: Project;
      readonly peerSettings: LinkedPersonalSettings;
    }) =>
      Effect.gen(function* () {
        const patch = computePersonalSettingsPatch(project, peerSettings);
        if (patch === null) return;
        const fields = PATCH_FIELDS.filter((field) => patch[field] !== undefined);
        if (fields.length === 0) return;
        // One field this machine refuses (a name taken here, a missing folder) must not hold
        // back the others: the largest set of fields it accepts is written, in one update,
        // since a second write under the same stamp is refused as not newer. A refused
        // write changes nothing, so every attempt starts from the same copy.
        let lastFailure: unknown = undefined;
        for (const subset of fieldSubsets(fields)) {
          const applied = yield* projects
            .update(settingsUpdate(project, patch, subset))
            .pipe(Effect.result);
          if (Result.isSuccess(applied)) {
            const skipped = fields.filter((field) => !subset.includes(field));
            if (skipped.length > 0)
              yield* Effect.logWarning("Personal assistant settings taken from a peer in part", {
                projectId: project.id,
                skipped,
              });
            return;
          }
          lastFailure = applied.failure;
        }
        yield* Effect.logWarning("Personal assistant settings could not be taken from a peer", {
          projectId: project.id,
          fields,
          cause: lastFailure,
        });
      }),
    syncPersonalRemovals: ({
      project,
      peerBinding,
    }: {
      readonly project: Project;
      readonly peerBinding: ProjectCoordinatorBinding | null;
    }) =>
      Effect.gen(function* () {
        const selfEnvironmentId = yield* environment.getEnvironmentId;
        const patch = computePersonalRemovalPatch(project, selfEnvironmentId, peerBinding);
        if (patch === null) return { unlinkedSelf: false, changed: false };
        const unlinkedSelf = yield* applyRemoval(project, patch, "removed by a peer");
        return { unlinkedSelf, changed: true };
      }),
    /**
     * A peer refused this seat's call as fenced (1448 AC-07, C1): it no longer lists
     * this seat (`PERSONAL_SEAT_REMOVED_MESSAGE`), so this seat unlinks itself, or
     * it left the link (`PERSONAL_SEAT_LEFT_MESSAGE`), so only that peer is dropped.
     * "unlinked" or "dropped" when this seat changed; null when it did nothing.
     */
    personalPeerFenced: (project: Project, peer: LogicalProjectMember, message: string) =>
      Effect.gen(function* () {
        if (message === PERSONAL_SEAT_REMOVED_MESSAGE)
          return (yield* unlinkSelf(project, "a peer no longer lists this seat"))
            ? ("unlinked" as const)
            : null;
        if (message !== PERSONAL_SEAT_LEFT_MESSAGE) return null;
        const selfEnvironmentId = yield* environment.getEnvironmentId;
        const patch = computeLeftPeerPatch(
          project,
          selfEnvironmentId,
          peer,
          yield* Clock.currentTimeMillis,
        );
        if (patch === null) return null;
        return (yield* applyRemoval(project, patch, "the last other seat left"))
          ? ("unlinked" as const)
          : ("dropped" as const);
      }),
    ...(grants === undefined
      ? {}
      : {
          personalPeerAllowed: (environmentId: EnvironmentId) =>
            personalPeerAllowed(grants, environmentId),
        }),
  };
};

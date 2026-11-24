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
  type Project,
  type ProjectCoordinatorBinding,
  ProjectIconOverride,
  type ProjectRepository,
  projectRepositoryIdentity,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { LinkedPersonalSettings } from "../handoff/linkedSyncWire.ts";
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
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

/**
 * The settings this seat takes from a peer: all of the peer's shared settings
 * when its `sharedSettingsUpdatedAt` is newer than this seat's, else none. The
 * peer's repository list replaces this seat's (a repository removed there is
 * removed here), and each repository this seat already had keeps its own local
 * folder. A per-machine change (pause, runner, memory flags) never moves the
 * stamp, so it can never make stale settings win.
 */
export function computePersonalSettingsPatch(
  project: Project,
  peer: LinkedPersonalSettings,
): PersonalSettingsPatch | null {
  if (peer.updatedAt === null) return null;
  const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
  const localStamp = settings.sharedSettingsUpdatedAt ?? null;
  if (localStamp !== null && peer.updatedAt <= localStamp) return null;

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

/**
 * What this seat does with the members a peer's binding lists as removed: it
 * unlinks itself when it is among them (its local copy stays, 1448 AC-07), or
 * when no other seat would be left; otherwise it drops those members too, and
 * remembers only the ones it drops now.
 */
export function computePersonalRemovalPatch(
  project: Project,
  selfEnvironmentId: EnvironmentId,
  peerBinding: ProjectCoordinatorBinding | null,
): PersonalRemovalPatch | null {
  const settings = project.workspaceSettings;
  const identity = settings?.logicalProject;
  const peerRemoved = peerBinding?.removedMembers ?? [];
  if (identity === undefined || peerRemoved.length === 0) return null;
  const isSelf = (entry: { environmentId: string; projectId: string }) =>
    entry.environmentId === selfEnvironmentId && entry.projectId === project.id;
  if (!identity.members.some(isSelf)) return null;
  if (peerRemoved.some(isSelf)) return { kind: "unlink-self" };

  const removedKeys = new Set(
    peerRemoved.map((entry) => `${entry.environmentId}:${entry.projectId}`),
  );
  const droppedNow = identity.members.filter((member) =>
    removedKeys.has(`${member.environmentId}:${member.projectId}`),
  );
  if (droppedNow.length === 0) return null;
  const remaining = identity.members.filter((member) => !droppedNow.includes(member));
  if (remaining.length <= 1) return { kind: "unlink-self" };

  const current = settings?.coordinatorBinding ?? { epoch: 0, state: "active" as const };
  const removedAt = new Map(
    peerRemoved.map((entry) => [`${entry.environmentId}:${entry.projectId}`, entry.removedAt]),
  );
  return {
    kind: "remove",
    logicalProject: { ...identity, members: remaining },
    coordinatorBinding: {
      ...current,
      removedMembers: [
        ...(current.removedMembers ?? []),
        ...droppedNow.map((member) => ({
          environmentId: member.environmentId,
          projectId: member.projectId,
          removedAt: removedAt.get(`${member.environmentId}:${member.projectId}`)!,
        })),
      ],
    },
  };
}

/** The unlinked identity a personal seat takes when it leaves: a fresh id listing only itself. */
export const unlinkedPersonalIdentity = (project: Project, selfEnvironmentId: EnvironmentId) =>
  Effect.gen(function* () {
    const settings = project.workspaceSettings;
    const self = settings?.logicalProject?.members.find(
      (member) => member.environmentId === selfEnvironmentId && member.projectId === project.id,
    );
    if (settings?.logicalProject === undefined || self === undefined) return null;
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
    };
    return { logicalProject, coordinatorBinding };
  });

/** The `LinkedPeerSync` hooks for personal seats, wired to this server's projects. */
export const personalPeerSyncDeps = (
  projects: ProjectService.ProjectService["Service"],
  environment: ServerEnvironment.ServerEnvironment["Service"],
) => {
  const unlinkSelf = (project: Project, reason: string) =>
    Effect.gen(function* () {
      const selfEnvironmentId = yield* environment.getEnvironmentId;
      const fresh = yield* unlinkedPersonalIdentity(project, selfEnvironmentId);
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
        const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
        const touchesSettings =
          patch.instructions !== undefined || patch.repositories !== undefined;
        if (!touchesSettings && patch.title === undefined && patch.projectIcon === undefined)
          return;
        yield* projects.update({
          projectId: project.id,
          commandId: CommandId.make(
            `personal-settings-sync:${project.id}:${settings.revision}:${patch.stamp}`,
          ),
          sharedSettingsStamp: patch.stamp,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.projectIcon !== undefined ? { projectIcon: patch.projectIcon } : {}),
          ...(touchesSettings
            ? {
                workspaceSettings: {
                  expectedRevision: settings.revision,
                  ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
                  ...(patch.repositories !== undefined
                    ? {
                        environment: {
                          additionalFolders: settings.environment?.additionalFolders ?? [],
                          repositories: patch.repositories,
                        },
                      }
                    : {}),
                },
              }
            : {}),
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
        if (patch === null) return { unlinkedSelf: false };
        if (patch.kind === "unlink-self")
          return { unlinkedSelf: yield* unlinkSelf(project, "removed by a peer") };
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
        return { unlinkedSelf: false };
      }),
    /** A seat that still lists this one answered that this machine was removed. */
    unlinkRemovedPersonalSeat: (project: Project) =>
      unlinkSelf(project, "a peer no longer lists this seat"),
  };
};

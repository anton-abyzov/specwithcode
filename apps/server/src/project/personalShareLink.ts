/**
 * The writes a seat makes when the one Percy links itself (1448 D-15, D-16,
 * T-14): what it shares, the one-time copies of a join series, the joining
 * seat's merge and link, the starter's first link, a member admitting a new
 * seat and a member taking the seats another member admitted.
 *
 * Every write is safe to repeat after a failure or a restart: a join series
 * saves its database copy and its restore point once (a before-link point
 * saved since the seat was last unlinked is the marker), the merge is
 * idempotent, and the link is written last, so a failure leaves the seat
 * unlinked and the next pass tries again.
 *
 * @module personalShareLink
 */
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type EnvironmentId,
  logicalProjectMemberKey,
  type LogicalProject,
  type LogicalProjectMember,
  type Project,
  type ProjectCoordinatorBinding,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { PersonalShareContent } from "../handoff/personalShareWire.ts";
import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import { MEMORY_INDEX_NAME } from "./linkedMemoryMerge.ts";
import { containsMemorySecret, localOnlyMemorySet } from "./memorySecretScan.ts";
import {
  type AutoMergeServices,
  autoMergeJoiningSeat,
  forgetPreLinkTombstones,
} from "./personalAutoMerge.ts";
import type { PersonalLinkSnapshotter } from "./personalLinkSnapshot.ts";
import { bindingRelinking } from "./PersonalLinkService.ts";
import { computePersonalSettingsPatch } from "./PersonalPeerSync.ts";
import type * as PersonalRestorePoint from "./personalRestorePoint.ts";
import type * as ProjectService from "./ProjectService.ts";

export class PersonalShareLinkError extends Schema.TaggedError<PersonalShareLinkError>()(
  "PersonalShareLinkError",
  {
    stage: Schema.Literals(["read", "snapshot", "restore_point", "merge", "settings", "write"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "read":
        return "Could not read this machine's Percy.";
      case "snapshot":
        return "Could not save a copy of the database before linking; nothing was linked.";
      case "restore_point":
        return "Could not save a restore point before linking; nothing was linked.";
      case "merge":
        return "Could not merge this machine's memory into the link; it tries again.";
      case "settings":
        return "Could not take the link's settings; it tries again.";
      case "write":
        return "Could not write the link on this machine; it tries again.";
    }
  }
}

export interface ShareLinkServices extends AutoMergeServices {
  readonly projects: Pick<ProjectService.ProjectService["Service"], "getById" | "update">;
  readonly restorePoints: Pick<
    PersonalRestorePoint.PersonalRestorePoint["Service"],
    "capture" | "list"
  >;
  readonly snapshot: PersonalLinkSnapshotter;
}

const failed = (stage: PersonalShareLinkError["stage"]) => (cause: unknown) =>
  new PersonalShareLinkError({ stage, cause });

/** This seat as a link member: its own entry when it is listed, else a fresh one. */
export const selfMemberFor = (
  project: Project,
  environmentId: EnvironmentId,
): LogicalProjectMember =>
  project.workspaceSettings?.logicalProject?.members.find(
    (member) => member.environmentId === environmentId && member.projectId === project.id,
  ) ?? {
    environmentId,
    projectId: project.id,
    coordinatorThreadId:
      project.workspaceSettings?.coordinatorThreadId ??
      ThreadId.make(`project-coordinator:${project.id}`),
  };

/** Whether the seat is linked to `linkId` with at least one other machine. */
export const linkedTo = (project: Project | undefined, linkId: string | null) => {
  const identity = project?.workspaceSettings?.logicalProject;
  return linkId !== null && identity?.id === linkId && identity.members.length > 1;
};

/** When the seat last left a link, from its own binding; null when it never did. */
export const lastUnlinkedAt = (project: Project): string | null =>
  (project.workspaceSettings?.coordinatorBinding?.formerLinks ?? []).reduce<string | null>(
    (latest, entry) => (latest === null || entry.leftAt > latest ? entry.leftAt : latest),
    null,
  );

/**
 * What this seat shares, from its memory as read now: files neither kept on
 * this machine nor secret-flagged, by name and hash, and the text of a shared
 * `MEMORY.md`.
 */
export const sharedMemoryOf = (
  project: Project,
  files: ReadonlyArray<{ readonly name: string; readonly content: string }>,
) => {
  const localOnly = localOnlyMemorySet(project.workspaceSettings);
  const shared = files.filter(
    (file) => !localOnly.has(file.name) && !containsMemorySecret(file.content),
  );
  return {
    files: shared.map((file) => ({ name: file.name, sha256: memoryContentHash(file.content) })),
    index: shared.find((file) => file.name === MEMORY_INDEX_NAME)?.content ?? null,
  };
};

/** This seat's phase-2 content: itself, its link, its shared settings and memory. */
export const shareContentOf = (
  project: Project,
  environmentId: EnvironmentId,
  linkId: string | null,
  memory: PersonalShareContent["memory"],
): PersonalShareContent => {
  const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
  const identity = settings.logicalProject;
  return {
    self: selfMemberFor(project, environmentId),
    link:
      identity !== undefined && linkedTo(project, linkId)
        ? { id: identity.id, title: identity.title, members: identity.members.slice(0, 64) }
        : null,
    settings: {
      updatedAt: settings.sharedSettingsUpdatedAt ?? null,
      title: project.title,
      instructions: settings.instructions,
      icon: project.projectIcon ?? null,
      repositoryUrls: settings.environment.repositories
        .map((repo) => ({ id: repo.id, url: repo.url.trim() }))
        .filter((repo) => repo.url.length > 0)
        .slice(0, 32),
    },
    memory,
  };
};

const reload = (services: ShareLinkServices, project: Project) =>
  services.projects.getById(project.id).pipe(
    Effect.mapError(failed("read")),
    Effect.flatMap((found) =>
      Option.isSome(found) && found.value.deletedAt === null
        ? Effect.succeed(found.value)
        : Effect.fail(new PersonalShareLinkError({ stage: "read" })),
    ),
  );

/**
 * The copies of one join series, saved once (D-16, AC-13): the whole
 * database, then the Percy restore point. Skipped when a before-link point
 * was saved since the series began, so a peer that fails every minute never
 * makes a copy every minute and a retry never shadows the pristine point. The
 * database copy is keyed by the series, so a retry after the copy and before
 * the point reuses the copy.
 *
 * A series begins when the seat last left a link, when an undo last ran, or
 * when the owner last turned the switch on (`switchedOnAt`), whichever is
 * latest. A point from an older series, such as one saved for a join that
 * failed before the switch went off, is never the one an undo restores.
 */
export const ensureSeriesCopies = (
  services: ShareLinkServices,
  project: Project,
  switchedOnAt?: string,
) =>
  Effect.gen(function* () {
    const points = yield* services.restorePoints
      .list(project.id)
      .pipe(Effect.mapError(failed("restore_point")));
    const since = [
      lastUnlinkedAt(project),
      points.find((point) => point.reason === "before-undo")?.savedAt ?? null,
      switchedOnAt ?? null,
    ].reduce<string | null>(
      (latest, at) => (at === null || (latest !== null && latest >= at) ? latest : at),
      null,
    );
    if (
      points.some(
        (point) => point.reason === "before-link" && (since === null || point.savedAt > since),
      )
    )
      return { saved: false as const };
    const databaseCopy = yield* services.snapshot
      .snapshot(`percy-join-${project.id}-${since ?? "first"}`)
      .pipe(Effect.mapError(failed("snapshot")));
    const point = yield* services.restorePoints
      .capture(project.id, "before-link")
      .pipe(Effect.mapError(failed("restore_point")));
    return { saved: true as const, databaseCopy, restorePoint: point.path };
  });

/** The link's shared settings onto this seat, with the link's name; nothing else changes. */
const takeLinkSettings = (
  services: ShareLinkServices,
  project: Project,
  peer: PersonalShareContent,
  title: string,
) =>
  Effect.gen(function* () {
    const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
    // The link's values whatever this seat's stamp says: compared as if this seat had none.
    const { sharedSettingsUpdatedAt: _own, ...unstamped } = settings;
    const patch = computePersonalSettingsPatch(
      { ...project, workspaceSettings: unstamped },
      { ...peer.settings, title, updatedAt: peer.settings.updatedAt ?? "1970-01-01T00:00:00.000Z" },
    );
    if (patch === null) return;
    const touches = patch.instructions !== undefined || patch.repositories !== undefined;
    if (patch.title === undefined && patch.projectIcon === undefined && !touches) return;
    yield* services.projects
      .update({
        projectId: project.id,
        commandId: CommandId.make(`percy-take-settings:${project.id}:${settings.revision}`),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.projectIcon !== undefined ? { projectIcon: patch.projectIcon } : {}),
        ...(touches
          ? {
              workspaceSettings: {
                expectedRevision: settings.revision,
                ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
                ...(patch.repositories !== undefined
                  ? {
                      environment: {
                        additionalFolders: settings.environment.additionalFolders,
                        repositories: patch.repositories,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        // Not a new edit: the member that admits this seat stamps the link's settings.
        sharedStampMode: "suppress",
      })
      .pipe(Effect.mapError(failed("settings")));
  });

const dedupe = (members: ReadonlyArray<LogicalProjectMember>) => {
  const byKey = new Map<string, LogicalProjectMember>();
  for (const member of members) byKey.set(logicalProjectMemberKey(member), member);
  return [...byKey.values()];
};

/** One seat per machine: a member listed for this machine is always this seat. */
const membersWith = (
  members: ReadonlyArray<LogicalProjectMember>,
  self: LogicalProjectMember,
): Array<LogicalProjectMember> =>
  dedupe([...members.filter((member) => member.environmentId !== self.environmentId), self]);

/** Writes `identity` on a seat in no link with others (join-as-member), last of every step. */
const writeJoin = (
  services: ShareLinkServices,
  project: Project,
  identity: LogicalProject,
  nowIso: string,
  extras: { readonly title?: string; readonly force?: boolean },
) =>
  Effect.gen(function* () {
    const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
    const current = settings.logicalProject;
    const binding = settings.coordinatorBinding;
    const formerLinks = (binding?.formerLinks ?? []).filter(
      (entry) => entry.logicalProjectId !== identity.id,
    );
    const next: ProjectCoordinatorBinding = bindingRelinking(
      {
        epoch: binding?.epoch ?? 0,
        state: "active",
        operationId: `percy-share:${identity.id}`,
        routineOwner: binding?.routineOwner ?? true,
        ...(formerLinks.length > 0 ? { formerLinks } : {}),
      },
      identity.members,
      nowIso,
    );
    yield* services.projects
      .update({
        projectId: project.id,
        commandId: CommandId.make(`percy-join:${project.id}:${settings.revision}`),
        ownership: {
          mode: "join-as-member",
          expectedRevision: settings.revision,
          joinExpectedLogicalProjectId: current?.id ?? null,
          logicalProject: identity,
          coordinatorBinding: next,
        },
        ...(extras.title !== undefined && extras.title !== project.title
          ? { title: extras.title }
          : {}),
        ...(extras.force === true ? { sharedStampMode: "force" as const } : {}),
      })
      .pipe(Effect.mapError(failed("write")));
  });

/** This seat's deletions of files a seat new to the link holds: never honoured (D-15). */
const forgetPeerFilesTombstones = (
  services: ShareLinkServices,
  project: Project,
  peer: PersonalShareContent,
) =>
  forgetPreLinkTombstones(
    services.histories,
    project.id,
    peer.memory.files.map((file) => file.name),
  ).pipe(Effect.mapError(failed("merge")));

/**
 * The joining seat (D-15): its copies once per series, the automatic merge
 * against the link's files and index, the link's shared settings, and only
 * then the link itself. `peer` is the starter or a linked member.
 */
export const joinLink = (
  services: ShareLinkServices,
  input: {
    readonly project: Project;
    readonly selfEnvironmentId: EnvironmentId;
    readonly machineLabel: string;
    readonly linkId: string;
    readonly title: string;
    readonly peer: PersonalShareContent;
    readonly nowIso: string;
    /** When the owner last turned this seat's switch on: a series begins there. */
    readonly switchedOnAt?: string;
  },
) =>
  Effect.gen(function* () {
    const copies = yield* ensureSeriesCopies(services, input.project, input.switchedOnAt);
    yield* autoMergeJoiningSeat(services, {
      projectId: input.project.id,
      link: { files: input.peer.memory.files, index: input.peer.memory.index },
      machineLabel: input.machineLabel,
      environmentId: input.selfEnvironmentId,
      localOnly: localOnlyMemorySet(input.project.workspaceSettings),
    }).pipe(Effect.mapError(failed("merge")));
    yield* takeLinkSettings(
      services,
      yield* reload(services, input.project),
      input.peer,
      input.title,
    );
    const project = yield* reload(services, input.project);
    const self = selfMemberFor(project, input.selfEnvironmentId);
    const members = membersWith(input.peer.link?.members ?? [input.peer.self], self);
    yield* writeJoin(
      services,
      project,
      { id: input.linkId, title: input.title, coordinatorId: self.coordinatorThreadId, members },
      input.nowIso,
      {},
    );
    return copies;
  });

/**
 * The starter's first link (D-15): the peer joined it, so the starter writes
 * the link the peer wrote, under its name, and stamps its own shared settings
 * as the link's. It merges nothing; its copies are saved once like any seat's.
 */
export const startLink = (
  services: ShareLinkServices,
  input: {
    readonly project: Project;
    readonly selfEnvironmentId: EnvironmentId;
    readonly linkId: string;
    readonly peer: PersonalShareContent;
    readonly nowIso: string;
    /** When the owner last turned this seat's switch on: a series begins there. */
    readonly switchedOnAt?: string;
  },
) =>
  Effect.gen(function* () {
    const link = input.peer.link;
    if (link === null || link.id !== input.linkId)
      return yield* new PersonalShareLinkError({ stage: "write" });
    const copies = yield* ensureSeriesCopies(services, input.project, input.switchedOnAt);
    yield* forgetPeerFilesTombstones(services, input.project, input.peer);
    const project = yield* reload(services, input.project);
    const self = selfMemberFor(project, input.selfEnvironmentId);
    yield* writeJoin(
      services,
      project,
      {
        id: link.id,
        title: link.title,
        coordinatorId: self.coordinatorThreadId,
        members: membersWith(link.members, self),
      },
      input.nowIso,
      { title: link.title, force: true },
    );
    return copies;
  });

/**
 * A linked seat lists a seat that joined its link (D-15): its members gain
 * the peer, nothing is renamed, and its shared settings are stamped now so the
 * link's settings, not the newcomer's, win the next sync.
 */
export const admitMember = (
  services: ShareLinkServices,
  input: {
    readonly project: Project;
    readonly peer: PersonalShareContent;
    readonly nowIso: string;
  },
) =>
  Effect.gen(function* () {
    const project = input.project;
    const settings = project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
    const identity = settings.logicalProject;
    if (identity === undefined) return yield* new PersonalShareLinkError({ stage: "write" });
    const peer = input.peer.self;
    if (identity.members.some((member) => member.environmentId === peer.environmentId)) return;
    yield* forgetPeerFilesTombstones(services, project, input.peer);
    const binding = settings.coordinatorBinding ?? { epoch: 0, state: "active" as const };
    yield* services.projects
      .update({
        projectId: project.id,
        commandId: CommandId.make(`percy-admit:${project.id}:${settings.revision}`),
        ownership: {
          mode: "link-member",
          expectedRevision: settings.revision,
          logicalProject: { ...identity, members: dedupe([...identity.members, peer]) },
          coordinatorBinding: bindingRelinking(binding, [peer], input.nowIso),
        },
        sharedStampMode: "force",
      })
      .pipe(Effect.mapError(failed("write")));
  });

/**
 * The seats a linked member lists that this seat does not (D-15): another
 * member admitted them, so this seat lists them too, as vouched for. A seat
 * this one removed stays removed: only a member that admits it again directly
 * brings it back.
 */
export const adoptMembers = (
  services: ShareLinkServices,
  input: {
    readonly project: Project;
    readonly peer: PersonalShareContent;
    readonly nowIso: string;
  },
) =>
  Effect.gen(function* () {
    const settings = input.project.workspaceSettings ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS;
    const identity = settings.logicalProject;
    const link = input.peer.link;
    if (identity === undefined || link === null || link.id !== identity.id) return false;
    const listed = new Set(identity.members.map((member) => member.environmentId as string));
    const removed = new Set(
      (settings.coordinatorBinding?.removedMembers ?? []).map(
        (entry) => entry.environmentId as string,
      ),
    );
    const added = dedupe(
      link.members.filter(
        (member) => !listed.has(member.environmentId) && !removed.has(member.environmentId),
      ),
    );
    if (added.length === 0) return false;
    const binding = settings.coordinatorBinding ?? { epoch: 0, state: "active" as const };
    yield* services.projects
      .update({
        projectId: input.project.id,
        commandId: CommandId.make(`percy-adopt:${input.project.id}:${settings.revision}`),
        ownership: {
          mode: "link-member",
          expectedRevision: settings.revision,
          logicalProject: { ...identity, members: [...identity.members, ...added] },
          coordinatorBinding: bindingRelinking(binding, added, input.nowIso),
        },
      })
      .pipe(Effect.mapError(failed("write")));
    return true;
  });

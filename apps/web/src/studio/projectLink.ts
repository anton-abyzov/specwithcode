import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  compareFingerprints,
  allocateNoteName,
  ProjectLinkError,
  logicalProjectMemberKey,
  type LogicalProjectMember,
  type ProjectLinkNote,
  type ProjectLinkNoteWrite,
  type EnvironmentId,
  type ProjectId,
  type ProjectLinkAcceptInput,
  type ProjectLinkAcceptResult,
  type ProjectLinkCommitInput,
  type ProjectLinkCommitResult,
  type ProjectLinkPrepareInput,
  type ProjectLinkPrepareResult,
  type ProjectLinkPreview,
  type ProjectLinkPreviewInput,
  type ProjectLinkRefusal,
  type ProjectUnlinkInput,
  type ProjectUnlinkResult,
  type RepositoryFingerprint,
  ThreadId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { isProjectFolder } from "./projectMachineFolders";
import { isOrdinaryProjectChoice, type ScratchRootLookup } from "./projectListVisibility";

export const projectLink = {
  fingerprint: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:fingerprint",
    tag: WS_METHODS.projectsFingerprint,
  }),
  preview: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:preview",
    tag: WS_METHODS.projectLinkPreview,
  }),
  prepare: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:prepare",
    tag: WS_METHODS.projectLinkPrepare,
  }),
  accept: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:accept",
    tag: WS_METHODS.projectLinkAccept,
  }),
  commit: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:commit",
    tag: WS_METHODS.projectLinkCommit,
  }),
  unlink: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:unlink",
    tag: WS_METHODS.projectUnlink,
  }),
  digest: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:digest",
    tag: WS_METHODS.projectLinkDigest,
  }),
  replicate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:replicate",
    tag: WS_METHODS.projectLinkReplicate,
  }),
  takeover: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:takeover",
    tag: WS_METHODS.projectTakeover,
  }),
  supersede: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:supersede",
    tag: WS_METHODS.projectSupersede,
  }),
  /** Runs this copy's own coordinator next to the others; nothing gives way. */
  startCoordinator: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-link:start-coordinator",
    tag: WS_METHODS.projectStartCoordinator,
  }),
};

/** How long the coordinator's machine must be unreachable before a member may take over. */
export const TAKEOVER_UNREACHABLE_MS = 10 * 60_000;

/**
 * Whether "Take over coordinator here" may be pressed: never while the
 * coordinator's machine is connected, and only after it has been unreachable
 * for 10 minutes. There is no automatic failover.
 */
export function takeoverAvailability(input: {
  readonly coordinatorConnected: boolean;
  /** When this device last saw the coordinator's machine, or first saw it gone. */
  readonly unreachableSince: number | null;
  readonly now: number;
}): { readonly available: boolean; readonly waitMs: number } {
  if (input.coordinatorConnected || input.unreachableSince === null)
    return { available: false, waitMs: TAKEOVER_UNREACHABLE_MS };
  const waitMs = Math.max(0, input.unreachableSince + TAKEOVER_UNREACHABLE_MS - input.now);
  return { available: waitMs === 0, waitMs };
}

/** The highest coordinator epoch among the copies the app sees; a takeover goes above it. */
export function highestEpoch(members: ReadonlyArray<EnvironmentProject>): number {
  return Math.max(0, ...members.map((m) => m.workspaceSettings?.coordinatorBinding?.epoch ?? 0));
}

const sameRef = (
  a: LogicalProjectMember,
  b: Pick<LogicalProjectMember, "environmentId" | "projectId">,
) => a.environmentId === b.environmentId && a.projectId === b.projectId;

export interface PendingSupersede {
  /** The copy that took over and is active now. */
  readonly successor: EnvironmentProject;
  /** The copy it replaced, still active on its own machine. */
  readonly previous: EnvironmentProject;
}

/**
 * Copies that a member took over from while they were unreachable and that
 * still think they coordinate: each must give way once both are reachable.
 */
export function pendingSupersedes(members: ReadonlyArray<EnvironmentProject>): PendingSupersede[] {
  const pending: PendingSupersede[] = [];
  for (const successor of members) {
    const binding = successor.workspaceSettings?.coordinatorBinding;
    if (binding?.state !== "active" || !binding.predecessor || !binding.takenOverAt) continue;
    const previous = members.find((candidate) =>
      sameRef(binding.predecessor!, {
        environmentId: candidate.environmentId,
        projectId: candidate.id,
      }),
    );
    const previousBinding = previous?.workspaceSettings?.coordinatorBinding;
    if (
      previous &&
      previous.workspaceSettings?.logicalProject?.id ===
        successor.workspaceSettings?.logicalProject?.id &&
      (previousBinding?.state ?? "active") === "active" &&
      (previousBinding?.epoch ?? 0) < binding.epoch
    )
      pending.push({ successor, previous });
  }
  return pending;
}

/** Member copies that keep a replica of the coordinator's notes, goal and instructions. */
export function replicaMembers(
  coordinator: EnvironmentProject,
  members: ReadonlyArray<EnvironmentProject>,
): EnvironmentProject[] {
  const identity = coordinator.workspaceSettings?.logicalProject?.id;
  return members.filter(
    (member) =>
      member !== coordinator &&
      member.environmentId !== coordinator.environmentId &&
      member.workspaceSettings?.logicalProject?.id === identity &&
      member.workspaceSettings?.coordinatorBinding?.state === "transferred",
  );
}

/** Whether a machine can take part in a link: connected, new enough and permitted. */
export type LinkMachineState = "ready" | "offline" | "update" | "permission";

export function linkMachineState(input: {
  readonly connected: boolean;
  readonly supportsLink: boolean | undefined;
  readonly canWrite: boolean;
}): LinkMachineState {
  if (!input.connected) return "offline";
  if (input.supportsLink !== true) return "update";
  return input.canWrite ? "ready" : "permission";
}

export function linkMachineProblem(state: LinkMachineState, machine: string): string | null {
  switch (state) {
    case "ready":
      return null;
    case "offline":
      return `Connect ${machine} first.`;
    case "update":
      return `Update SpecWithCode on ${machine} to link projects.`;
    case "permission":
      return `This app's connection to ${machine} needs permission to change settings and run work.`;
  }
}

export const LINK_REFUSAL_TEXT: Record<ProjectLinkRefusal, (machine: string) => string> = {
  already_shared: (machine) =>
    `The copy on ${machine} is already shared with other machines. Unlink it there first.`,
  not_coordinator: (machine) =>
    `The copy on ${machine} does not hold its coordinator, so it cannot be the one that stays.`,
  handoff_in_progress: (machine) =>
    `A coordinator handoff is in progress on ${machine}. Finish or retry it first.`,
  paused: (machine) => `The project on ${machine} is paused. Resume it first.`,
  archived: (machine) => `The project on ${machine} is archived. Restore it first.`,
  not_code_project: () => "Only code projects can be linked across machines.",
  coordinator_busy: (machine) =>
    `The coordinator on ${machine} is working. Let it finish or stop it, then link.`,
};

export interface LinkCandidate {
  readonly project: EnvironmentProject;
  /** Null until compared, or when the folder could not be read. */
  readonly score: number | null;
  readonly rootMatches: boolean | null;
  readonly summary: string | null;
}

/** Cheap first pass: the same repository or the same name earns a fingerprint comparison. */
export function looksLikeSameProject(
  here: Pick<EnvironmentProject, "title" | "repositoryIdentity" | "workspaceRoot">,
  there: Pick<EnvironmentProject, "title" | "repositoryIdentity" | "workspaceRoot">,
  groupingKey: (project: Pick<EnvironmentProject, "repositoryIdentity">) => string | null,
): boolean {
  const key = groupingKey(here);
  const folder = (path: string) =>
    path
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop()
      ?.toLowerCase();
  return (
    (key !== null && key === groupingKey(there)) ||
    here.title.trim().toLowerCase() === there.title.trim().toLowerCase() ||
    folder(here.workspaceRoot) === folder(there.workspaceRoot)
  );
}

/** "Root repository and 28 of 36 repositories match", or why not. */
export function fingerprintSummary(
  here: RepositoryFingerprint,
  there: RepositoryFingerprint,
): { score: number; rootMatches: boolean; summary: string } {
  const comparison = compareFingerprints(here, there);
  const total = there.repositories.length;
  const root =
    here.root === "repository" && there.root === "repository"
      ? comparison.rootMatches
        ? "Same root repository"
        : "Different root repositories"
      : here.root === "folder" && there.root === "folder"
        ? "Both are folders of repositories"
        : "One folder is a repository, the other is not";
  const shared = `${comparison.shared} of ${total} ${total === 1 ? "repository" : "repositories"} match`;
  const missing =
    comparison.missingHere.length > 0 ? `, ${comparison.missingHere.length} missing here` : "";
  return {
    score: comparison.score,
    rootMatches: comparison.rootMatches,
    summary: `${root}; ${shared}${missing}.`,
  };
}

export function rankCandidates(candidates: ReadonlyArray<LinkCandidate>): LinkCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      (b.score ?? -1) - (a.score ?? -1) ||
      a.project.title.localeCompare(b.project.title) ||
      a.project.environmentId.localeCompare(b.project.environmentId),
  );
}

/**
 * The copies on other machines the link dialog offers: the person's own code projects,
 * never a machine's "No project" folder, an archived or an automated project. A copy
 * already in this project is listed in Machines, not offered again. The named copy
 * (a half-linked copy being finished, or one just added) is always offered.
 */
export function linkCandidates<P extends EnvironmentProject>(
  projects: ReadonlyArray<P>,
  project: Pick<EnvironmentProject, "environmentId" | "workspaceSettings">,
  scratchRootFor: ScratchRootLookup,
  initialCandidate: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null,
): P[] {
  const ownIdentity = project.workspaceSettings?.logicalProject?.id;
  return projects.filter((item) => {
    if (item.environmentId === project.environmentId) return false;
    if (!isProjectFolder(item.workspaceRoot, item.id)) return false;
    if ((item.workspaceSettings?.kind ?? "code") !== "code") return false;
    const named =
      initialCandidate !== null &&
      item.environmentId === initialCandidate.environmentId &&
      item.id === initialCandidate.projectId;
    if (named) return true;
    return (
      isOrdinaryProjectChoice(item, scratchRootFor, "code") &&
      (ownIdentity === undefined || item.workspaceSettings?.logicalProject?.id !== ownIdentity)
    );
  });
}

/** The copy that keeps its coordinator by default: the one used most recently. */
export function defaultKeptSide(
  here: Pick<ProjectLinkPreview, "lastCoordinatorActivityAt" | "keepRefusal">,
  there: Pick<ProjectLinkPreview, "lastCoordinatorActivityAt" | "keepRefusal">,
): "here" | "there" {
  if (here.keepRefusal && !there.keepRefusal) return "there";
  if (there.keepRefusal && !here.keepRefusal) return "here";
  const time = (value: string | null) => (value === null ? 0 : Date.parse(value) || 0);
  return time(there.lastCoordinatorActivityAt) > time(here.lastCoordinatorActivityAt)
    ? "there"
    : "here";
}

export type NoteChoice = "kept" | "joining" | "both";
export interface NoteMergeRow {
  readonly name: string;
  readonly kept: ProjectLinkNote | null;
  readonly joining: ProjectLinkNote | null;
  /** `copy`: only on the joining copy; `conflict`: same name, different text. */
  readonly kind: "copy" | "same" | "conflict" | "kept-only";
}

export function noteMergeRows(
  kept: ReadonlyArray<ProjectLinkNote>,
  joining: ReadonlyArray<ProjectLinkNote>,
): NoteMergeRow[] {
  const names = [...new Set([...kept, ...joining].map((note) => note.name))].sort((a, b) =>
    a.localeCompare(b),
  );
  return names.map((name) => {
    const left = kept.find((note) => note.name === name) ?? null;
    const right = joining.find((note) => note.name === name) ?? null;
    return {
      name,
      kept: left,
      joining: right,
      kind: !left
        ? "copy"
        : !right
          ? "kept-only"
          : left.content === right.content
            ? "same"
            : "conflict",
    };
  });
}

/** Every conflict needs a choice; nothing is overwritten without one. */
export function noteMergeComplete(
  rows: ReadonlyArray<NoteMergeRow>,
  choices: Readonly<Record<string, NoteChoice>>,
): boolean {
  return rows.every((row) => row.kind !== "conflict" || choices[row.name] !== undefined);
}

/** Adds a kept-both copy under the first name that holds nothing else, never replacing a note. */
function pushKeptBoth(
  writes: ProjectLinkNoteWrite[],
  taken: Map<string, string>,
  base: string,
  content: string,
  machine: string,
): void {
  const name = allocateNoteName({ base, suffix: machine, content, taken });
  if (name === null)
    throw new ProjectLinkError({
      code: "too_large",
      detail: `Too many copies of "${base}" already exist.`,
    });
  // The same text already lands there in this batch.
  if (writes.some((write) => write.name === name)) return;
  writes.push({ name, content, expectedRevision: null, createOnly: true });
}

/** The notes to write into the kept copy. The joining copy keeps its own notes as they were. */
export function noteWrites(
  rows: ReadonlyArray<NoteMergeRow>,
  choices: Readonly<Record<string, NoteChoice>>,
  joiningMachine: string,
  keptNotes: ReadonlyArray<ProjectLinkNote>,
): ProjectLinkNoteWrite[] {
  const writes: ProjectLinkNoteWrite[] = [];
  for (const row of rows) {
    if (row.kind === "copy" && row.joining)
      writes.push({ name: row.name, content: row.joining.content, expectedRevision: null });
    if (row.kind === "conflict" && row.joining && row.kept && choices[row.name] === "joining")
      writes.push({
        name: row.name,
        content: row.joining.content,
        expectedRevision: row.kept.revision,
      });
  }
  // Every name the kept copy holds once these writes land, with its text.
  const taken = new Map(keptNotes.map((note) => [note.name, note.content]));
  for (const write of writes) taken.set(write.name, write.content);
  for (const row of rows)
    if (row.kind === "conflict" && row.joining && row.kept && choices[row.name] === "both")
      pushKeptBoth(writes, taken, row.name, row.joining.content, joiningMachine);
  return writes;
}

/**
 * Notes an unlinking member copies from the kept copy: the ones it lacks, and a
 * second, named copy of any it holds with different text. Its own are never replaced.
 */
export function unlinkNoteWrites(
  kept: ReadonlyArray<ProjectLinkNote>,
  member: ReadonlyArray<ProjectLinkNote>,
  keptMachine: string,
): ProjectLinkNoteWrite[] {
  const writes: ProjectLinkNoteWrite[] = [];
  for (const note of kept)
    if (!member.some((candidate) => candidate.name === note.name))
      writes.push({ name: note.name, content: note.content, expectedRevision: null });
  const taken = new Map(member.map((note) => [note.name, note.content]));
  for (const write of writes) taken.set(write.name, write.content);
  for (const note of kept) {
    const own = member.find((candidate) => candidate.name === note.name);
    if (own && own.content !== note.content)
      pushKeptBoth(writes, taken, note.name, note.content, keptMachine);
  }
  return writes;
}

/** The member entry a copy is listed under; identities list their coordinator thread. */
export function linkMemberOf(project: EnvironmentProject): LogicalProjectMember {
  return (
    project.workspaceSettings?.logicalProject?.members.find(
      (member) => member.environmentId === project.environmentId && member.projectId === project.id,
    ) ?? {
      environmentId: project.environmentId,
      projectId: project.id,
      coordinatorThreadId:
        project.workspaceSettings?.coordinatorThreadId ??
        ThreadId.make(`project-coordinator:${project.id}`),
    }
  );
}

export type CopyRole = "coordinator" | "workers" | "pending";
export interface LinkedCopy {
  readonly project: EnvironmentProject;
  readonly role: CopyRole;
  /** It joined, but the coordinator does not list it yet: the link's last step is missing. */
  readonly unfinished: boolean;
}

/**
 * Each copy of a shared project, in one sidebar group, and what it does. Every
 * machine may run its own coordinator (0969), so `others` lists the copies that
 * coordinate next to the newest one.
 */
export function linkedCopies(
  members: ReadonlyArray<EnvironmentProject>,
  coordinator: EnvironmentProject | undefined,
  others: ReadonlyArray<EnvironmentProject> = [],
): LinkedCopy[] {
  const listed = new Set(
    (coordinator?.workspaceSettings?.logicalProject?.members ?? []).map(logicalProjectMemberKey),
  );
  const coordinating = new Set(
    [coordinator, ...others].flatMap((item) => (item ? [`${item.environmentId}:${item.id}`] : [])),
  );
  return members.map((project) => {
    const isCoordinator = coordinating.has(`${project.environmentId}:${project.id}`);
    return {
      project,
      role: isCoordinator
        ? "coordinator"
        : project.workspaceSettings?.coordinatorBinding?.state === "transferring"
          ? "pending"
          : "workers",
      unfinished:
        !isCoordinator &&
        coordinator !== undefined &&
        !listed.has(logicalProjectMemberKey(linkMemberOf(project))),
    };
  });
}

/**
 * Copies the coordinator still lists that now belong to another identity: they
 * unlinked while this machine was away. Removing them finishes that unlink.
 */
export function departedMembers(
  coordinator: EnvironmentProject,
  projects: ReadonlyArray<EnvironmentProject>,
): EnvironmentProject[] {
  const identity = coordinator.workspaceSettings?.logicalProject;
  if (!identity) return [];
  return identity.members.flatMap((member) => {
    if (member.environmentId === coordinator.environmentId && member.projectId === coordinator.id)
      return [];
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === member.environmentId && candidate.id === member.projectId,
    );
    return project && project.workspaceSettings?.logicalProject?.id !== identity.id
      ? [project]
      : [];
  });
}

/** One retry pointer per pair of copies; the plan itself lives on the machines. */
export const projectLinkStorageKey = (kept: LogicalProjectMember, joining: LogicalProjectMember) =>
  `studio:project-link:v1:${JSON.stringify([
    kept.environmentId,
    kept.projectId,
    joining.environmentId,
    joining.projectId,
  ])}`;

const OPERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function readPendingOperation(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    return value !== null && OPERATION.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writePendingOperation(key: string, operationId: string | null): void {
  try {
    if (operationId === null) localStorage.removeItem(key);
    else localStorage.setItem(key, operationId);
  } catch {
    /* Without storage a retry starts a new operation; every step is still idempotent by state. */
  }
}

const sameMember = (a: LogicalProjectMember, b: LogicalProjectMember) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId;

/** The joining copy already defers to the kept one: an earlier link stopped before its last step. */
export function linkIsResuming(kept: ProjectLinkPreview, joining: ProjectLinkPreview): boolean {
  const binding = joining.coordinatorBinding;
  return (
    kept.logicalProject !== null &&
    joining.logicalProject?.id === kept.logicalProject.id &&
    binding?.state === "transferred" &&
    binding.successor !== undefined &&
    sameMember(binding.successor, kept.member)
  );
}

type LinkCall<I, A> = (args: {
  readonly environmentId: EnvironmentId;
  readonly input: I;
}) => Promise<AtomCommandResult<A, unknown>>;

export interface LinkCommands {
  readonly preview: LinkCall<ProjectLinkPreviewInput, ProjectLinkPreview>;
  readonly prepare: LinkCall<ProjectLinkPrepareInput, ProjectLinkPrepareResult>;
  readonly accept: LinkCall<ProjectLinkAcceptInput, ProjectLinkAcceptResult>;
  readonly commit: LinkCall<ProjectLinkCommitInput, ProjectLinkCommitResult>;
}

export type CopyLinkOutcome =
  | { readonly status: "linked" }
  /** Linking needs the person: a refusal, a different repository or notes to merge. */
  | { readonly status: "review"; readonly reason: string };

/**
 * Links a fresh copy as a member that runs workers, with the coordinator staying
 * on the kept copy. Choosing "Copy files only" is the consent; anything that needs
 * a choice (notes that differ, a refusal) is left to the link dialog.
 */
export async function linkCopyAsWorkers(
  commands: LinkCommands,
  input: {
    readonly kept: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
    readonly joining: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
    readonly keptLabel: string;
    readonly joiningLabel: string;
    readonly newOperationId: () => string;
  },
): Promise<CopyLinkOutcome> {
  const unwrap = <A>(result: AtomCommandResult<A, unknown>): A => {
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const [kept, joining] = await Promise.all([
    commands
      .preview({
        environmentId: input.kept.environmentId,
        input: { projectId: input.kept.projectId },
      })
      .then(unwrap),
    commands
      .preview({
        environmentId: input.joining.environmentId,
        input: { projectId: input.joining.projectId },
      })
      .then(unwrap),
  ]);
  const resuming = linkIsResuming(kept, joining);
  if (kept.keepRefusal)
    return { status: "review", reason: LINK_REFUSAL_TEXT[kept.keepRefusal](input.keptLabel) };
  if (joining.joinRefusal && !resuming)
    return { status: "review", reason: LINK_REFUSAL_TEXT[joining.joinRefusal](input.joiningLabel) };
  if (!fingerprintSummary(joining.fingerprint, kept.fingerprint).rootMatches)
    return { status: "review", reason: "The copy's repository does not match the source." };
  const rows = noteMergeRows(kept.notes, joining.notes);
  if (joining.notesTruncated || rows.some((row) => row.kind === "conflict"))
    return { status: "review", reason: `Project notes differ on ${input.joiningLabel}.` };
  const storageKey = projectLinkStorageKey(kept.member, joining.member);
  const operationId = readPendingOperation(storageKey) ?? input.newOperationId();
  writePendingOperation(storageKey, operationId);
  const prepared = unwrap(
    await commands.prepare({
      environmentId: input.kept.environmentId,
      input: { operationId, projectId: input.kept.projectId, joining: joining.member },
    }),
  );
  const accepted = unwrap(
    await commands.accept({
      environmentId: input.joining.environmentId,
      input: {
        operationId,
        projectId: input.joining.projectId,
        kept: prepared.kept,
        logicalProject: prepared.logicalProject,
        coordinatorBinding: prepared.coordinatorBinding,
        keptFingerprint: prepared.fingerprint,
      },
    }),
  );
  unwrap(
    await commands.commit({
      environmentId: input.kept.environmentId,
      input: {
        operationId,
        projectId: input.kept.projectId,
        joining: accepted.member,
        notes: noteWrites(rows, {}, input.joiningLabel, kept.notes),
      },
    }),
  );
  writePendingOperation(storageKey, null);
  return { status: "linked" };
}

/**
 * Takes back a link Add to another machine made, when its copy is undone: the
 * copy leaves first, then the kept project drops it from its members. The copy
 * keeps its own notes; nothing is copied into it, since it is returning to how
 * it was before the link.
 */
export async function unlinkUndoneCopy(
  commands: {
    readonly preview: LinkCall<ProjectLinkPreviewInput, ProjectLinkPreview>;
    readonly unlink: LinkCall<ProjectUnlinkInput, ProjectUnlinkResult>;
  },
  input: {
    readonly kept: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
    readonly joining: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
    readonly newOperationId: () => string;
  },
): Promise<void> {
  const unwrap = <A>(result: AtomCommandResult<A, unknown>): A => {
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const joining = unwrap(
    await commands.preview({
      environmentId: input.joining.environmentId,
      input: { projectId: input.joining.projectId },
    }),
  );
  const operationId = input.newOperationId();
  unwrap(
    await commands.unlink({
      environmentId: input.joining.environmentId,
      input: { side: "member", operationId, projectId: input.joining.projectId, notes: [] },
    }),
  );
  unwrap(
    await commands.unlink({
      environmentId: input.kept.environmentId,
      input: {
        side: "coordinator",
        operationId,
        projectId: input.kept.projectId,
        member: joining.member,
      },
    }),
  );
}

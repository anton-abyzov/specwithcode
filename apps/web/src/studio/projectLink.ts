import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  compareFingerprints,
  keepBothNoteName,
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
  type RepositoryFingerprint,
  ThreadId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

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
};

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
    if (row.kind !== "conflict" || !row.joining || !row.kept) continue;
    const choice = choices[row.name];
    if (choice === "joining")
      writes.push({
        name: row.name,
        content: row.joining.content,
        expectedRevision: row.kept.revision,
      });
    if (choice === "both") {
      const name = keepBothNoteName(row.name, joiningMachine);
      writes.push({
        name,
        content: row.joining.content,
        expectedRevision: keptNotes.find((note) => note.name === name)?.revision ?? null,
      });
    }
  }
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
  for (const note of kept) {
    const own = member.find((candidate) => candidate.name === note.name);
    if (!own) writes.push({ name: note.name, content: note.content, expectedRevision: null });
    else if (own.content !== note.content) {
      const name = keepBothNoteName(note.name, keptMachine);
      writes.push({
        name,
        content: note.content,
        expectedRevision: member.find((candidate) => candidate.name === name)?.revision ?? null,
      });
    }
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

/** Each copy of a shared project, in one sidebar group, and what it does. */
export function linkedCopies(
  members: ReadonlyArray<EnvironmentProject>,
  coordinator: EnvironmentProject | undefined,
): LinkedCopy[] {
  const listed = new Set(
    (coordinator?.workspaceSettings?.logicalProject?.members ?? []).map(logicalProjectMemberKey),
  );
  return members.map((project) => {
    const isCoordinator =
      coordinator !== undefined &&
      project.environmentId === coordinator.environmentId &&
      project.id === coordinator.id;
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

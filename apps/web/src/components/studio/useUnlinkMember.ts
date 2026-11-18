import { useRef, useState } from "react";
import {
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  coordinatorMayLeave,
  logicalProjectMemberKey,
  type EnvironmentId,
  type ProjectLinkNoteWrite,
  type ProjectLinkPreview,
  type ProjectLinkPreviewInput,
  type ProjectUnlinkInput,
} from "@specweave-studio/contracts";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  linkMemberOf,
  projectLink,
  projectLinkStorageKey,
  readPendingOperation,
  unlinkNoteWrites,
  writePendingOperation,
} from "../../studio/projectLink";
import { useLinkMachines } from "./useLinkMachines";

/**
 * Whether a linked machine that runs a coordinator of its own may leave the link
 * (`coordinatorMayLeave`), and which loaded machine stops it: one that names it as its
 * coordinator's successor would be left with none.
 */
export function unlinkGuard(
  project: EnvironmentProject,
  shared: readonly EnvironmentProject[],
): { readonly allowed: boolean; readonly follower: EnvironmentProject | null } {
  const settings = project.workspaceSettings;
  if (
    !coordinatorMayLeave(
      settings?.coordinatorBinding,
      settings?.logicalProject?.members.length ?? 0,
    )
  )
    return { allowed: false, follower: null };
  const key = logicalProjectMemberKey(linkMemberOf(project));
  const follower =
    shared.find((other) => {
      const successor = other.workspaceSettings?.coordinatorBinding?.successor;
      return successor !== undefined && logicalProjectMemberKey(successor) === key;
    }) ?? null;
  return { allowed: follower === null, follower };
}

/** A coordinator started beside the project's may leave the link, unless a machine follows it. */
export const mayLeave = (project: EnvironmentProject, shared: readonly EnvironmentProject[]) =>
  unlinkGuard(project, shared).allowed;

type Call<I, A> = (args: {
  readonly environmentId: EnvironmentId;
  readonly input: I;
}) => Promise<AtomCommandResult<A, unknown>>;

export interface UnlinkRun {
  /** The machine that leaves the project. */
  readonly member: EnvironmentProject;
  /** The machine that keeps the project's coordinator. */
  readonly coordinator: EnvironmentProject;
  /** Every loaded machine of the project. */
  readonly shared: readonly EnvironmentProject[];
  readonly label: (environmentId: EnvironmentId) => string;
  /** The coordinator's machine is connected and may be written to now. */
  readonly keptReady: boolean;
  readonly preview: Call<ProjectLinkPreviewInput, ProjectLinkPreview>;
  readonly unlink: Call<ProjectUnlinkInput, unknown>;
  readonly newOperationId: () => string;
  /** The operation id of an unlink that did not finish, kept so a retry replays it. */
  readonly pending: {
    readonly read: (key: string) => string | null;
    readonly write: (key: string, operationId: string | null) => void;
  };
}

/**
 * Unlinks `member` from its project: its notes are copied when the coordinator's machine
 * is connected, the machine leaves (with its own coordinator when the guard allows that),
 * then the coordinator's machine drops it from its list. Returns what to tell the person;
 * a failure throws its cause, and the pending operation stays for a retry.
 */
export async function runUnlink(run: UnlinkRun): Promise<string> {
  const { member, coordinator } = run;
  const memberRef = linkMemberOf(member);
  const keptRef = linkMemberOf(coordinator);
  const storageKey = `${projectLinkStorageKey(keptRef, memberRef)}:unlink`;
  const memberLabel = run.label(member.environmentId);
  const keptLabel = run.label(coordinator.environmentId);
  const leaving = mayLeave(member, run.shared);
  const operationId = run.pending.read(storageKey) ?? run.newOperationId();
  run.pending.write(storageKey, operationId);
  let notes: ProjectLinkNoteWrite[] = [];
  if (run.keptReady) {
    const [kept, own] = await Promise.all([
      run.preview({
        environmentId: coordinator.environmentId,
        input: { projectId: coordinator.id },
      }),
      run.preview({ environmentId: member.environmentId, input: { projectId: member.id } }),
    ]);
    if (kept._tag === "Failure") throw squashAtomCommandFailure(kept);
    if (own._tag === "Failure") throw squashAtomCommandFailure(own);
    notes = unlinkNoteWrites(kept.value.notes, own.value.notes, keptLabel);
  }
  const left = await run.unlink({
    environmentId: member.environmentId,
    input: {
      side: "member",
      operationId,
      projectId: member.id,
      notes,
      ...(leaving ? { leaveCoordinator: true } : {}),
    } as ProjectUnlinkInput,
  });
  if (left._tag === "Failure") {
    const cause = squashAtomCommandFailure(left);
    // An older app there refuses a running coordinator however it is asked.
    if (leaving && (cause as { code?: unknown }).code === "not_linked")
      throw new Error(`Update SpecWithCode on ${memberLabel} to unlink it.`);
    throw cause;
  }
  if (!run.keptReady) {
    run.pending.write(storageKey, null);
    return `${memberLabel} has its own coordinator again. Its notes were not copied because ${keptLabel} is not connected. Connect ${keptLabel} and remove ${memberLabel} there.`;
  }
  const removed = await run.unlink({
    environmentId: coordinator.environmentId,
    input: {
      side: "coordinator",
      operationId,
      projectId: coordinator.id,
      member: memberRef,
    } as ProjectUnlinkInput,
  });
  if (removed._tag === "Failure") throw squashAtomCommandFailure(removed);
  run.pending.write(storageKey, null);
  return `${memberLabel} has its own coordinator again, with a copy of this project's notes.`;
}

/**
 * The unlink of a project's machine settings, shared with "Fix…" on a machine that runs an
 * extra coordinator. One unlink runs at a time; `unlink` resolves with what to say.
 */
export function useUnlinkMember(): {
  readonly busy: boolean;
  readonly unlink: (input: {
    readonly member: EnvironmentProject;
    readonly coordinator: EnvironmentProject;
    readonly shared: readonly EnvironmentProject[];
  }) => Promise<{ readonly text: string; readonly error: boolean } | null>;
} {
  const machines = useLinkMachines();
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const unlinkCommand = useAtomCommand(projectLink.unlink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const unlink = async (input: {
    readonly member: EnvironmentProject;
    readonly coordinator: EnvironmentProject;
    readonly shared: readonly EnvironmentProject[];
  }) => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    return runUnlink({
      ...input,
      label: machines.label,
      keptReady: machines.state(input.coordinator.environmentId) === "ready",
      preview,
      unlink: unlinkCommand,
      newOperationId: randomUUID,
      pending: { read: readPendingOperation, write: writePendingOperation },
    })
      .then(
        (text) => ({ text, error: false }),
        (cause: unknown) => ({
          text:
            cause instanceof Error && cause.message
              ? cause.message
              : "Unlink did not finish. Retry it.",
          error: true,
        }),
      )
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };
  return { busy, unlink };
}

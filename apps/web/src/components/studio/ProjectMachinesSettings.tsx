import { useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { ProjectLinkNoteWrite } from "@specweave-studio/contracts";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { logicalCoordinator } from "../../studio/projectDomain";
import {
  departedMembers,
  linkedCopies,
  linkMemberOf,
  projectLink,
  projectLinkStorageKey,
  readPendingOperation,
  unlinkNoteWrites,
  writePendingOperation,
  type LinkedCopy,
} from "../../studio/projectLink";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { ProjectLocation } from "./ProjectLocation";
import { ProjectLinkDialog, type ProjectLinkTarget } from "./ProjectLinkDialog";
import { useHoldProjectKeyFollow } from "../settings/projectKeyFollow";
import { useLinkMachines } from "./useLinkMachines";

const ROLE_TEXT: Record<LinkedCopy["role"], string> = {
  coordinator: "Coordinator. Plans the work and can send it to every copy.",
  workers: "Runs workers. Its own coordinator is read-only history.",
  pending: "Coordinator handoff pending.",
};

const failureMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/**
 * Settings > Project > Machines: every machine's copy of this project, what it
 * does, and the link and unlink actions. Copies of a shared project are listed by
 * their identity; a project without one has only itself until it is linked.
 */
export function ProjectMachinesSettings({
  members,
}: {
  readonly members: ReadonlyArray<EnvironmentProject>;
}) {
  const projects = useProjects();
  const machines = useLinkMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const unlink = useAtomCommand(projectLink.unlink, { reportFailure: false });
  const [dialog, setDialog] = useState<{
    readonly project: EnvironmentProject;
    readonly candidate: ProjectLinkTarget | null;
    readonly kept?: "here";
    readonly autoReview: boolean;
  } | null>(null);
  const [confirm, setConfirm] = useState<EnvironmentProject | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const running = useRef(false);
  useHoldProjectKeyFollow(dialog !== null);

  const shared = members.filter((member) => member.workspaceSettings?.logicalProject);
  const coordinator = logicalCoordinator(shared)?.member;
  const copies = shared.length > 0 ? linkedCopies(shared, coordinator) : [];
  const departed = useMemo(
    () => (coordinator ? departedMembers(coordinator, projects) : []),
    [coordinator, projects],
  );
  // New links start from the copy that keeps its coordinator, or from this machine's copy.
  const ready = (member: EnvironmentProject) => machines.state(member.environmentId) === "ready";
  const anchor =
    coordinator ??
    members.find((member) => member.environmentId === primaryEnvironmentId && ready(member)) ??
    members.find(ready) ??
    members[0];
  const coordinatorLabel = coordinator ? machines.label(coordinator.environmentId) : null;

  const unlinkMember = async (member: EnvironmentProject) => {
    if (running.current || !coordinator) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    const memberRef = linkMemberOf(member);
    const keptRef = linkMemberOf(coordinator);
    const storageKey = `${projectLinkStorageKey(keptRef, memberRef)}:unlink`;
    const memberLabel = machines.label(member.environmentId);
    const keptLabel = machines.label(coordinator.environmentId);
    try {
      const operationId = readPendingOperation(storageKey) ?? randomUUID();
      writePendingOperation(storageKey, operationId);
      const keptReady = machines.state(coordinator.environmentId) === "ready";
      let notes: ProjectLinkNoteWrite[] = [];
      if (keptReady) {
        const [kept, own] = await Promise.all([
          preview({
            environmentId: coordinator.environmentId,
            input: { projectId: coordinator.id },
          }),
          preview({ environmentId: member.environmentId, input: { projectId: member.id } }),
        ]);
        if (kept._tag === "Failure") throw squashAtomCommandFailure(kept);
        if (own._tag === "Failure") throw squashAtomCommandFailure(own);
        notes = unlinkNoteWrites(kept.value.notes, own.value.notes, keptLabel);
      }
      const left = await unlink({
        environmentId: member.environmentId,
        input: { side: "member", operationId, projectId: member.id, notes },
      });
      if (left._tag === "Failure") throw squashAtomCommandFailure(left);
      if (!keptReady) {
        writePendingOperation(storageKey, null);
        setMessage({
          text: `${memberLabel} has its own coordinator again. Its notes were not copied because ${keptLabel} is not connected. Connect ${keptLabel} and remove the copy there.`,
          error: false,
        });
        return;
      }
      const removed = await unlink({
        environmentId: coordinator.environmentId,
        input: { side: "coordinator", operationId, projectId: coordinator.id, member: memberRef },
      });
      if (removed._tag === "Failure") throw squashAtomCommandFailure(removed);
      writePendingOperation(storageKey, null);
      setMessage({
        text: `${memberLabel} has its own coordinator again, with a copy of this project's notes.`,
        error: false,
      });
    } catch (cause) {
      setMessage({ text: failureMessage(cause, "Unlink did not finish. Retry it."), error: true });
    } finally {
      running.current = false;
      setBusy(false);
      setConfirm(null);
    }
  };

  const removeDeparted = async (member: EnvironmentProject) => {
    if (running.current || !coordinator) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const removed = await unlink({
        environmentId: coordinator.environmentId,
        input: {
          side: "coordinator",
          operationId: randomUUID(),
          projectId: coordinator.id,
          member: coordinator.workspaceSettings!.logicalProject!.members.find(
            (ref) => ref.environmentId === member.environmentId && ref.projectId === member.id,
          )!,
        },
      });
      if (removed._tag === "Failure") throw squashAtomCommandFailure(removed);
      setMessage({
        text: `Removed the copy on ${machines.label(member.environmentId)}.`,
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: failureMessage(cause, "The copy was not removed. Retry it."),
        error: true,
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  if (!anchor) return null;
  const coordinatorProblem = coordinator ? machines.problem(coordinator.environmentId) : null;
  return (
    <SettingsSection title="Machines">
      {copies.map((copy) => {
        const label = machines.label(copy.project.environmentId);
        const problem = machines.problem(copy.project.environmentId);
        return (
          <SettingsRow
            key={`${copy.project.environmentId}:${copy.project.id}`}
            data-project-copy=""
            title={label}
            description={
              <>
                <ProjectLocation path={copy.project.workspaceRoot} />
                <span className="block">{ROLE_TEXT[copy.role]}</span>
                {copy.unfinished && (
                  <span className="block">
                    Joined, but {coordinatorLabel} does not list it yet. Finish linking so the
                    coordinator can send it work.
                  </span>
                )}
              </>
            }
            control={
              copy.unfinished ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || coordinatorProblem !== null || problem !== null}
                  title={coordinatorProblem ?? problem ?? undefined}
                  onClick={() =>
                    coordinator &&
                    setDialog({
                      project: coordinator,
                      candidate: {
                        environmentId: copy.project.environmentId,
                        projectId: copy.project.id,
                      },
                      kept: "here",
                      autoReview: true,
                    })
                  }
                >
                  Finish linking
                </Button>
              ) : copy.role === "workers" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || problem !== null}
                  title={problem ?? undefined}
                  onClick={() => setConfirm(copy.project)}
                  aria-label={`Unlink the copy on ${label}`}
                >
                  Unlink
                </Button>
              ) : null
            }
          />
        );
      })}
      {departed.map((member) => (
        <SettingsRow
          key={`departed:${member.environmentId}:${member.id}`}
          title={machines.label(member.environmentId)}
          description={`This copy was unlinked on ${machines.label(member.environmentId)}. Remove it from ${coordinatorLabel}'s list.`}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy || coordinatorProblem !== null}
              title={coordinatorProblem ?? undefined}
              onClick={() => void removeDeparted(member)}
            >
              Remove
            </Button>
          }
        />
      ))}
      <SettingsRow
        title="Link with a project on another machine"
        description={
          copies.length > 1
            ? "Add another machine's copy. The coordinator here stays; that copy runs workers."
            : "Make this project and its copy on another machine one project. One coordinator stays; the other copy runs workers."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || machines.problem(anchor.environmentId) !== null}
            title={machines.problem(anchor.environmentId) ?? undefined}
            onClick={() => setDialog({ project: anchor, candidate: null, autoReview: false })}
          >
            Link…
          </Button>
        }
      />
      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`px-3 py-2 text-sm sm:px-4 ${message.error ? "text-destructive-foreground" : "text-muted-foreground"}`}
        >
          {message.text}
        </p>
      )}
      {dialog && (
        <ProjectLinkDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          project={dialog.project}
          initialCandidate={dialog.candidate}
          {...(dialog.kept ? { initialKept: dialog.kept } : {})}
          autoReview={dialog.autoReview}
        />
      )}
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <DialogPopup showCloseButton={!busy} className="w-full sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Unlink the copy on {confirm ? machines.label(confirm.environmentId) : ""}?
            </DialogTitle>
            <DialogDescription>
              It becomes its own project again, with an active coordinator and a copy of this
              project's notes. {coordinatorLabel} stops sending it work. Threads and files stay
              where they are.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive-outline"
              disabled={busy}
              onClick={() => confirm && void unlinkMember(confirm)}
            >
              {busy ? "Unlinking…" : "Unlink"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

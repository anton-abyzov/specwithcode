import { useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { ProjectDisconnectedTurn } from "@specweave-studio/contracts";
import { useTx } from "../../i18n";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { logicalCoordinator, logicalCoordinators } from "../../studio/projectDomain";
import {
  departedMembers,
  linkedCopies,
  projectLink,
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
import { ProjectCopyRepositories, useRepositoryInventory } from "./ProjectCopyRepositories";
import { ProjectLinkDialog, type ProjectLinkTarget } from "./ProjectLinkDialog";
import { useHoldProjectKeyFollow } from "../settings/projectKeyFollow";
import { PROJECT_MACHINES_SECTION_ID } from "./projectMachinesSection";
import { useLinkMachines } from "./useLinkMachines";
import { mayLeave, useUnlinkMember } from "./useUnlinkMember";

const NEEDS_UPDATE =
  "Needs an update: this machine is on a version from before every machine ran its own coordinator.";
const ROLE_TEXT: Record<LinkedCopy["role"], string> = {
  coordinator: "Runs its own coordinator for this project.",
  workers: NEEDS_UPDATE,
  pending: NEEDS_UPDATE,
};

const failureMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

const formatTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

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
  const tx = useTx();
  const projects = useProjects();
  const machines = useLinkMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const preview = useAtomCommand(projectLink.preview, { reportFailure: false });
  const unlink = useAtomCommand(projectLink.unlink, { reportFailure: false });
  const unlinking = useUnlinkMember();
  const [review, setReview] = useState<{
    readonly machine: string;
    readonly turns: ReadonlyArray<ProjectDisconnectedTurn>;
  } | null>(null);
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
  const coordinating = logicalCoordinators(shared)?.coordinators ?? [];
  const copies = shared.length > 0 ? linkedCopies(shared, coordinator, coordinating) : [];
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
  // Every other copy should hold the checkouts this one's folder holds.
  const repositorySource = coordinator ?? anchor;
  const inventory = useRepositoryInventory(
    repositorySource,
    repositorySource !== undefined && machines.connected(repositorySource.environmentId),
  );
  const coordinatorLabel = coordinator ? machines.label(coordinator.environmentId) : null;
  const reviewTurns = async (member: EnvironmentProject) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const read = await preview({
        environmentId: member.environmentId,
        input: { projectId: member.id },
      });
      if (read._tag === "Failure") throw squashAtomCommandFailure(read);
      setReview({
        machine: machines.label(member.environmentId),
        turns: read.value.ranWhileDisconnected ?? [],
      });
    } catch (cause) {
      setMessage({
        text: failureMessage(cause, "Could not read those turns. Retry."),
        error: true,
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const unlinkMember = async (member: EnvironmentProject) => {
    if (running.current || !coordinator) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    const said = await unlinking.unlink({ member, coordinator, shared });
    if (said) setMessage(said);
    running.current = false;
    setBusy(false);
    setConfirm(null);
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
    <SettingsSection title="Machines" id={PROJECT_MACHINES_SECTION_ID}>
      {copies.map((copy) => {
        const label = machines.label(copy.project.environmentId);
        const problem = machines.problem(copy.project.environmentId);
        return (
          <SettingsRow
            key={`${copy.project.environmentId}:${copy.project.id}`}
            data-project-copy=""
            title={label}
            literal
            description={
              <>
                <ProjectLocation path={copy.project.workspaceRoot} />
                <span className="block">{tx(ROLE_TEXT[copy.role])}</span>
                {repositorySource &&
                (copy.project.environmentId !== repositorySource.environmentId ||
                  copy.project.id !== repositorySource.id) ? (
                  <ProjectCopyRepositories
                    copy={copy.project}
                    inventory={inventory}
                    label={label}
                    problem={problem}
                  />
                ) : null}
                {copy.unfinished && (
                  <span className="block">
                    Joined, but {coordinatorLabel} does not list it yet. Finish linking so both
                    machines list each other.
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
                <div className="flex flex-wrap justify-end gap-2">
                  {copy.project.workspaceSettings?.coordinatorBinding?.takenOverAt ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || problem !== null}
                      title={problem ?? undefined}
                      onClick={() => void reviewTurns(copy.project)}
                    >
                      Review turns
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || problem !== null}
                    title={problem ?? undefined}
                    onClick={() => setConfirm(copy.project)}
                    aria-label={`Unlink ${copy.project.title} on ${label}`}
                  >
                    Unlink
                  </Button>
                </div>
              ) : copy.project !== coordinator && mayLeave(copy.project, shared) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || problem !== null}
                  title={problem ?? undefined}
                  onClick={() => setConfirm(copy.project)}
                  aria-label={`Unlink ${copy.project.title} on ${label}`}
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
          literal
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
            ? "Add this project on another machine. Every machine runs its own coordinator."
            : "Make this project and the same project on another machine one project. Each machine keeps its own coordinator."
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
              Unlink {confirm?.title ?? ""} on{" "}
              {confirm ? machines.label(confirm.environmentId) : ""}?
            </DialogTitle>
            <DialogDescription>
              It becomes its own project again, with its own coordinator and a copy of this
              project's notes. The other machines stop sharing this project with it. Threads and
              files stay where they are.
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
      <Dialog open={review !== null} onOpenChange={(open) => !open && setReview(null)}>
        <DialogPopup className="w-full sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Turns {review?.machine} ran while disconnected</DialogTitle>
            <DialogDescription>
              {review?.turns.length
                ? `Coordinator turns ${review.machine} started after another copy took over. Check whether any work needs to move to the current coordinator.`
                : `${review?.machine ?? "That copy"} ran no coordinator turns after the takeover.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {review?.turns.length ? (
              <ul className="space-y-2 text-sm" aria-label="Turns ran while disconnected">
                {review.turns.map((turn) => (
                  <li key={turn.runId} className="min-w-0">
                    <span className="block text-xs text-muted-foreground">
                      {formatTime(turn.requestedAt)}
                    </span>
                    <span className="block truncate">
                      {turn.request ?? "The request is no longer on that machine."}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </SettingsSection>
  );
}

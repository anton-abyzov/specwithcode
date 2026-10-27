import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectDisconnectedTurn,
  ProjectLinkNoteWrite,
} from "@specweave-studio/contracts";
import { machineLastSeenAt, useMachineLastSeenVersion } from "../../lib/machineLastSeen";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { logicalCoordinator, logicalCoordinators } from "../../studio/projectDomain";
import {
  departedMembers,
  highestEpoch,
  linkedCopies,
  linkMemberOf,
  pendingSupersedes,
  projectLink,
  projectLinkStorageKey,
  readPendingOperation,
  takeoverAvailability,
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
  workers:
    "Runs workers. Its own coordinator is read-only history until you start a coordinator here.",
  pending: "Coordinator handoff pending.",
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

/** When this page first found a machine gone that this device never saw connected. */
const firstSeenGone = new Map<string, number>();

/** Since when the coordinator's machine has been unreachable from this device, or null. */
export function unreachableSince(
  environmentId: EnvironmentId,
  connected: boolean,
  now: number,
): number | null {
  if (connected) {
    firstSeenGone.delete(environmentId);
    return null;
  }
  const lastSeen = machineLastSeenAt(environmentId);
  if (lastSeen !== null) return lastSeen;
  if (!firstSeenGone.has(environmentId)) firstSeenGone.set(environmentId, now);
  return firstSeenGone.get(environmentId)!;
}

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
  const takeover = useAtomCommand(projectLink.takeover, { reportFailure: false });
  const startCoordinator = useAtomCommand(projectLink.startCoordinator, { reportFailure: false });
  const [takeoverOf, setTakeoverOf] = useState<EnvironmentProject | null>(null);
  const [review, setReview] = useState<{
    readonly machine: string;
    readonly turns: ReadonlyArray<ProjectDisconnectedTurn>;
  } | null>(null);
  // The 10-minute wait counts down while the page is open.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useMachineLastSeenVersion();
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
  const coordinatorLabel = coordinator ? machines.label(coordinator.environmentId) : null;
  const coordinatorConnected = coordinator ? machines.connected(coordinator.environmentId) : true;
  // Null while the coordinator is connected: nothing to take over.
  const availability =
    coordinator && !coordinatorConnected
      ? takeoverAvailability({
          coordinatorConnected,
          unreachableSince: unreachableSince(coordinator.environmentId, false, now),
          now,
        })
      : null;
  if (coordinator && coordinatorConnected) unreachableSince(coordinator.environmentId, true, now);
  const givingWay = pendingSupersedes(shared);

  const takeOver = async (member: EnvironmentProject) => {
    if (running.current || !coordinator) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    const memberLabel = machines.label(member.environmentId);
    const previousLabel = machines.label(coordinator.environmentId);
    try {
      const result = await takeover({
        environmentId: member.environmentId,
        input: {
          operationId: randomUUID(),
          projectId: member.id,
          knownEpoch: highestEpoch(shared),
          predecessor: linkMemberOf(coordinator),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setMessage({
        text: `${memberLabel} now coordinates this project. ${
          result.value.replicaFrom
            ? `It starts from ${previousLabel}'s notes, goal and instructions as copied ${formatTime(result.value.replicaFrom)}.`
            : `No copy of ${previousLabel}'s notes reached it, so it starts from its own.`
        } When ${previousLabel} is back, it gives way and lists any coordinator turns it ran meanwhile.`,
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: failureMessage(cause, "Take over did not finish. Retry it."),
        error: true,
      });
    } finally {
      running.current = false;
      setBusy(false);
      setTakeoverOf(null);
    }
  };

  // Each machine may run its own coordinator; nothing gives way and nothing waits 10 minutes.
  const startHere = async (member: EnvironmentProject) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    const memberLabel = machines.label(member.environmentId);
    try {
      const result = await startCoordinator({
        environmentId: member.environmentId,
        input: {
          operationId: randomUUID(),
          projectId: member.id,
          knownEpoch: highestEpoch(shared),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setMessage({
        text: `${memberLabel} now runs its own coordinator next to the others. ${
          result.value.replicaFrom
            ? `It starts from the notes, goal and instructions copied ${formatTime(result.value.replicaFrom)}.`
            : "It starts from its own notes."
        } Each coordinator keeps the threads it started.`,
        error: false,
      });
    } catch (cause) {
      setMessage({
        text: failureMessage(cause, "The coordinator did not start. Retry it."),
        error: true,
      });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

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
                <TakeoverNote
                  copy={copy}
                  coordinatorLabel={coordinatorLabel}
                  availability={availability}
                  givingWayTo={
                    givingWay.find((pending) => pending.previous === copy.project)?.successor
                  }
                  tookOverFrom={
                    givingWay.find((pending) => pending.successor === copy.project)?.previous
                  }
                  label={machines.label}
                />
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
                  {machines.startReady(copy.project.environmentId) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || problem !== null}
                      title={problem ?? undefined}
                      onClick={() => void startHere(copy.project)}
                    >
                      Start a coordinator here
                    </Button>
                  ) : null}
                  {availability && !machines.startReady(copy.project.environmentId) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        !availability.available ||
                        !machines.takeoverReady(copy.project.environmentId)
                      }
                      title={
                        problem ??
                        (machines.takeoverReady(copy.project.environmentId)
                          ? undefined
                          : `Update SpecWithCode on ${label} to take over.`)
                      }
                      onClick={() => setTakeoverOf(copy.project)}
                    >
                      Take over coordinator here
                    </Button>
                  ) : null}
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
                </div>
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
      <Dialog
        open={takeoverOf !== null}
        onOpenChange={(open) => !open && !busy && setTakeoverOf(null)}
      >
        <DialogPopup showCloseButton={!busy} className="w-full sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Take over the coordinator on{" "}
              {takeoverOf ? machines.label(takeoverOf.environmentId) : ""}?
            </DialogTitle>
            <DialogDescription>
              {coordinatorLabel} has been unreachable for at least 10 minutes. This copy becomes the
              coordinator, starting from the notes, goal and instructions last copied from{" "}
              {coordinatorLabel}. When {coordinatorLabel} is back it stops coordinating and lists
              any coordinator turns it ran meanwhile for you to review. Nothing is merged on its
              own; code stays in git on each machine.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setTakeoverOf(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => takeoverOf && void takeOver(takeoverOf)}>
              {busy ? "Taking over…" : "Take over"}
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

/** What a takeover means for one copy's row, if anything. */
function TakeoverNote({
  copy,
  coordinatorLabel,
  availability,
  givingWayTo,
  tookOverFrom,
  label,
}: {
  copy: LinkedCopy;
  coordinatorLabel: string | null;
  availability: { readonly available: boolean; readonly waitMs: number } | null;
  givingWayTo: EnvironmentProject | undefined;
  tookOverFrom: EnvironmentProject | undefined;
  label: (environmentId: EnvironmentId) => string;
}) {
  const binding = copy.project.workspaceSettings?.coordinatorBinding;
  if (givingWayTo)
    return (
      <span className="block">
        {label(givingWayTo.environmentId)} took over while this machine was unreachable. It gives
        way when both machines are reachable from this app.
      </span>
    );
  if (tookOverFrom && binding?.takenOverAt)
    return (
      <span className="block">
        Took over from {label(tookOverFrom.environmentId)} {formatTime(binding.takenOverAt)}.{" "}
        {label(tookOverFrom.environmentId)} gives way when it is reachable again.
      </span>
    );
  if (copy.role === "workers" && binding?.takenOverAt && binding.successor)
    return (
      <span className="block">
        {label(binding.successor.environmentId)} took over {formatTime(binding.takenOverAt)}. Review
        the coordinator turns this copy ran after that.
      </span>
    );
  if (copy.role !== "workers" || !availability || !coordinatorLabel) return null;
  return availability.available ? (
    <span className="block">
      {coordinatorLabel} has been unreachable for 10 minutes or more. This copy can take over the
      coordinator.
    </span>
  ) : (
    <span className="block">
      {coordinatorLabel} is unreachable. This copy can take over the coordinator in{" "}
      {Math.max(1, Math.ceil(availability.waitMs / 60_000))} min if it stays away.
    </span>
  );
}

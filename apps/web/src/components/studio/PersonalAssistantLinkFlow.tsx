import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type LogicalProjectMember,
  PERSONAL_LINK_PROTOCOL_VERSION,
  type PersonalLinkJoinInput,
  type PersonalLinkPreview,
  type ProjectId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import {
  executePersonalAssistantMigration,
  type MemoryClashResolution,
  type MemoryFileClash,
  memoryResolutionsForSeat,
  type MigrationSeatInput,
  personalLinkIdsFor,
  personalLinkJoinOrder,
  planPersonalAssistantMigration,
} from "@specweave-studio/shared/personalAssistantMigration";
import { Link2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../../connection/runtime";
import { personalAssistantLinkOffer } from "../../studio/personalAssistant";
import { openCommandPalette } from "../../commandPaletteBus";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Dialog, DialogPopup } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { PersonalAssistantMergeDialog } from "./PersonalAssistantMergeDialog";

const previewCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-link:preview",
  tag: WS_METHODS.personalLinkPreview,
});
const joinCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-link:join",
  tag: WS_METHODS.personalLinkJoin,
});

const useRequest = create<{ open: boolean }>(() => ({ open: false }));

/** Opens "Link personal assistants across your machines" (1448 AC-11, AC-13). */
export function requestPersonalAssistantLink(): void {
  useRequest.setState({ open: true });
}

/** The sidebar's "Link assistants" row, shown while machines hold separate assistants. */
export function PersonalAssistantLinkRow({
  assistants,
  onOpen,
}: {
  readonly assistants: Parameters<typeof personalAssistantLinkOffer>[0];
  readonly onOpen?: () => void;
}) {
  if (!personalAssistantLinkOffer(assistants)) return null;
  return (
    <button
      type="button"
      className="sws-side-row sws-side-row-quiet"
      onClick={() => {
        onOpen?.();
        requestPersonalAssistantLink();
      }}
    >
      <Link2Icon aria-hidden />
      <span className="sws-side-row-label">Link assistants</span>
      <span className="sws-side-row-hint">One assistant on every machine</span>
    </button>
  );
}

/** The sidebar's assistant row: "Use Percy on <machine>" joins, "Set up" creates. */
export function openAssistantOffer(kind: "join" | "create"): void {
  if (kind === "join") requestPersonalAssistantLink();
  else openCommandPalette({ open: "new-assistant" });
}

export function PersonalAssistantLinkFlowHost() {
  const open = useRequest((state) => state.open);
  return open ? (
    <PersonalAssistantLinkFlow onClose={() => useRequest.setState({ open: false })} />
  ) : null;
}

export interface PreviewedSeat {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly createdAt: string;
  readonly preview: PersonalLinkPreview | null;
  /** Why the preview failed (offline, refused, timed out); null when it was read. */
  readonly previewError?: string | null | undefined;
}

const seatKey = (seat: { readonly environmentId: string; readonly projectId: string }) =>
  `${seat.environmentId}:${seat.projectId}`;

/** What the merge review knows about one seat, as the shared planner takes it. */
export function seatInputOf(seat: PreviewedSeat): MigrationSeatInput {
  const preview = seat.preview;
  const supports =
    preview !== null &&
    preview.protocolVersion >= PERSONAL_LINK_PROTOCOL_VERSION &&
    preview.self !== undefined &&
    preview.memoryDigest !== undefined &&
    preview.settingsRevision !== undefined;
  const linked = preview !== null && preview.members.length > 1;
  return {
    environmentId: seat.environmentId,
    machineLabel: preview?.machineLabel ?? seat.environmentId,
    projectId: seat.projectId,
    title: preview?.assistantName ?? seat.title,
    createdAt: preview?.createdAt ?? seat.createdAt,
    supportsPersonalLink: supports,
    existingLogicalProjectId: linked ? preview.logicalProjectId : null,
    memoryFiles: preview?.memoryFiles ?? [],
    // A failed preview is an unreachable machine, never one that needs an update.
    previewError:
      preview === null
        ? (seat.previewError ?? "it did not answer. Check that it is on and connected.")
        : null,
    ...(linked ? { existingMembers: preview.members.map(seatKey) } : {}),
    identityId: preview?.logicalProjectId ?? null,
  };
}

export interface PersonalLinkJoinStep {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly input: PersonalLinkJoinInput;
  /** A follow-up that only moves the routine runner after every seat joined. */
  readonly runnerOnly?: boolean;
}

/**
 * Runs the join steps in order and stops at the first failure: a later seat
 * must never list members that did not accept it, and a non-runner seat must
 * never hold its routines for a runner that never joined.
 */
export async function runPersonalLinkJoinSteps(
  steps: ReadonlyArray<PersonalLinkJoinStep>,
  joinSeat: (step: PersonalLinkJoinStep) => Promise<{ readonly error: string | null }>,
): Promise<{ readonly linked: ReadonlyArray<string>; readonly failure: string | null }> {
  const linked: string[] = [];
  for (const step of steps) {
    const { error } = await joinSeat(step);
    if (error !== null) {
      return {
        linked,
        failure: step.runnerOnly
          ? `Every machine linked, but moving the routine runner failed on ${step.machineLabel}: ${error}. Choose the runner in Settings > Routines.`
          : `${step.machineLabel}: ${error}`,
      };
    }
    if (!linked.includes(step.machineLabel)) linked.push(step.machineLabel);
  }
  return { linked, failure: null };
}

/**
 * Whether the window only offers "Set up here": this machine has no assistant
 * and there is nothing left to link among the others. With two or more of
 * them still separate, the merge review shows, so this window is no dead end.
 */
export function personalLinkSetupOnly(input: {
  readonly ownEnvironmentId: string | null;
  readonly seats: ReadonlyArray<{ readonly environmentId: string }>;
  readonly canonicalSeatCount: number;
  readonly alreadyLinked: boolean;
}): boolean {
  if (input.ownEnvironmentId === null) return false;
  if (input.seats.some((seat) => seat.environmentId === input.ownEnvironmentId)) return false;
  return input.canonicalSeatCount < 2 || input.alreadyLinked;
}

/** Why linking cannot go ahead at all, in the owner's words, or null. */
export function personalLinkBlockedMessage(
  plan: {
    readonly conflictingLinkIds: ReadonlyArray<string>;
    readonly missingLinkMembers: ReadonlyArray<string>;
  },
  seats: ReadonlyArray<PreviewedSeat>,
): string | null {
  if (plan.conflictingLinkIds.length > 0) {
    return "These machines belong to two different linked assistants. Unlink one group first, then link again.";
  }
  if (plan.missingLinkMembers.length > 0) {
    const names = plan.missingLinkMembers.map((key) => {
      const known = seats.find((seat) => seatKey(seat) === key);
      return known?.preview?.machineLabel ?? key.slice(0, key.indexOf(":"));
    });
    return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} on the existing link but not taking part. Connect ${names.length === 1 ? "it" : "them"} and try again, or remove ${names.length === 1 ? "it" : "them"} from the link first.`;
  }
  return null;
}

/** The name an existing link carries, read from a seat already on it. */
export function existingLinkTitleOf(
  seats: ReadonlyArray<PreviewedSeat>,
  existingLinkId: string | null,
): string | null {
  if (existingLinkId === null) return null;
  const onLink = seats.find(
    (seat) =>
      seat.preview !== null &&
      seat.preview.members.length > 1 &&
      seat.preview.logicalProjectId === existingLinkId,
  );
  return onLink?.preview?.assistantName ?? null;
}

/** The machine that runs an existing link's routines now, if one does. */
export function existingLinkRunnerOf(
  seats: ReadonlyArray<PreviewedSeat>,
  existingLinkId: string | null,
): EnvironmentId | null {
  if (existingLinkId === null) return null;
  return (
    seats.find(
      (seat) =>
        seat.preview !== null &&
        seat.preview.members.length > 1 &&
        seat.preview.logicalProjectId === existingLinkId &&
        seat.preview.routineOwner,
    )?.environmentId ?? null
  );
}

/**
 * Every join call one link attempt makes, in order (1448 C2). Seats already on
 * a link reuse its id and name; the members are that link's members plus every
 * seat here; seats on the link go first, the runner first within each group.
 * Moving the runner of an existing link to another machine happens only after
 * every seat joined: the old runner is switched off, then the new one on.
 */
export function personalLinkJoinSteps(input: {
  readonly seats: ReadonlyArray<PreviewedSeat>;
  readonly canonicalSeats: ReadonlyArray<MigrationSeatInput>;
  readonly existingLinkId: string | null;
  readonly routineOwnerEnvironmentId: EnvironmentId;
  readonly canonicalName: string;
  readonly clashes: ReadonlyArray<MemoryFileClash>;
  readonly resolutions: Readonly<Record<string, MemoryClashResolution>>;
}): { readonly logicalProjectId: string; readonly steps: ReadonlyArray<PersonalLinkJoinStep> } {
  const previewOf = (seat: MigrationSeatInput) =>
    input.seats.find((s) => seatKey(s) === seatKey(seat))?.preview ?? null;
  const members = new Map<string, LogicalProjectMember>();
  if (input.existingLinkId !== null) {
    for (const seat of input.seats) {
      const preview = seat.preview;
      if (preview === null || preview.logicalProjectId !== input.existingLinkId) continue;
      if (preview.members.length < 2) continue;
      for (const member of preview.members) members.set(seatKey(member), member);
    }
  }
  for (const seat of input.canonicalSeats) {
    const self = previewOf(seat)?.self;
    if (self === undefined) {
      throw new Error(`${seat.machineLabel} did not describe itself; read it again and retry.`);
    }
    members.set(seatKey(self), self);
  }
  const memberList = [...members.values()];
  const ids = personalLinkIdsFor({
    canonicalSeats: input.canonicalSeats,
    existingLinkId: input.existingLinkId,
    memberKeys: [...members.keys()],
  });
  const name = existingLinkTitleOf(input.seats, input.existingLinkId) ?? input.canonicalName;
  const currentRunner = existingLinkRunnerOf(input.seats, input.existingLinkId);
  const moveRunnerAfter =
    currentRunner !== null &&
    currentRunner !== input.routineOwnerEnvironmentId &&
    input.canonicalSeats.some((seat) => seat.environmentId === currentRunner);
  const firstPassRunner: EnvironmentId =
    moveRunnerAfter && currentRunner !== null ? currentRunner : input.routineOwnerEnvironmentId;
  const ordered = personalLinkJoinOrder(
    input.canonicalSeats,
    input.existingLinkId,
    firstPassRunner,
  );
  const baseInput = (seat: MigrationSeatInput, routineOwner: boolean) => {
    const others = input.canonicalSeats.filter((other) => seatKey(other) !== seatKey(seat));
    return {
      projectId: seat.projectId,
      logicalProjectId: ids.logicalProjectId,
      canonicalName: name,
      members: memberList,
      routineOwner,
      peerProtocolVersion: Math.min(
        ...others.map((other) => previewOf(other)?.protocolVersion ?? 0),
      ),
      peerMachineLabel: others.map((other) => other.machineLabel).join(", "),
      operationId: ids.operationId,
    };
  };
  const steps: PersonalLinkJoinStep[] = ordered.map((seat) => {
    const preview = previewOf(seat);
    if (preview?.settingsRevision === undefined || preview.memoryDigest === undefined) {
      throw new Error(`${seat.machineLabel} needs an update before it can link.`);
    }
    return {
      environmentId: seat.environmentId,
      machineLabel: seat.machineLabel,
      input: {
        ...baseInput(seat, seat.environmentId === firstPassRunner),
        approval: {
          expectedSettingsRevision: preview.settingsRevision,
          memoryDigest: preview.memoryDigest,
        },
        memoryResolutions: [
          ...memoryResolutionsForSeat(input.clashes, input.resolutions, seat.environmentId),
        ],
      },
    };
  });
  if (moveRunnerAfter) {
    // Off first, then on: two machines never run the routines at once.
    for (const [environmentId, routineOwner] of [
      [currentRunner, false],
      [input.routineOwnerEnvironmentId, true],
    ] as const) {
      const seat = input.canonicalSeats.find((s) => s.environmentId === environmentId);
      if (seat === undefined) continue;
      steps.push({
        environmentId: seat.environmentId,
        machineLabel: seat.machineLabel,
        input: baseInput(seat, routineOwner),
        runnerOnly: true,
      });
    }
  }
  return { logicalProjectId: ids.logicalProjectId, steps };
}

function PersonalAssistantLinkFlow({ onClose }: { readonly onClose: () => void }) {
  const projects = useProjects();
  const ownEnvironmentId = usePrimaryEnvironmentId();
  const preview = useAtomCommand(previewCommand, { reportFailure: false });
  const join = useAtomCommand(joinCommand, { reportFailure: false });
  const candidates = useMemo(
    () =>
      projects.filter(
        (project) =>
          isPersonalAssistantProject(project) && project.workspaceSettings?.archived !== true,
      ),
    [projects],
  );
  const [opened] = useState(candidates);
  // Seats the owner left out because they could not be read.
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(() => new Set());
  // Bumped to read every preview again: after a failed attempt and on "Try again".
  const [round, setRound] = useState(0);
  const [seats, setSeats] = useState<ReadonlyArray<PreviewedSeat> | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReading(true);
    void Promise.all(
      opened
        .filter((project) => !leftOut.has(`${project.environmentId}:${project.id}`))
        .map(async (project): Promise<PreviewedSeat> => {
          const result = await preview({
            environmentId: project.environmentId,
            input: { projectId: project.id },
          });
          const failure = result._tag === "Success" ? null : squashAtomCommandFailure(result);
          return {
            environmentId: project.environmentId,
            projectId: project.id,
            title: project.title,
            createdAt: project.createdAt,
            preview: result._tag === "Success" ? result.value : null,
            previewError:
              result._tag === "Success"
                ? null
                : failure instanceof Error
                  ? failure.message
                  : String(failure ?? "it did not answer"),
          };
        }),
    ).then((loaded) => {
      if (cancelled) return;
      setSeats(loaded);
      setReading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [opened, preview, round, leftOut]);

  const rereadPreviews = useCallback(() => setRound((value) => value + 1), []);
  const seatInputs = useMemo(() => (seats ?? []).map(seatInputOf), [seats]);
  const plan = useMemo(() => planPersonalAssistantMigration(seatInputs), [seatInputs]);
  const staleKeys = new Set(plan.staleExtraSeats.map(seatKey));
  const lockedName = seats === null ? null : existingLinkTitleOf(seats, plan.existingLinkId);
  const currentRunner = seats === null ? null : existingLinkRunnerOf(seats, plan.existingLinkId);

  const confirm = async (choice: {
    readonly routineOwnerEnvironmentId: EnvironmentId;
    readonly resolutions: Readonly<Record<string, MemoryClashResolution>>;
    readonly canonicalName: string;
  }) => {
    if (seats === null) return;
    setBusy(true);
    setError(null);
    const linkedNow: string[] = [];
    const outcome = await executePersonalAssistantMigration({
      seats: seatInputs,
      ownerApproved: true,
      routineOwnerEnvironmentId: choice.routineOwnerEnvironmentId,
      resolutions: choice.resolutions,
      // Each machine saves its own database copy inside its join, before it writes anything.
      createSnapshot: async (seat) => `saved by ${seat.machineLabel} when it links`,
      linkSeats: async ({ canonicalSeats, routineOwnerEnvironmentId, resolutions }) => {
        const { logicalProjectId, steps } = personalLinkJoinSteps({
          seats,
          canonicalSeats,
          existingLinkId: plan.existingLinkId,
          routineOwnerEnvironmentId,
          canonicalName: choice.canonicalName,
          clashes: plan.clashes,
          resolutions,
        });
        const run = await runPersonalLinkJoinSteps(steps, async (step) => {
          const result = await join({ environmentId: step.environmentId, input: step.input });
          if (result._tag === "Success") return { error: null };
          const failure = squashAtomCommandFailure(result);
          return { error: failure instanceof Error ? failure.message : String(failure) };
        });
        linkedNow.push(...run.linked);
        if (run.failure !== null) throw new Error(run.failure);
        return { logicalProjectId };
      },
    }).catch((cause: unknown) => ({
      ok: false as const,
      error: { message: cause instanceof Error ? cause.message : String(cause) },
    }));
    setBusy(false);
    if (!outcome.ok) {
      setError(
        `${outcome.error?.message ?? "Linking failed."} ${
          linkedNow.length > 0 ? `Linked so far: ${linkedNow.join(", ")}. ` : ""
        }Each machine was read again; try again to finish the rest.`,
      );
      // The next attempt uses each machine's current state and finishes the same link.
      rereadPreviews();
      return;
    }
    toastManager.add({
      type: "success",
      title: `${lockedName ?? choice.canonicalName} is linked across your machines`,
    });
    onClose();
  };

  const ownHasSeat =
    ownEnvironmentId === null ||
    (seats ?? []).some((seat) => seat.environmentId === ownEnvironmentId);
  // With no assistant here, the others can still be linked from this window.
  const showSetupOnly = personalLinkSetupOnly({
    ownEnvironmentId,
    seats: seats ?? [],
    canonicalSeatCount: plan.canonicalSeats.length,
    alreadyLinked: plan.alreadyLinkedLogicalId !== null,
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A running link finishes in view, so a failure is never dropped unseen.
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup
        showCloseButton={!busy}
        aria-label="Link personal assistants across your machines"
      >
        {seats === null ? (
          <p className="project-muted">Reading each machine's personal assistant…</p>
        ) : showSetupOnly ? (
          <div className="project-settings-section">
            <h2>Use {seatInputs[0]?.title ?? "Percy"} on this machine</h2>
            <p className="project-muted">
              Set up an assistant here first. Then link it: it joins{" "}
              {seatInputs.map((seat) => `${seat.title} on ${seat.machineLabel}`).join(", ")} with
              the same memory and name instead of starting a separate one.
            </p>
            <div className="project-actions">
              <button
                type="button"
                className="project-control project-primary"
                onClick={() => {
                  onClose();
                  openCommandPalette({ open: "new-assistant" });
                }}
              >
                Set up here
              </button>
              <button type="button" className="project-control" onClick={onClose}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <PersonalAssistantMergeDialog
            seats={seatInputs.map((seat) => ({
              environmentId: seat.environmentId,
              machineLabel: seat.machineLabel,
              title: seat.title,
              supportsPersonalLink: seat.supportsPersonalLink,
              isStaleExtra: staleKeys.has(seatKey(seat)),
              previewError: seat.previewError ?? null,
            }))}
            clashes={plan.clashes}
            // Link waits while previews are read again, so it never sends an old approval.
            busy={busy || reading}
            error={error}
            blockedMessage={personalLinkBlockedMessage(plan, seats)}
            note={
              ownHasSeat
                ? null
                : "This machine has no assistant of its own yet. Link the others here, then set one up on this machine and link it too."
            }
            lockedName={lockedName}
            defaultRoutineOwner={currentRunner}
            onRetryUnreachable={rereadPreviews}
            onLeaveOut={(environmentId) =>
              setLeftOut((previous) => {
                const next = new Set(previous);
                for (const seat of seats) {
                  if (seat.environmentId === environmentId) next.add(seatKey(seat));
                }
                return next;
              })
            }
            onConfirm={(choice) => void confirm(choice)}
            onCancel={onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

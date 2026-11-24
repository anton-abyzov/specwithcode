import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type LogicalProjectMember,
  PERSONAL_LINK_PROTOCOL_VERSION,
  type PersonalLinkPreview,
  type ProjectId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import {
  executePersonalAssistantMigration,
  type MemoryClashResolution,
  memoryResolutionsForSeat,
  type MigrationSeatInput,
  planPersonalAssistantMigration,
} from "@specweave-studio/shared/personalAssistantMigration";
import { Link2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { connectionAtomRuntime } from "../../connection/runtime";
import { randomUUID } from "../../lib/utils";
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

interface PreviewedSeat {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly createdAt: string;
  readonly preview: PersonalLinkPreview | null;
}

/** What the merge review knows about one seat, as the shared planner takes it. */
export function seatInputOf(seat: PreviewedSeat): MigrationSeatInput {
  const preview = seat.preview;
  const supports =
    preview !== null &&
    preview.protocolVersion >= PERSONAL_LINK_PROTOCOL_VERSION &&
    preview.self !== undefined &&
    preview.memoryDigest !== undefined &&
    preview.settingsRevision !== undefined;
  return {
    environmentId: seat.environmentId,
    machineLabel: preview?.machineLabel ?? seat.environmentId,
    projectId: seat.projectId,
    title: preview?.assistantName ?? seat.title,
    createdAt: preview?.createdAt ?? seat.createdAt,
    supportsPersonalLink: supports,
    existingLogicalProjectId:
      preview !== null && preview.members.length > 1 ? preview.logicalProjectId : null,
    memoryFiles: preview?.memoryFiles ?? [],
  };
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
  // Previews are read once per opening; a later change is caught by the join's approval check.
  const [opened] = useState(candidates);
  const [seats, setSeats] = useState<ReadonlyArray<PreviewedSeat> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept across retries, so a second try finishes the same link instead of starting another.
  const [ids] = useState(() => ({
    logicalProjectId: `logical:${randomUUID()}`,
    operationId: `personal-link:${randomUUID()}`,
  }));

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      opened.map(async (project): Promise<PreviewedSeat> => {
        const result = await preview({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        });
        return {
          environmentId: project.environmentId,
          projectId: project.id,
          title: project.title,
          createdAt: project.createdAt,
          preview: result._tag === "Success" ? result.value : null,
        };
      }),
    ).then((loaded) => {
      if (!cancelled) setSeats(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [opened, preview]);

  const seatInputs = useMemo(() => (seats ?? []).map(seatInputOf), [seats]);
  const plan = useMemo(() => planPersonalAssistantMigration(seatInputs), [seatInputs]);
  const staleKeys = new Set(
    plan.staleExtraSeats.map((seat) => `${seat.environmentId}:${seat.projectId}`),
  );

  const confirm = async (choice: {
    readonly routineOwnerEnvironmentId: EnvironmentId;
    readonly resolutions: Readonly<Record<string, MemoryClashResolution>>;
    readonly canonicalName: string;
  }) => {
    if (seats === null) return;
    setBusy(true);
    setError(null);
    const previewOf = (seat: MigrationSeatInput) =>
      seats.find((s) => s.environmentId === seat.environmentId && s.projectId === seat.projectId)
        ?.preview ?? null;
    const outcome = await executePersonalAssistantMigration({
      seats: seatInputs,
      ownerApproved: true,
      routineOwnerEnvironmentId: choice.routineOwnerEnvironmentId,
      resolutions: choice.resolutions,
      // Each machine saves its own database copy inside its join, before it writes anything.
      createSnapshot: async (seat) => `saved by ${seat.machineLabel} when it links`,
      linkSeats: async ({ canonicalSeats, routineOwnerEnvironmentId, resolutions }) => {
        const members: LogicalProjectMember[] = canonicalSeats.flatMap((seat) => {
          const self = previewOf(seat)?.self;
          return self === undefined ? [] : [self];
        });
        const failures: string[] = [];
        for (const seat of canonicalSeats) {
          const seatPreview = previewOf(seat)!;
          const others = canonicalSeats.filter((other) => other !== seat);
          const result = await join({
            environmentId: seat.environmentId,
            input: {
              projectId: seat.projectId,
              logicalProjectId: ids.logicalProjectId,
              canonicalName: choice.canonicalName,
              members,
              routineOwner: seat.environmentId === routineOwnerEnvironmentId,
              peerProtocolVersion: Math.min(
                ...others.map((other) => previewOf(other)?.protocolVersion ?? 0),
              ),
              peerMachineLabel: others.map((other) => other.machineLabel).join(", "),
              operationId: ids.operationId,
              approval: {
                expectedSettingsRevision: seatPreview.settingsRevision!,
                memoryDigest: seatPreview.memoryDigest!,
              },
              memoryResolutions: [
                ...memoryResolutionsForSeat(plan.clashes, resolutions, seat.environmentId),
              ],
            },
          });
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            failures.push(
              `${seat.machineLabel}: ${failure instanceof Error ? failure.message : String(failure)}`,
            );
          }
        }
        if (failures.length > 0) throw new Error(failures.join(" "));
        return { logicalProjectId: ids.logicalProjectId };
      },
    }).catch((cause: unknown) => ({
      ok: false as const,
      error: { message: cause instanceof Error ? cause.message : String(cause) },
    }));
    setBusy(false);
    if (!outcome.ok) {
      setError(
        `${outcome.error?.message ?? "Linking failed."} Machines that linked stay linked; try again to finish the rest.`,
      );
      return;
    }
    toastManager.add({
      type: "success",
      title: `${choice.canonicalName} is linked across your machines`,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        {seats === null ? (
          <p className="project-muted">Reading each machine's personal assistant…</p>
        ) : ownEnvironmentId !== null &&
          !seats.some((seat) => seat.environmentId === ownEnvironmentId) ? (
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
              isStaleExtra: staleKeys.has(`${seat.environmentId}:${seat.projectId}`),
            }))}
            clashes={plan.clashes}
            busy={busy}
            error={error}
            onConfirm={(choice) => void confirm(choice)}
            onCancel={onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

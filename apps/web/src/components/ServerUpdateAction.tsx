import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  type AuthSessionState,
  sessionGrantsScope,
} from "@specweave-studio/contracts";
import type { AsyncResult } from "effect/reactivity";
import { environmentSession } from "~/state/session";
import type {
  EnvironmentId,
  ServerInstallation,
  ServerSelfUpdateCapability,
} from "@specweave-studio/contracts";
import type {
  ServerUpdateStage,
  ServerUpdateState,
} from "@specweave-studio/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import type {
  ServerPrepareServiceUpdateResult,
  ServiceUpdateBlocker,
} from "@specweave-studio/contracts";
import { CircleArrowUpIcon } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment, updateOutdatedServer } from "~/state/server";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useAtomCommand } from "~/state/use-atom-command";
import { askRestartForWork } from "./serviceUpdateCalls";
import { LiveRestartRunningWorkList } from "./sidebar/RestartRunningWorkList";
import { describeListedRestart } from "./sidebar/restartRunningWork.logic";
import { interruptedWork } from "./sidebar/SidebarRestartToUpdate.logic";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// The wire "installing" stage is a sub-second launcher handoff, so the UI
// folds it into the download phase; everything after the handoff is the
// restart the user is actually waiting through.
const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "Downloading…",
  installing: "Downloading…",
  resuming: "Restarting…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

/** How long the look at what runs may take before the update goes ahead without it. */
const COPY_LOOK_MS = 5_000;
/** While an update waits for that machine to be quiet, look this often. */
export const REMOTE_QUIET_CHECK_MS = 15_000;
// Updates waiting for their machine to be quiet; a second press does not start another.
const quietWaits = new Map<EnvironmentId, { cancelled: boolean }>();

/** The question before an update that would cut off folder copies on that machine. */
export function describeServerUpdateCopies(serverLabel: string, copies: number): string {
  const one = copies === 1;
  return `${serverLabel} is ${one ? "copying a folder" : `copying ${copies} folders`} to or from another machine. Updating restarts it and cuts ${one ? "the copy" : "the copies"} off; ${one ? "it" : "they"} may need Retry. Update anyway?`;
}

export interface ServerUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly installation?: ServerInstallation | undefined;
  readonly desktopAppUpdate?: boolean;
  readonly threadContinuation?: boolean;
  readonly targetVersion: string;
  readonly continueThreadsAfterServerUpdate?: boolean;
}

type UpdateButtonProps = Pick<ComponentProps<typeof Button>, "variant" | "size" | "className"> & {
  readonly label?: string;
  /** "icon" renders a compact icon button with the label in a tooltip. */
  readonly appearance?: "button" | "icon";
};

function useServerUpdate() {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const prepare = useAtomCommand(serverEnvironment.prepareServiceUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  /** What runs on that machine now; null when it cannot say in time (older servers, offline). */
  const lookAt = async (
    environmentId: EnvironmentId,
  ): Promise<ServerPrepareServiceUpdateResult | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      Promise.resolve()
        .then(() => prepare({ environmentId, input: { stopWork: false } }))
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), COPY_LOOK_MS);
      }),
    ]);
    clearTimeout(timer);
    // A server too old to report what runs answers without a list.
    return answer?._tag === "Success" && Array.isArray(answer.value?.blockers)
      ? answer.value
      : null;
  };
  const readWork =
    (environmentId: EnvironmentId) =>
    async (): Promise<ReadonlyArray<ServiceUpdateBlocker> | null> => {
      const checked = await lookAt(environmentId);
      return checked === null ? null : interruptedWork(checked.blockers);
    };
  const run = async (target: ServerUpdateTarget, failureTitle: string) => {
    const { environmentId, serverLabel, selfUpdate, targetVersion } = target;
    try {
      const result = await updateServer({
        environmentId,
        input: {
          targetVersion,
          ...(target.threadContinuation && target.continueThreadsAfterServerUpdate
            ? { continueRunningThreads: true }
            : {}),
        },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description:
          selfUpdate === "desktop-managed"
            ? `Desktop app relaunched on ${result.value.targetVersion}.`
            : `Reconnected on specweave-studio@${result.value.targetVersion}.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: updateFailureMessage(error),
      });
    }
  };
  // Wait until quiet: look again every few seconds and update once nothing
  // there would be cut off (running work or a folder copy). It never forces;
  // Cancel or closing the notice ends the wait at once.
  const waitThenUpdate = async (target: ServerUpdateTarget, failureTitle: string) => {
    const { environmentId, serverLabel } = target;
    if (quietWaits.has(environmentId)) return;
    const wait = { cancelled: false };
    quietWaits.set(environmentId, wait);
    const end = () => {
      wait.cancelled = true;
      if (quietWaits.get(environmentId) === wait) quietWaits.delete(environmentId);
    };
    const toastId = toastManager.add({
      type: "info",
      title: `${serverLabel} updates when quiet`,
      description: "It updates once nothing running there would be cut off.",
      timeout: 0,
      onClose: end,
      actionProps: {
        children: "Cancel",
        onClick: () => {
          end();
          toastManager.close(toastId);
        },
      },
    });
    try {
      const signedOut = () =>
        !canUpdateServer(appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId)));
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, REMOTE_QUIET_CHECK_MS));
        if (wait.cancelled) return;
        // Access ended while it waited: say so now, not never.
        if (signedOut()) break;
        const checked = await lookAt(environmentId);
        if (
          checked !== null &&
          interruptedWork(checked.blockers).length === 0 &&
          (checked.folderCopies ?? 0) === 0
        )
          break;
      }
      if (wait.cancelled) return;
      end();
      toastManager.close(toastId);
      if (signedOut()) {
        toastManager.add({
          type: "error",
          title: `${serverLabel} was not updated`,
          description:
            "This app may no longer update that machine. Sign in to it again, then Update.",
        });
        return;
      }
      pendingUpdateEnvironmentIds.add(environmentId);
      try {
        await run(target, failureTitle);
      } finally {
        pendingUpdateEnvironmentIds.delete(environmentId);
      }
    } finally {
      if (quietWaits.get(environmentId) === wait) quietWaits.delete(environmentId);
    }
  };
  return async (
    target: ServerUpdateTarget,
    failureTitle = "Server update failed",
    /** The question for a desktop app relaunch, asked when nothing there would be cut off. */
    relaunchQuestion: string | null = null,
  ) => {
    const { environmentId, serverLabel, targetVersion } = target;
    if (
      !canUpdateServer(appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId))) ||
      pendingUpdateEnvironmentIds.has(environmentId) ||
      quietWaits.has(environmentId)
    )
      return;
    pendingUpdateEnvironmentIds.add(environmentId);
    let waiting = false;
    try {
      // The update restarts that machine's service: say what it would cut off first.
      const checked = await lookAt(environmentId);
      const working = checked === null ? [] : interruptedWork(checked.blockers);
      const copies = checked?.folderCopies ?? 0;
      if (working.length > 0) {
        const choice =
          (await askRestartForWork(
            describeListedRestart({
              title:
                target.selfUpdate === "desktop-managed"
                  ? `Update and relaunch the app on ${serverLabel}?`
                  : `Update ${serverLabel} to ${targetVersion}?`,
              continues:
                target.threadContinuation === true &&
                target.continueThreadsAfterServerUpdate === true,
              folderCopies: copies,
            }),
            {
              canWait: true,
              nowLabel: "Update now",
              details: (
                <LiveRestartRunningWorkList
                  initial={working}
                  poll={readWork(environmentId)}
                  machine={{ environmentId, name: serverLabel }}
                  openFromDialog
                />
              ),
            },
          )) ?? "now";
        if (choice === "later") return;
        if (choice === "wait") {
          waiting = true;
          return;
        }
      } else if (relaunchQuestion !== null) {
        // No themed host mounted (undefined) means proceed: the click itself was the request.
        if (!((await requestConfirmDialog(relaunchQuestion)) ?? true)) return;
      } else if (
        copies > 0 &&
        !((await requestConfirmDialog(describeServerUpdateCopies(serverLabel, copies))) ?? true)
      )
        return;
      if (!canUpdateServer(appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId))))
        return;
      await run(target, failureTitle);
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
      if (waiting) void waitThenUpdate(target, failureTitle);
    }
  };
}

/** Updates eligible machines independently; manual paths remain in the machine list. */
export function ServerUpdatesAction({
  targets,
  label = "Update all",
  variant = "outline",
  size = "xs",
  className,
}: UpdateButtonProps & {
  readonly targets: ReadonlyArray<ServerUpdateTarget>;
}) {
  const update = useServerUpdate();
  const pending = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const eligible = targets.filter(
    (target) =>
      target.selfUpdate !== null &&
      (target.selfUpdate !== "desktop-managed" || target.desktopAppUpdate),
  );
  const handleUpdate = async () => {
    if (pending.current) return;
    pending.current = true;
    setIsPending(true);
    try {
      const available = eligible.filter(
        (target) => !pendingUpdateEnvironmentIds.has(target.environmentId),
      );
      const desktopTargets = available.filter((target) => target.selfUpdate === "desktop-managed");
      if (desktopTargets.length > 0) {
        const confirmed =
          (await requestConfirmDialog(
            `Update the SpecWithCode desktop apps on ${desktopTargets.map((target) => target.serverLabel).join(", ")}? They will close and relaunch on those machines.`,
          )) ?? true;
        if (!confirmed) return;
      }
      await Promise.all(
        available.map((target) => update(target, `${target.serverLabel} update failed`)),
      );
    } finally {
      pending.current = false;
      setIsPending(false);
    }
  };
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={isPending || eligible.length === 0}
      onClick={() => void handleUpdate()}
    >
      {label}
    </Button>
  );
}

function canUpdateServer(result: AsyncResult.AsyncResult<AuthSessionState, unknown>): boolean {
  if (result._tag !== "Success" || !result.value.authenticated) return false;
  return sessionGrantsScope(result.value, AuthEnvironmentMaintainScope);
}

/**
 * One-row status for an in-flight server update: "Downloading…" then
 * "Restarting…". The update is a wait, not a warning: a single pulsing dot
 * and label, no step rail, no versions. Failure turns the row red with the
 * rollback reason.
 */
export function ServerUpdateProgress({
  state,
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  if (state.status === "failed") {
    return (
      <div
        className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive-foreground"
        role="alert"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate">{state.message}</span>} />
          <TooltipPopup side="top">{state.message}</TooltipPopup>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span
        className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-foreground"
        aria-hidden="true"
      />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to client-runtime so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  desktopAppUpdate = false,
  threadContinuation = false,
  targetVersion,
  label = "Update",
  variant = "outline",
  size = "xs",
  className,
  appearance = "button",
  description,
}: Omit<ServerUpdateTarget, "continueThreadsAfterServerUpdate"> &
  UpdateButtonProps & {
    /** What the update changes on that machine: the button's tooltip and accessible description. */
    readonly description?: string | undefined;
  }) {
  const isDesktopAppUpdate = selfUpdate === "desktop-managed";
  const sessionStateAtom = environmentSession.sessionStateAtom(environmentId);
  const canUpdate = canUpdateServer(useAtomValue(sessionStateAtom));
  const continueThreadsAfterServerUpdate = useEnvironmentSettings(
    environmentId,
    (settings) => settings.continueThreadsAfterServerUpdate,
  );
  const update = useServerUpdate();
  const handleUpdate = async () => {
    if (
      !canUpdateServer(appAtomRegistry.get(sessionStateAtom)) ||
      pendingUpdateEnvironmentIds.has(environmentId)
    ) {
      return;
    }
    // The one question in the flow (the remote machine installs without asking
    // anyone there): the live list when work runs there, else the relaunch.
    await update(
      {
        environmentId,
        serverLabel,
        selfUpdate,
        desktopAppUpdate,
        threadContinuation,
        targetVersion,
        continueThreadsAfterServerUpdate,
      },
      undefined,
      isDesktopAppUpdate
        ? `Update the SpecWithCode desktop app that runs the ${serverLabel}? It will close and relaunch on that machine.`
        : null,
    );
  };

  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  // A server that cannot update itself gets no action here: the local Studio
  // service updates with the app (Restart to update), and copied shell steps
  // for another machine were never a real update path.
  if (selfUpdate === null) return null;
  const actionLabel = label;
  const onClick = () => void handleUpdate();

  if (appearance === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className={className}
              aria-label={`${actionLabel} for ${serverLabel}`}
              disabled={!canUpdate}
              onClick={onClick}
            />
          }
        >
          <CircleArrowUpIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">{actionLabel}</TooltipPopup>
      </Tooltip>
    );
  }

  const button = (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={!canUpdate}
      onClick={onClick}
      aria-description={description}
    >
      {actionLabel}
    </Button>
  );
  if (description === undefined) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Updates a host too old for this client to connect to. Its version comes
 * from the host descriptor because the host never delivers a server config.
 */
export function OutdatedServerUpdateAction({
  environmentId,
  serverLabel,
  fromVersion,
  targetVersion,
  label = "Update",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly fromVersion: string | undefined;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) return;
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await update({
        environmentId,
        input: { targetVersion },
        ...(fromVersion === undefined ? {} : { fromVersion }),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description: `Reconnected on specweave-studio@${result.value.targetVersion}.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Server update failed",
        description: updateFailureMessage(error),
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };
  return (
    <Button size="xs" variant="outline" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}

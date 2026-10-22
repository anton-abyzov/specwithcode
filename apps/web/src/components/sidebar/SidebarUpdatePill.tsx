import type { DesktopUpdateState } from "@specweave-studio/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { isElectron } from "../../env";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useStudioServiceUpdateState } from "../../state/serviceUpdate";
import { liveServiceUpdateRun } from "../serviceUpdateRunView";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateBusyNotice,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "../desktopUpdate.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DesktopUpdateStatusIcon,
  shouldContinueDesktopUpdateCheckAnimation,
  shouldShowDesktopUpdateCheckIcon,
} from "./DesktopUpdateStatusIcon";
import { requestRestartToUpdate } from "./restartToUpdateRequests";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";

type SidebarUpdatePopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];
type SidebarUpdatePopoverHandle = ReturnType<typeof PopoverCreateHandle>;

export function shouldUseSidebarUpdateReleaseNotesPopover(
  showUpdateDetails: boolean,
  state: DesktopUpdateState | null,
): boolean {
  return showUpdateDetails && state?.channel === "nightly" && state.releaseNotes.length > 0;
}

export function handleSidebarUpdateReleaseNotesPopoverOpenChange(
  _open: boolean,
  details: Pick<SidebarUpdatePopoverChangeDetails, "reason" | "cancel">,
): void {
  // The trigger is the update action, so its presses must not also toggle the Popover.
  if (details.reason === "trigger-press") details.cancel();
}

export function openSidebarUpdateReleaseNotesPopoverOnForwardTab(
  event: { readonly key: string; readonly shiftKey: boolean },
  handle: Pick<SidebarUpdatePopoverHandle, "open">,
  triggerId: string,
): void {
  if (event.key !== "Tab" || event.shiftKey) return;
  // Hover-open popovers do not manage focus. Promote this one before native Tab runs.
  flushSync(() => handle.open(triggerId));
}

function resolveSidebarUpdatePresentation({
  action,
  isDownloading,
  showCheckIcon,
}: {
  readonly action: ReturnType<typeof resolveDesktopUpdateButtonAction>;
  readonly isDownloading: boolean;
  readonly showCheckIcon: boolean;
}) {
  const showUpdateDetails = action !== "none" || isDownloading;
  const iconStatus = showCheckIcon
    ? "checking"
    : action === "install"
      ? "downloaded"
      : isDownloading
        ? "downloading"
        : action === "download"
          ? "available"
          : "idle";

  return {
    iconStatus,
    showUpdateDetails,
    showUpdateIconState: showUpdateDetails && !showCheckIcon,
  } as const;
}

export function SidebarUpdateArchitectureWarning() {
  return isElectron ? <SidebarUpdateArchitectureWarningContent /> : null;
}

function SidebarUpdateArchitectureWarningContent() {
  const state = useDesktopUpdateState();
  const visible = shouldShowArm64IntelBuildWarning(state);
  const description = state && visible ? getArm64IntelBuildWarningDescription(state) : null;

  if (!visible || !description) return null;

  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>Intel build on Apple Silicon</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export function SidebarUpdatePill() {
  return isElectron ? <SidebarUpdateControl /> : null;
}

function showManualUpdateCheckResult(state: DesktopUpdateState): boolean {
  if (state.status === "checking") return false;
  if (state.status === "up-to-date") {
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "No newer update available",
        description: `SpecWithCode ${state.currentVersion} is installed.`,
      }),
    );
  } else if (
    state.status === "error" &&
    (state.errorContext === null || state.errorContext === "check")
  ) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not check for updates",
        description: state.message ?? "Update check failed.",
      }),
    );
  }
  return true;
}

function SidebarUpdateControl() {
  const state = useDesktopUpdateState();
  const [pendingAction, setPendingAction] = useState<"check" | "download" | null>(null);
  const isActionPending = pendingAction !== null;
  const busyNoticeToastId = useRef<string | null>(null);
  const [pendingManualCheck, setPendingManualCheck] = useState<{
    checkedAt: string | null;
  } | null>(null);
  const [checkAnimationKey, setCheckAnimationKey] = useState(0);
  const [isCheckAnimationLatched, setIsCheckAnimationLatched] = useState(false);
  const [releaseNotesPopoverHandle] = useState(() => PopoverCreateHandle());
  const suppressReleaseNotesFocusOpen = useRef(false);
  const releaseNotesPopupRef = useRef<HTMLDivElement>(null);
  const releaseNotesTriggerId = useId();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  useEffect(() => {
    // Updater events can reach the renderer after the check RPC resolves. Only
    // announce the requested check, never an earlier state or a background poll.
    if (
      pendingManualCheck &&
      state &&
      (pendingManualCheck.checkedAt === null ||
        (state.checkedAt !== null &&
          Date.parse(state.checkedAt) >= Date.parse(pendingManualCheck.checkedAt))) &&
      showManualUpdateCheckResult(state)
    ) {
      setPendingManualCheck(null);
    }
  }, [pendingManualCheck, state]);

  useEffect(() => {
    if (prefersReducedMotion) {
      setIsCheckAnimationLatched(false);
    } else if (state?.status === "checking") {
      setIsCheckAnimationLatched(true);
    }
  }, [prefersReducedMotion, state?.status]);

  // A downloaded update shows its badge here too; a press hands it to the
  // Restart to update pill, which owns the running-work prompt.
  // While an Update now run goes on (0988), nothing offers to install.
  const runLive = liveServiceUpdateRun(useStudioServiceUpdateState()) !== null;
  const resolved = state ? resolveDesktopUpdateButtonAction(state) : "none";
  const action = runLive && resolved === "install" ? "none" : resolved;
  const isDownloading = state?.status === "downloading";
  const showCheckIcon = shouldShowDesktopUpdateCheckIcon({
    isAnimationLatched: isCheckAnimationLatched,
    isChecking: state?.status === "checking",
    prefersReducedMotion,
  });
  const { iconStatus, showUpdateDetails, showUpdateIconState } = resolveSidebarUpdatePresentation({
    action,
    isDownloading,
    showCheckIcon,
  });
  const tooltip = showUpdateDetails
    ? state
      ? getDesktopUpdateButtonTooltip(state)
      : "Update available"
    : showCheckIcon
      ? "Checking for updates…"
      : canCheckForUpdate(state)
        ? "Check for updates"
        : (state?.message ?? "Automatic updates are off");
  const disabled = showCheckIcon
    ? true
    : showUpdateDetails
      ? isDesktopUpdateButtonDisabled(state)
      : !canCheckForUpdate(state);
  const isInteractionDisabled = disabled || isActionPending || pendingManualCheck !== null;
  const isBusy = showCheckIcon || isDownloading || isActionPending || pendingManualCheck !== null;
  const showReleaseNotesPopover = shouldUseSidebarUpdateReleaseNotesPopover(
    showUpdateDetails,
    state,
  );

  useEffect(() => {
    if (!showReleaseNotesPopover) {
      releaseNotesPopoverHandle.close();
      return;
    }

    const trigger = document.getElementById(releaseNotesTriggerId);
    if (trigger?.matches(":focus-visible")) {
      releaseNotesPopoverHandle.open(releaseNotesTriggerId);
    }
  }, [releaseNotesPopoverHandle, releaseNotesTriggerId, showReleaseNotesPopover]);

  const handleAction = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    if (!state || isInteractionDisabled) {
      // Say why nothing starts; one notice at a time however often it is pressed.
      const notice = getDesktopUpdateBusyNotice(state, pendingAction);
      if (busyNoticeToastId.current) toastManager.close(busyNoticeToastId.current);
      busyNoticeToastId.current = toastManager.add(
        stackedThreadToast({ type: "info", title: notice.title, description: notice.description }),
      );
      return;
    }

    if (runLive) {
      // The run's own toast shows its progress; a check now would only race it.
      if (busyNoticeToastId.current) toastManager.close(busyNoticeToastId.current);
      busyNoticeToastId.current = toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "Update in progress",
          description: "SpecWithCode is updating; this window follows it.",
        }),
      );
      return;
    }

    if (action === "install") {
      if (!requestRestartToUpdate()) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Update downloaded",
            description: "Quit and reopen SpecWithCode to install it.",
          }),
        );
      }
      return;
    }

    setPendingAction(action === "download" ? "download" : "check");

    if (action === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setPendingAction(null));
      return;
    }

    if (!prefersReducedMotion) {
      setIsCheckAnimationLatched(true);
      setCheckAnimationKey((key) => key + 1);
    }
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (result.checked) {
          if (!showManualUpdateCheckResult(result.state)) {
            setPendingManualCheck({ checkedAt: result.state.checkedAt });
          }
          return;
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description:
              result.state.message ?? "Automatic updates are not available in this build.",
          }),
        );
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      })
      .finally(() => setPendingAction(null));
  }, [action, isInteractionDisabled, pendingAction, prefersReducedMotion, runLive, state]);

  const handleCheckAnimationIteration = useCallback(() => {
    setIsCheckAnimationLatched(
      shouldContinueDesktopUpdateCheckAnimation({
        isChecking: state?.status === "checking",
        prefersReducedMotion,
      }),
    );
  }, [prefersReducedMotion, state?.status]);

  const updateButton = (
    <button
      type="button"
      aria-label={tooltip}
      // Never aria-disabled: a press while busy explains itself instead of doing nothing.
      aria-busy={isBusy || undefined}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full outline-hidden ring-ring transition-colors focus-visible:ring-2",
        isBusy ? "cursor-progress" : "cursor-pointer",
        showUpdateIconState
          ? "bg-sidebar-control-surface text-sidebar-foreground hover:bg-sidebar-row-hover"
          : "text-(--sidebar-icon-color) hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        disabled && !showUpdateIconState && "opacity-60",
      )}
      onClick={handleAction}
      onBlur={() => {
        suppressReleaseNotesFocusOpen.current = false;
      }}
      onFocus={(event) => {
        if (!showReleaseNotesPopover || !event.currentTarget.matches(":focus-visible")) return;
        if (suppressReleaseNotesFocusOpen.current) {
          suppressReleaseNotesFocusOpen.current = false;
          return;
        }
        flushSync(() => releaseNotesPopoverHandle.open(releaseNotesTriggerId));
      }}
      onKeyDown={(event) => {
        if (!showReleaseNotesPopover) return;
        openSidebarUpdateReleaseNotesPopoverOnForwardTab(
          event,
          releaseNotesPopoverHandle,
          releaseNotesTriggerId,
        );
      }}
    >
      <DesktopUpdateStatusIcon
        key={showCheckIcon ? checkAnimationKey : iconStatus}
        downloadPercent={state?.downloadPercent ?? null}
        isCheckAnimating={showCheckIcon && !prefersReducedMotion}
        onCheckAnimationIteration={handleCheckAnimationIteration}
        status={iconStatus}
      />
    </button>
  );

  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Popover
        handle={releaseNotesPopoverHandle}
        onOpenChange={(open, details) => {
          if (open && !showReleaseNotesPopover) {
            details.cancel();
            return;
          }
          handleSidebarUpdateReleaseNotesPopoverOpenChange(open, details);
        }}
      >
        <Tooltip disabled={showReleaseNotesPopover}>
          <TooltipTrigger
            id={releaseNotesTriggerId}
            render={
              <PopoverTrigger
                {...(!showReleaseNotesPopover
                  ? {
                      "aria-controls": undefined,
                      "aria-expanded": undefined,
                      "aria-haspopup": undefined,
                    }
                  : {})}
                closeDelay={150}
                handle={releaseNotesPopoverHandle}
                id={releaseNotesTriggerId}
                openOnHover={showReleaseNotesPopover}
                render={updateButton}
              />
            }
          />
          {!showReleaseNotesPopover ? (
            <TooltipPopup
              align="center"
              side="top"
              variant={showUpdateDetails ? "glass" : "default"}
            >
              {tooltip}
            </TooltipPopup>
          ) : null}
        </Tooltip>
        {showReleaseNotesPopover && state ? (
          <PopoverPopup
            align="center"
            aria-label="Nightly update release notes"
            initialFocus={false}
            onKeyDownCapture={(event) => {
              if (
                event.key === "Escape" &&
                releaseNotesPopupRef.current?.contains(document.activeElement)
              ) {
                suppressReleaseNotesFocusOpen.current = true;
              }
            }}
            ref={releaseNotesPopupRef}
            side="top"
            tooltipStyle
          >
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={state}
              tooltip={tooltip}
            />
          </PopoverPopup>
        ) : null}
      </Popover>
    </SidebarMenuItem>
  );
}

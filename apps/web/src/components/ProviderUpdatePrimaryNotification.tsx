import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  AuthProvidersManageScope,
  type ServerProvider,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";

import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironment } from "../state/environments";
import {
  type EnvironmentScopeAccess,
  providerManageBlockedText,
  readEnvironmentScope,
  readEnvironmentScopeAccess,
  useEnvironmentScopeAccess,
} from "../state/session";
import { useDismissedProviderUpdateNotificationKeys } from "../providerUpdateDismissal";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  collectUpdatedProviderSnapshots,
  firstFailedProviderUpdateMessage,
  getProviderUpdateInitialToastView,
  getProviderUpdateProgressToastView,
  getProviderUpdateRejectedToastView,
  isProviderUpdateBlockedInUse,
  providerUpdateNotificationKey,
  shouldShowPrimaryProviderUpdateToast,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";
import { useAtomCommand } from "../state/use-atom-command";

const seenProviderUpdateNotificationKeys = new Set<string>();
type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;

type ActiveProviderUpdateToast =
  | {
      readonly kind: "prompt";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
      readonly manageAccess: EnvironmentScopeAccess;
    }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
      readonly providerCount: number;
    };

function ProviderUpdateToastIcon({ provider }: { provider: ServerProvider }) {
  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
      <ProviderInstanceIcon
        driverKind={provider.driver}
        displayName={provider.displayName ?? provider.driver}
        acpRegistryIconUrl={provider.iconUrl}
        iconClassName="size-4"
      />
      <span className="absolute -right-1 -bottom-1 inline-flex size-3 items-center justify-center rounded-full bg-popover">
        <DownloadIcon
          aria-hidden="true"
          className="size-2.5 text-success-foreground"
          strokeWidth={2.5}
        />
      </span>
    </span>
  );
}

function addProviderUpdateToast(input: {
  readonly view: ProviderUpdateToastView;
  readonly openSettings: (toastId: ProviderUpdateToastId) => void;
  /** Offered when the failure was only a running CLI; retries skipping the idle check. */
  readonly updateAnyway?: (() => void) | undefined;
}) {
  if (input.view.type === "loading" || input.view.type === "success") {
    return toastManager.add({
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: hiddenToastActionProps,
      data: {
        hideCopyButton: true,
        ...(input.view.dismissAfterVisibleMs !== undefined
          ? { dismissAfterVisibleMs: input.view.dismissAfterVisibleMs }
          : {}),
      },
    });
  }

  let toastId!: ProviderUpdateToastId;
  const settingsAction = {
    children: "Settings",
    onClick: () => input.openSettings(toastId),
  };
  const updateAnyway = input.updateAnyway;
  toastId = toastManager.add(
    stackedThreadToast({
      type: input.view.type,
      title: input.view.title,
      description: input.view.description,
      timeout: 0,
      actionProps: updateAnyway
        ? {
            children: "Update anyway",
            onClick: () => {
              toastManager.close(toastId);
              updateAnyway();
            },
          }
        : settingsAction,
      actionVariant: "outline",
      data: {
        hideCopyButton: true,
        ...(updateAnyway
          ? { secondaryActionProps: settingsAction, secondaryActionVariant: "outline" as const }
          : {}),
      },
    }),
  );
  return toastId;
}

/**
 * The single-prompt provider update notification used when there is only one
 * local environment (no WSL backend). Non-WSL users see exactly this flow — the
 * per-environment split is gated behind WSL presence.
 */
export function ProviderUpdatePrimaryNotification() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const primaryEnvironment = usePrimaryEnvironment();
  const manageAccess = useEnvironmentScopeAccess(
    primaryEnvironment?.environmentId ?? null,
    AuthProvidersManageScope,
    primaryEnvironment?.connection,
  );
  const canManageProviders = manageAccess === "granted";
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKey } =
    useDismissedProviderUpdateNotificationKeys();

  // If this flow unmounts (e.g. a WSL backend appears and we switch to the
  // per-environment popover), close any prompt it owns so it does not linger.
  // The prompt was closed for the user, not dismissed by them, so forget that
  // it was shown: a remount (including StrictMode's dev remount) shows it again.
  useEffect(() => {
    return () => {
      const activeToast = activeToastRef.current;
      if (activeToast?.kind === "prompt") {
        toastManager.close(activeToast.toastId);
        seenProviderUpdateNotificationKeys.delete(activeToast.key);
      }
      activeToastRef.current = null;
    };
  }, []);

  const updateProviders = useMemo(() => collectProviderUpdateCandidates(providers), [providers]);
  const notificationKey = useMemo(
    () => providerUpdateNotificationKey(updateProviders),
    [updateProviders],
  );
  const oneClickProviders = useMemo(
    () =>
      updateProviders.filter((provider) => canOneClickUpdateProviderCandidate(provider, providers)),
    [providers, updateProviders],
  );

  const openProviderSettings = useCallback(
    (toastId?: ProviderUpdateToastId) => {
      const activeToast = activeToastRef.current;
      if (toastId !== undefined) {
        toastManager.close(toastId);
      } else if (activeToast?.kind === "prompt") {
        toastManager.close(activeToast.toastId);
      }
      if (
        activeToast &&
        (toastId === undefined ||
          (activeToast.kind === "prompt" && activeToast.toastId === toastId))
      ) {
        activeToastRef.current = null;
      }
      void navigate({ to: "/settings/providers" });
    },
    [navigate],
  );

  // "Update anyway" for the providers refused only because their CLI was running.
  const dispatchUpdatesRef = useRef<typeof dispatchUpdates | null>(null);
  const forceRetryFor = useCallback(
    (snapshots: ReadonlyArray<ServerProvider>): (() => void) | undefined => {
      const inUse = snapshots.filter(isProviderUpdateBlockedInUse);
      return inUse.length > 0 ? () => dispatchUpdatesRef.current?.(inUse, true) : undefined;
    },
    [],
  );

  // Runs each provider's update in turn; one failure does not stop the rest.
  // `force` is only sent from "Update anyway" after an in-use refusal.
  const dispatchUpdates = useCallback(
    (targets: ReadonlyArray<Pick<ServerProvider, "driver" | "instanceId">>, force: boolean) => {
      if (
        targets.length === 0 ||
        !primaryEnvironment ||
        !readEnvironmentScope(primaryEnvironment.environmentId, AuthProvidersManageScope)
      ) {
        return;
      }
      const providerCount = targets.length;
      const providerInstanceIds = new Set(targets.map((provider) => provider.instanceId));
      const activeUpdate: ActiveProviderUpdateToast = {
        kind: "update",
        key: `${force ? "force" : "update"}:${[...providerInstanceIds].join(",")}`,
        providerInstanceIds,
        providerCount,
      };
      activeToastRef.current = activeUpdate;

      void (async () => {
        const results = [];
        for (const provider of targets) {
          if (!readEnvironmentScope(primaryEnvironment.environmentId, AuthProvidersManageScope)) {
            if (activeToastRef.current === activeUpdate) {
              addProviderUpdateToast({
                view: getProviderUpdateRejectedToastView(
                  providerCount,
                  providerManageBlockedText(
                    readEnvironmentScopeAccess(
                      primaryEnvironment.environmentId,
                      AuthProvidersManageScope,
                    ),
                  ) ?? "This connection cannot manage provider accounts.",
                ),
                openSettings: openProviderSettings,
              });
              activeToastRef.current = null;
            }
            return;
          }
          results.push(
            await updateProvider({
              environmentId: primaryEnvironment.environmentId,
              input: {
                provider: provider.driver,
                instanceId: provider.instanceId,
                ...(force ? { force: true } : {}),
              },
            }),
          );
        }

        if (activeToastRef.current !== activeUpdate) {
          return;
        }

        const failedMessage = firstFailedProviderUpdateMessage(results);
        if (failedMessage) {
          addProviderUpdateToast({
            view: getProviderUpdateRejectedToastView(providerCount, failedMessage),
            openSettings: openProviderSettings,
          });
          activeToastRef.current = null;
          return;
        }

        const updatedProviderSnapshots = collectUpdatedProviderSnapshots({
          results,
          providerInstanceIds,
        });
        const view = getProviderUpdateProgressToastView({
          providers: updatedProviderSnapshots,
          providerCount,
        });
        if (shouldShowPrimaryProviderUpdateToast(view)) {
          addProviderUpdateToast({
            view,
            openSettings: openProviderSettings,
            updateAnyway: forceRetryFor(updatedProviderSnapshots),
          });
          activeToastRef.current = null;
        }
      })();
    },
    [forceRetryFor, openProviderSettings, primaryEnvironment, updateProvider],
  );
  useEffect(() => {
    dispatchUpdatesRef.current = dispatchUpdates;
  }, [dispatchUpdates]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind !== "update") {
      return;
    }

    const activeProviders = providers.filter((provider) =>
      activeToast.providerInstanceIds.has(provider.instanceId),
    );
    const view = getProviderUpdateProgressToastView({
      providers: activeProviders,
      providerCount: activeToast.providerCount,
    });
    if (!shouldShowPrimaryProviderUpdateToast(view)) {
      return;
    }

    addProviderUpdateToast({
      view,
      openSettings: openProviderSettings,
      updateAnyway: forceRetryFor(activeProviders),
    });
    activeToastRef.current = null;
  }, [forceRetryFor, providers, openProviderSettings]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    const updateExistingPrompt =
      activeToast?.kind === "prompt" &&
      activeToast.key === notificationKey &&
      activeToast.manageAccess !== manageAccess;
    if (
      !notificationKey ||
      // Until this browser's session has loaded there is nothing true to say
      // about who may update, so do not open a prompt yet.
      (manageAccess === "unknown" && !updateExistingPrompt) ||
      dismissedNotificationKeys.has(notificationKey) ||
      (seenProviderUpdateNotificationKeys.has(notificationKey) && !updateExistingPrompt) ||
      (activeToastRef.current && !updateExistingPrompt)
    ) {
      return;
    }

    seenProviderUpdateNotificationKeys.add(notificationKey);

    const initialView = getProviderUpdateInitialToastView({ updateProviders, oneClickProviders });

    let toastId!: ProviderUpdateToastId;
    let updateStarted = false;
    const openSettings = () => openProviderSettings(toastId);
    const dismissPrompt = () => {
      const activeToast = activeToastRef.current;
      if (activeToast?.kind === "prompt" && activeToast.toastId === toastId) {
        activeToastRef.current = null;
      }
      dismissNotificationKey(notificationKey);
    };

    const runUpdates = () => {
      if (
        updateStarted ||
        oneClickProviders.length === 0 ||
        !primaryEnvironment ||
        !readEnvironmentScope(primaryEnvironment.environmentId, AuthProvidersManageScope)
      ) {
        return;
      }
      updateStarted = true;
      toastManager.close(toastId);
      dispatchUpdates(oneClickProviders, false);
    };

    const toastOptions = stackedThreadToast({
      type: initialView.type,
      title: initialView.title,
      description:
        manageAccess === "granted"
          ? initialView.description
          : manageAccess === "denied"
            ? "This connection cannot manage provider accounts. View provider settings for update details."
            : providerManageBlockedText(manageAccess),
      timeout: 0,
      actionProps:
        oneClickProviders.length > 0
          ? {
              children: "Update",
              disabled: !canManageProviders,
              onClick: runUpdates,
            }
          : {
              children: "Settings",
              onClick: openSettings,
            },
      actionVariant: "outline",
      data: {
        leadingIcon:
          updateProviders.length === 1 ? (
            <ProviderUpdateToastIcon provider={updateProviders[0]!} />
          ) : undefined,
        hideCopyButton: true,
        onClose: dismissPrompt,
        ...(oneClickProviders.length > 0
          ? {
              secondaryActionProps: {
                children: "Settings",
                onClick: openSettings,
              },
              secondaryActionVariant: "outline" as const,
            }
          : {}),
      },
    });
    if (updateExistingPrompt && activeToast?.kind === "prompt") {
      toastId = activeToast.toastId;
      toastManager.update(toastId, toastOptions);
    } else {
      toastId = toastManager.add(toastOptions);
    }
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId, manageAccess };
  }, [
    canManageProviders,
    dispatchUpdates,
    manageAccess,
    dismissNotificationKey,
    dismissedNotificationKeys,
    notificationKey,
    oneClickProviders,
    openProviderSettings,
    primaryEnvironment,
    updateProviders,
  ]);

  return null;
}

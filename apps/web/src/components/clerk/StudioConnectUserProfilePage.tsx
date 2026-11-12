import { findErrorTraceId } from "@specweave-studio/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { AuthRelayWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import type { RelayClientEnvironmentRecord } from "@specweave-studio/contracts/relay";
import { ServerIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { unlinkPrimaryEnvironment as unlinkPrimaryEnvironmentCommand } from "../../cloud/linkEnvironmentAtoms";
import {
  deregisterManagedRelayEnvironmentCommand,
  useManagedRelayEnvironments,
} from "../../cloud/managedRelayState";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import {
  ClerkUserProfileError,
  ClerkUserProfileList,
  ClerkUserProfileListCaption,
  ClerkUserProfileListSkeleton,
  ClerkUserProfilePage,
  ClerkUserProfileRefreshButton,
  ClerkUserProfileRow,
} from "./ClerkUserProfilePage";

const linkedAtFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** "Linked Oct 26, 2026", with the date marked up as a date. */
function LinkedAt({ value }: { readonly value: string }) {
  const linkedAt = new Date(value);
  if (Number.isNaN(linkedAt.getTime())) return <>Link date unavailable</>;
  return (
    <>
      Linked <time dateTime={value}>{linkedAtFormatter.format(linkedAt)}</time>
    </>
  );
}

function endpointLabel(environment: RelayClientEnvironmentRecord): string {
  return environment.endpoint.providerKind === "cloudflare_tunnel"
    ? "Managed tunnel"
    : "Activity publishing only";
}

/** This machine first, then by name: the list reads the same on every refresh. */
export function orderConnectMachines(
  environments: ReadonlyArray<RelayClientEnvironmentRecord>,
  currentEnvironmentId: EnvironmentId | null,
): ReadonlyArray<RelayClientEnvironmentRecord> {
  return environments.toSorted((left, right) => {
    const leftCurrent = left.environmentId === currentEnvironmentId;
    const rightCurrent = right.environmentId === currentEnvironmentId;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
    return (
      left.label.localeCompare(right.label, undefined, { sensitivity: "base", numeric: true }) ||
      left.environmentId.localeCompare(right.environmentId)
    );
  });
}

export function connectMachineCountLabel(count: number): string {
  return count === 1 ? "1 machine linked" : `${count} machines linked`;
}

export function StudioConnectEnvironmentRow(props: {
  readonly environment: RelayClientEnvironmentRecord;
  /** True for the machine this window runs on. */
  readonly current?: boolean;
  readonly confirmationOpen: boolean;
  readonly mutationPending: boolean;
  /** Why the last try to deregister this machine failed; null when it has not. */
  readonly failure?: string | null;
  readonly onConfirmationChange: (open: boolean) => void;
  readonly onDeregister: (environment: RelayClientEnvironmentRecord) => void;
}) {
  const { environment, current = false, failure = null } = props;
  return (
    <ClerkUserProfileRow icon={<ServerIcon className="size-4" />}>
      <Collapsible open={props.confirmationOpen} onOpenChange={props.onConfirmationChange}>
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="min-w-0 flex-1">
            {/* The name wraps instead of being cut: it is how a machine is told apart. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="min-w-0 text-sm leading-5 font-medium wrap-anywhere text-foreground">
                {environment.label}
              </h3>
              {current ? (
                <Badge className="shrink-0" size="sm" variant="info">
                  This machine
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs leading-4.5 text-muted-foreground">
              <LinkedAt value={environment.linkedAt} /> · {endpointLabel(environment)}
            </p>
          </div>
          {/* Neutral on purpose: the red button is the confirmation, one at a time. */}
          <CollapsibleTrigger
            render={
              <Button
                className="shrink-0 self-start sm:self-auto"
                size="sm"
                variant="outline"
                aria-label={`Deregister ${environment.label}`}
                disabled={props.mutationPending}
              >
                Deregister
              </Button>
            }
          />
        </div>

        <CollapsiblePanel>
          <div className="pt-3">
            <div
              className="rounded-lg border border-destructive/24 bg-destructive/4 p-4"
              role="group"
              aria-label={`Confirm deregistration of ${environment.label}`}
            >
              <h4 className="text-sm leading-5 font-semibold text-foreground">
                Deregister “{environment.label}”?
              </h4>
              <p className="mt-1 max-w-xl text-xs leading-4.5 text-pretty text-muted-foreground">
                It loses SpecWithCode Connect access and its managed tunnel, and a host space
                becomes available. Local connections on your devices are not changed.
              </p>
              {current ? (
                <p className="mt-2 text-xs leading-4.5 font-medium text-warning-foreground">
                  This is the machine you are using now. SpecWithCode Connect is turned off on it
                  too.
                </p>
              ) : null}
              {/* In the row, not only a toast: the account window can cover toasts. */}
              {failure !== null ? (
                <p
                  role="alert"
                  className="mt-2 text-xs leading-4.5 font-medium wrap-anywhere text-destructive-foreground"
                >
                  Deregistering did not finish: {failure}
                </p>
              ) : null}
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={props.mutationPending}
                  onClick={() => props.onConfirmationChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  aria-busy={props.mutationPending}
                  disabled={props.mutationPending}
                  onClick={() => props.onDeregister(environment)}
                >
                  {props.mutationPending
                    ? "Deregistering…"
                    : failure !== null
                      ? "Try again"
                      : "Deregister machine"}
                </Button>
              </div>
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </ClerkUserProfileRow>
  );
}

/**
 * The page without its data: every state it can show, so a fixture can render
 * it outside the account modal.
 */
export function StudioConnectMachinesView(props: {
  readonly environments: ReadonlyArray<RelayClientEnvironmentRecord>;
  readonly currentEnvironmentId: EnvironmentId | null;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error: string | null;
  readonly confirmingEnvironmentId: EnvironmentId | null;
  readonly deregisteringEnvironmentId: EnvironmentId | null;
  /** The machine whose last deregistration failed, and why. */
  readonly deregisterFailure?: {
    readonly environmentId: EnvironmentId;
    readonly message: string;
  } | null;
  readonly onRefresh: () => void;
  readonly onConfirmationChange: (environmentId: EnvironmentId | null) => void;
  readonly onDeregister: (environment: RelayClientEnvironmentRecord) => void;
}) {
  const environments = orderConnectMachines(props.environments, props.currentEnvironmentId);
  const mutationPending = props.deregisteringEnvironmentId !== null;
  let body: ReactNode = null;
  if (props.loading) {
    body = <ClerkUserProfileListSkeleton label="Loading machines" />;
  } else if (environments.length > 0) {
    body = (
      <>
        <ClerkUserProfileListCaption>
          {connectMachineCountLabel(environments.length)}
        </ClerkUserProfileListCaption>
        <ClerkUserProfileList label="Machines linked to your account">
          {environments.map((environment) => (
            <StudioConnectEnvironmentRow
              key={environment.environmentId}
              environment={environment}
              current={environment.environmentId === props.currentEnvironmentId}
              confirmationOpen={props.confirmingEnvironmentId === environment.environmentId}
              mutationPending={mutationPending}
              failure={
                props.deregisterFailure?.environmentId === environment.environmentId
                  ? props.deregisterFailure.message
                  : null
              }
              onConfirmationChange={(open) =>
                props.onConfirmationChange(open ? environment.environmentId : null)
              }
              onDeregister={props.onDeregister}
            />
          ))}
        </ClerkUserProfileList>
      </>
    );
  } else if (!props.error) {
    body = (
      <div className="rounded-xl border bg-muted/16">
        <Empty size="compact">
          <EmptyMedia variant="icon">
            <ServerIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No machines linked</EmptyTitle>
            <EmptyDescription>
              Sign in to SpecWithCode Connect on a machine to link it. It then shows up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <ClerkUserProfilePage
      title="Machines"
      description="Machines linked to your SpecWithCode Connect account. Connections on this device are managed in Settings."
      action={
        <ClerkUserProfileRefreshButton
          disabled={mutationPending}
          isPending={props.refreshing}
          onClick={props.onRefresh}
        />
      }
    >
      {props.error ? (
        <ClerkUserProfileError
          title="Could not load your machines"
          detail={props.error}
          retryDisabled={props.refreshing || mutationPending}
          onRetry={props.onRefresh}
        />
      ) : null}
      {body}
    </ClerkUserProfilePage>
  );
}

export function StudioConnectUserProfilePage() {
  const environmentsState = useManagedRelayEnvironments();
  const currentEnvironmentId = usePrimaryEnvironmentId();
  const deregisterEnvironment = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    reportFailure: false,
  });
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const unlinkPrimaryEnvironment = useAtomCommand(unlinkPrimaryEnvironmentCommand, {
    reportFailure: false,
  });
  const [deregisterFailure, setDeregisterFailure] = useState<{
    readonly environmentId: EnvironmentId;
    readonly message: string;
  } | null>(null);
  const [deregisteringEnvironmentId, setDeregisteringEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [confirmingEnvironmentId, setConfirmingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const mutationPendingRef = useRef(false);
  const [removedEnvironments, setRemovedEnvironments] = useState<{
    readonly accountId: string | null;
    readonly linkedAtById: ReadonlyMap<EnvironmentId, string>;
  }>({ accountId: null, linkedAtById: new Map() });

  const handleDeregister = async (environment: RelayClientEnvironmentRecord) => {
    const accountId = environmentsState.accountId;
    if (!accountId || mutationPendingRef.current) return;

    mutationPendingRef.current = true;
    setDeregisteringEnvironmentId(environment.environmentId);
    setDeregisterFailure(null);

    // This machine: turn Connect off here first. Its relay client then lets go
    // of the tunnel the account is about to delete, and its own settings stop
    // saying it is linked. The account's answer below is the result either way.
    const localTarget = primaryCloudLinkState.target;
    if (
      localTarget !== null &&
      localTarget.environmentId === environment.environmentId &&
      readEnvironmentScope(environment.environmentId, AuthRelayWriteScope)
    ) {
      const localResult = await unlinkPrimaryEnvironment({ target: localTarget, clerkToken: null });
      if (localResult._tag === "Failure" && !isAtomCommandInterrupted(localResult)) {
        console.warn("[studio-connect] Could not turn Connect off on this machine", {
          environmentId: environment.environmentId,
          cause: squashAtomCommandFailure(localResult),
        });
      }
      primaryCloudLinkState.refresh();
    }

    const result = await deregisterEnvironment({
      accountId,
      environmentId: environment.environmentId,
    });
    mutationPendingRef.current = false;
    setDeregisteringEnvironmentId(null);
    // Whatever the answer: the account may have removed the machine before a
    // later step failed, so the list is read again on every exit.
    environmentsState.refresh();

    if (result._tag === "Success") {
      setConfirmingEnvironmentId(null);
      setRemovedEnvironments((current) => {
        const linkedAtById = new Map(current.accountId === accountId ? current.linkedAtById : []);
        linkedAtById.set(environment.environmentId, environment.linkedAt);
        return { accountId, linkedAtById };
      });
      toastManager.add({
        type: "success",
        title: "Machine deregistered",
        description: "SpecWithCode Connect access was revoked and a host space is now available.",
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;

    const cause = squashAtomCommandFailure(result);
    const message = cause instanceof Error ? cause.message : "Could not deregister the machine.";
    const traceId = findErrorTraceId(cause);
    setDeregisterFailure({ environmentId: environment.environmentId, message });
    console.error("[studio-connect] Could not deregister environment", {
      environmentId: environment.environmentId,
      message,
      traceId,
      cause,
    });
    toastManager.add({
      type: "error",
      // The account may have removed the machine before a later step failed,
      // so this does not claim that it is still registered.
      title: "Deregistering did not finish",
      description: `${message} The list was read again: a machine missing from it was removed.`,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const removedEnvironmentLinkedAt =
    removedEnvironments.accountId === environmentsState.accountId
      ? removedEnvironments.linkedAtById
      : new Map<EnvironmentId, string>();
  const environments = (environmentsState.data ?? []).filter(
    (environment) =>
      removedEnvironmentLinkedAt.get(environment.environmentId) !== environment.linkedAt,
  );
  const isInitialLoad =
    !environmentsState.accountId || (environmentsState.data === null && !environmentsState.error);

  return (
    <StudioConnectMachinesView
      environments={environments}
      currentEnvironmentId={currentEnvironmentId}
      loading={isInitialLoad}
      refreshing={environmentsState.isPending}
      error={environmentsState.error}
      confirmingEnvironmentId={confirmingEnvironmentId}
      deregisteringEnvironmentId={deregisteringEnvironmentId}
      deregisterFailure={deregisterFailure}
      onRefresh={environmentsState.refresh}
      onConfirmationChange={(environmentId) => {
        setDeregisterFailure(null);
        setConfirmingEnvironmentId(environmentId);
      }}
      onDeregister={(environment) => void handleDeregister(environment)}
    />
  );
}

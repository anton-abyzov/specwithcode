import { CheckIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";

import { cn } from "~/lib/utils";
import { serverEnvironment } from "~/state/server";
import { useEnvironment } from "~/state/environments";
import {
  providerManageBlockedText,
  readEnvironmentScope,
  useEnvironmentScopeAccess,
} from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useLocalEnvironmentUpdateGroups } from "./ProviderUpdateLaunchNotification.environments";
import {
  collectProviderUpdateOutcomeSnapshots,
  firstRejectedProviderUpdateMessage,
  getProviderUpdateProgressToastView,
  getProviderUpdateSidebarPillView,
  isProviderUpdateBlockedInUse,
  isTerminalProviderUpdatePhase,
  resolveEnvironmentUpdateRowStatus,
  type LocalEnvironmentUpdateGroup,
  type LocalProviderUpdateOutcome,
  type ProviderUpdateRowStatus,
  type ProviderUpdateRowStatusKind,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

type ProviderUpdateCommandResult = AtomCommandResult<
  { readonly providers: ReadonlyArray<ServerProvider> },
  unknown
>;

/**
 * Map one targeted instance's update command result into the settled-outcome
 * shape the multi-backend reducers consume: a non-interrupted failure becomes a
 * rejection carrying its message; a success carries the post-update snapshot of
 * the targeted instance (null when the backend did not report it).
 */
function toProviderUpdateOutcome(input: {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  readonly target: {
    readonly driver: ServerProvider["driver"];
    readonly instanceId: ServerProvider["instanceId"];
  };
  readonly result: ProviderUpdateCommandResult;
}): PromiseSettledResult<LocalProviderUpdateOutcome> {
  if (input.result._tag === "Failure") {
    if (isAtomCommandInterrupted(input.result)) {
      // An interrupted dispatch (e.g. superseded) is neither a success nor a
      // hard failure — surface it as a non-contributing, non-rejecting outcome.
      return {
        status: "fulfilled",
        value: {
          environmentId: input.environmentId,
          isPrimary: input.isPrimary,
          driver: input.target.driver,
          instanceId: input.target.instanceId,
          provider: null,
        },
      };
    }
    const error = squashAtomCommandFailure(input.result);
    return {
      status: "rejected",
      reason: error instanceof Error ? error : new Error("Provider update failed."),
    };
  }

  const provider =
    input.result.value.providers.find(
      (candidate) => candidate.instanceId === input.target.instanceId,
    ) ?? null;
  return {
    status: "fulfilled",
    value: {
      environmentId: input.environmentId,
      isPrimary: input.isPrimary,
      driver: input.target.driver,
      instanceId: input.target.instanceId,
      provider,
    },
  };
}

// Transport-hang safety net. The dispatch's `finally` clears the spinner and the
// in-flight guard on completion, so this only matters if a request never resolves
// at all (e.g. the socket drops mid-flight without surfacing an error). Keep it
// well beyond the server's own update timeout (5 min) so a legitimately slow
// update (npm installs routinely run tens of seconds) is never cut off and left
// showing a dead, unresponsive Update button.
const PENDING_EXPIRY_MS = 6 * 60_000;

function rowToneClass(kind: ProviderUpdateRowStatusKind): string {
  switch (kind) {
    case "failed":
      return "text-destructive-foreground";
    case "unchanged":
      return "text-warning-foreground";
    case "success":
      return "text-success-foreground";
    default:
      return "text-muted-foreground";
  }
}

function EnvironmentUpdateRow({
  group,
  status,
  onUpdate,
  onUpdateAnyway,
}: {
  readonly group: LocalEnvironmentUpdateGroup;
  readonly status: ProviderUpdateRowStatus;
  readonly onUpdate: () => void;
  /** Set when the failure was only a running CLI; retries skipping the idle check. */
  readonly onUpdateAnyway?: (() => void) | undefined;
}) {
  const connection = useEnvironment(group.environmentId)?.connection;
  const manageAccess = useEnvironmentScopeAccess(
    group.environmentId,
    AuthProvidersManageScope,
    connection,
  );
  const canManageProviders = manageAccess === "granted";
  const blockedText = providerManageBlockedText(manageAccess);
  let trailing: ReactNode;
  switch (status.kind) {
    case "loading":
      trailing = <Spinner size="md" tone="muted" />;
      break;
    case "success":
      trailing = <CheckIcon aria-hidden="true" className="size-4 text-success-foreground" />;
      break;
    case "failed":
    case "unchanged":
      trailing = (
        <div className="flex gap-1">
          {status.kind === "failed" && onUpdateAnyway ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canManageProviders}
              onClick={onUpdateAnyway}
            >
              Update anyway
            </Button>
          ) : null}
          <Button size="xs" variant="outline" disabled={!canManageProviders} onClick={onUpdate}>
            Retry
          </Button>
        </div>
      );
      break;
    default:
      trailing = (
        <Button size="xs" variant="outline" disabled={!canManageProviders} onClick={onUpdate}>
          Update
        </Button>
      );
      break;
  }

  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{group.label}</span>
        <span className={cn("truncate text-xs", rowToneClass(status.kind))}>{status.text}</span>
        {blockedText ? <span className="text-xs text-muted-foreground">{blockedText}</span> : null}
      </div>
      <div className="shrink-0">{trailing}</div>
    </div>
  );
}

/**
 * The launch popover's body when WSL is present: one row per local environment
 * (Windows + WSL), each with its own "update all" trigger that targets only
 * that environment's backend.
 */
export function ProviderUpdateEnvironmentRows({
  onInteract,
}: {
  /** Called the first time the user triggers an update, so the host can stop refreshing the prompt. */
  readonly onInteract?: () => void;
}) {
  const { groups } = useLocalEnvironmentUpdateGroups();
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const groupByEnvironment = useMemo(
    () => new Map(groups.map((group) => [group.environmentId, group] as const)),
    [groups],
  );

  // Only surface results that land after this popover opened.
  const visibleAfterIsoRef = useRef<string>(new Date().toISOString());

  // Synchronous re-entry guard. setPendingEnvironments is an async state update,
  // and PENDING_EXPIRY_MS can clear the spinner while a request is still in
  // flight, so a rapid double-click (or a click after the expiry fires mid-
  // request) would otherwise dispatch a second full round of updates. A ref
  // updates synchronously, so we can bail before doing any work.
  const inFlightEnvironmentsRef = useRef<Set<EnvironmentId>>(new Set());

  // Monotonic per-environment request version. Bumped on each dispatch and
  // captured locally, so an attempt that was superseded -- e.g. one that already
  // tripped the expiry safety net and was retried -- detects it is no longer
  // current and skips every state write when it finally resolves, instead of
  // clobbering the newer attempt's spinner/result/error or its in-flight guard.
  const requestVersionRef = useRef<Map<EnvironmentId, number>>(new Map());

  const [pendingEnvironments, setPendingEnvironments] = useState<ReadonlySet<EnvironmentId>>(
    () => new Set(),
  );
  const [errorByEnvironment, setErrorByEnvironment] = useState<ReadonlyMap<EnvironmentId, string>>(
    () => new Map(),
  );
  const [resultByEnvironment, setResultByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ProviderUpdateToastView>
  >(() => new Map());
  // Per environment, the instances whose last update was refused only because
  // their CLI was running. "Update anyway" forces exactly these.
  const [inUseByEnvironment, setInUseByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ReadonlySet<ProviderInstanceId>>
  >(() => new Map());

  const clearPending = useCallback((environmentId: EnvironmentId) => {
    setPendingEnvironments((previous) => {
      if (!previous.has(environmentId)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(environmentId);
      return next;
    });
  }, []);

  const handleUpdate = useCallback(
    // `forceInstanceIds` comes only from "Update anyway": it dispatches just those
    // in-use instances, each with `force`, and leaves the other candidates alone.
    async (environmentId: EnvironmentId, forceInstanceIds?: ReadonlySet<ProviderInstanceId>) => {
      if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
      const group = groupByEnvironment.get(environmentId);
      if (!group || group.candidates.length === 0) {
        return;
      }
      if (inFlightEnvironmentsRef.current.has(environmentId)) {
        return;
      }
      inFlightEnvironmentsRef.current.add(environmentId);
      const requestVersion = (requestVersionRef.current.get(environmentId) ?? 0) + 1;
      requestVersionRef.current.set(environmentId, requestVersion);
      const isCurrentRequest = () =>
        requestVersionRef.current.get(environmentId) === requestVersion;
      onInteract?.();
      const force = forceInstanceIds !== undefined;
      const targets = group.candidates
        .filter((candidate) => !force || forceInstanceIds.has(candidate.instanceId))
        .map((candidate) => ({
          driver: candidate.driver,
          instanceId: candidate.instanceId,
        }));
      if (targets.length === 0) {
        inFlightEnvironmentsRef.current.delete(environmentId);
        return;
      }
      const providerCount = targets.length;

      setPendingEnvironments((previous) => new Set(previous).add(environmentId));
      setErrorByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });
      setResultByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });
      setInUseByEnvironment((previous) => {
        if (!previous.has(environmentId)) {
          return previous;
        }
        const next = new Map(previous);
        next.delete(environmentId);
        return next;
      });

      const expiry = setTimeout(() => {
        // A newer attempt may have superseded this one; if so, leave its state
        // untouched.
        if (!isCurrentRequest()) {
          return;
        }
        // The request is presumed dead (see PENDING_EXPIRY_MS). Clear the
        // spinner AND the in-flight guard together so the row never strands on a
        // dead Update button, and surface feedback so the timeout is visible
        // rather than silently reverting to idle.
        inFlightEnvironmentsRef.current.delete(environmentId);
        clearPending(environmentId);
        setErrorByEnvironment((previous) =>
          new Map(previous).set(environmentId, "Update timed out — try again."),
        );
      }, PENDING_EXPIRY_MS);
      try {
        // Dispatch each candidate's update to this environment's own backend and
        // normalize every settled outcome into the multi-backend reducer shape.
        const results = await Promise.all(
          targets.map(async (target): Promise<PromiseSettledResult<LocalProviderUpdateOutcome>> => {
            try {
              const result = await updateProvider({
                environmentId,
                input: {
                  provider: target.driver,
                  instanceId: target.instanceId,
                  ...(force ? { force: true } : {}),
                },
              });
              return toProviderUpdateOutcome({
                environmentId,
                isPrimary: group.isPrimary,
                target,
                result,
              });
            } catch (error) {
              return {
                status: "rejected",
                reason: error instanceof Error ? error : new Error("Provider update failed."),
              };
            }
          }),
        );
        if (!isCurrentRequest()) {
          // A newer attempt superseded this one while it was in flight; leave
          // the newer attempt's state intact.
          return;
        }
        // The request resolved (not a transport hang), so clear any stale
        // timeout error the expiry may have set -- otherwise a late success
        // would be masked, since an error takes priority in the row status.
        setErrorByEnvironment((previous) => {
          if (!previous.has(environmentId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(environmentId);
          return next;
        });
        if (results.length === 0) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(
              environmentId,
              "This environment isn’t connected — try again once it reconnects.",
            ),
          );
          return;
        }
        const rejectedMessage = firstRejectedProviderUpdateMessage(results);
        if (rejectedMessage) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(environmentId, rejectedMessage),
          );
          return;
        }
        const snapshots = collectProviderUpdateOutcomeSnapshots(results);
        const inUseInstanceIds = new Set<ProviderInstanceId>();
        for (const outcome of results) {
          if (
            outcome.status === "fulfilled" &&
            outcome.value.provider &&
            isProviderUpdateBlockedInUse(outcome.value.provider)
          ) {
            inUseInstanceIds.add(outcome.value.provider.instanceId);
          }
        }
        if (inUseInstanceIds.size > 0) {
          setInUseByEnvironment((previous) =>
            new Map(previous).set(environmentId, inUseInstanceIds),
          );
        }
        const view = getProviderUpdateProgressToastView({
          providers: snapshots,
          providerCount,
        });
        // Only persist a terminal outcome. A non-terminal ("running"/"initial")
        // view means this dispatch could not confirm completion — e.g. a snapshot
        // came back without its targeted instance (collectProviderUpdateOutcome-
        // Snapshots drops null providers), which happens when the command is
        // interrupted as a second backend connects and supersedes the in-flight
        // update. A stored view never re-polls, so persisting it would pin the
        // row's spinner forever once the pending flag expires. Drop it and let
        // the live per-environment provider state (pill) plus the pending expiry
        // drive the row, so it self-heals to whatever the backend actually did.
        if (isTerminalProviderUpdatePhase(view.phase)) {
          setResultByEnvironment((previous) => new Map(previous).set(environmentId, view));
        }
      } catch (error) {
        if (isCurrentRequest()) {
          setErrorByEnvironment((previous) =>
            new Map(previous).set(
              environmentId,
              error instanceof Error ? error.message : "Provider update failed.",
            ),
          );
        }
      } finally {
        clearTimeout(expiry);
        // Only the current attempt owns the shared spinner and in-flight guard;
        // a superseded attempt resolving late must not clear a newer one's.
        if (isCurrentRequest()) {
          clearPending(environmentId);
          inFlightEnvironmentsRef.current.delete(environmentId);
        }
      }
    },
    [clearPending, groupByEnvironment, onInteract, updateProvider],
  );

  const rows = groups
    .map((group) => ({
      group,
      status: resolveEnvironmentUpdateRowStatus({
        group,
        error: errorByEnvironment.get(group.environmentId),
        result: resultByEnvironment.get(group.environmentId),
        // Derive the live pill from the candidates this row is actually
        // tracking, not every provider in the environment. Otherwise an
        // unrelated provider's recent success (or one candidate succeeding while
        // another was interrupted) makes the pill report success and hides the
        // Update action for candidates that are still outdated.
        pill: getProviderUpdateSidebarPillView(group.candidates, {
          visibleAfterIso: visibleAfterIsoRef.current,
        }),
        isPending: pendingEnvironments.has(group.environmentId),
      }),
    }))
    .filter(({ group, status }) => group.candidates.length > 0 || status.kind !== "idle");

  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {rows.map(({ group, status }) => {
        const inUse = new Set(inUseByEnvironment.get(group.environmentId));
        for (const candidate of group.candidates) {
          if (isProviderUpdateBlockedInUse(candidate)) inUse.add(candidate.instanceId);
        }
        return (
          <EnvironmentUpdateRow
            key={group.environmentId}
            group={group}
            status={status}
            onUpdate={() => handleUpdate(group.environmentId)}
            onUpdateAnyway={
              inUse.size > 0 ? () => handleUpdate(group.environmentId, inUse) : undefined
            }
          />
        );
      })}
    </div>
  );
}

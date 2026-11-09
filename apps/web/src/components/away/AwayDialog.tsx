/**
 * The Away dialog: pick the machine to leave work on, see what would move,
 * stay or pause and why, and ask that machine for every missing grant with
 * one "Request access". The plan re-runs once the request is approved.
 * Every entry point (`/away`, the palette, the hotkey, the menu and the
 * tray) opens it through `requestAway`.
 */
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  type AwayAccessRequestResult,
  type AwayPlan,
  type AwayPlanItem,
  type AwaySession,
  type AwaySnapshot,
  awaitsBringBack,
  type EnvironmentId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAwayRequest, type AwayIntent } from "../../studio/awayRequest";
import { useHandoffModeSnapshot } from "../../studio/handoffMode";
import { cn } from "~/lib/utils";
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
import type { HandoffDestination } from "../handoff/HandoffResults";
import { destinationOptions, MachineOptionRows } from "../handoff/MachineOptionRows";
import { useHandoffDestinations } from "../handoff/useHandoffDestinations";
import {
  AWAY_ACCESS_POLL_MS,
  accessRequestText,
  awayActionLabel,
  awayActionTone,
  awayPlanSummary,
  canRequestAccess,
  defaultAwayTarget,
  groupAwayPlan,
  isAccessPending,
  missingIsOnTarget,
} from "./awayDialog.logic";
import { AwayAccessRequestsWatcher } from "./AwayAccessRequests";
import { awayRpc, runAway } from "./awayRpc";
import {
  AWAY_SESSION_POLL_MS,
  canBringBackSession,
  runHereAnywayConfirmText,
  showRunHereAnyway,
} from "./awaySession.logic";
import { AwaySessionSummary } from "./AwaySessionSummary";
import { AwayWakeCard } from "./AwayWakeCard";
import { buildThreadRouteParams } from "../../threadRoutes";

export function AwayDialogHost() {
  const request = useAwayRequest();
  const environmentId = usePrimaryEnvironmentId();
  return (
    <>
      {/* Access requests other machines send here, on every connected machine. */}
      <AwayAccessRequestsWatcher />
      {/* Work left this machine and is not back: one click brings it back (D-02). */}
      {environmentId ? <AwayWakeCard environmentId={environmentId} hidden={request.open} /> : null}
      {request.open && environmentId ? (
        <AwayDialog environmentId={environmentId} intent={request.intent} onClose={request.close} />
      ) : null}
    </>
  );
}

function AwayDialog(props: {
  environmentId: EnvironmentId;
  intent: AwayIntent;
  onClose: () => void;
}) {
  const { environmentId } = props;
  const destinations = useHandoffDestinations(environmentId, false);
  const remembered = useHandoffModeSnapshot(environmentId).snapshot?.config.sleepTarget ?? null;
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const configs = useServerConfigs();
  const target =
    chosen ??
    defaultAwayTarget(destinations, remembered, (id) => {
      const config = configs.get(id);
      return config === undefined
        ? null
        : {
            machine:
              config.settings?.environmentIcon ?? config.environment.platform.machine ?? null,
            os: config.environment.platform.os,
          };
    });
  const [plan, setPlan] = useState<AwayPlan | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recheck, setRecheck] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const [request, setRequest] = useState<AwayAccessRequestResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const router = useRouter();
  const [away, setAway] = useState<AwaySnapshot | null>(null);
  // When the snapshot was read: Run here anyway is judged against it, not during render.
  const [awayReadAt, setAwayReadAt] = useState(0);
  const [started, setStarted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [acting, setActing] = useState(false);
  const [actError, setActError] = useState<string | null>(null);

  // The saved session: read on open, then followed while leaving or Bring back runs.
  const following = acting || away?.running === true;
  useEffect(() => {
    let live = true;
    const read = () =>
      void runAway(awayRpc.snapshot, { environmentId, input: {} }).then((next) => {
        if (!live || !next.ok) return;
        setAway(next.value);
        setAwayReadAt(Date.now());
      });
    read();
    if (!following) return () => void (live = false);
    const timer = setInterval(read, AWAY_SESSION_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [environmentId, following]);

  const leave = () => {
    if (target === null) return;
    setActing(true);
    setActError(null);
    void runAway(awayRpc.start, {
      environmentId,
      input: { targetEnvironmentId: target, coordinatorScope: "live", trigger: "manual" },
    }).then((next) => {
      setActing(false);
      setConfirming(false);
      if (!next.ok) {
        setActError(next.error);
        return;
      }
      setStarted(true);
      setAway((current) =>
        current === null ? current : { ...current, session: next.value, running: true },
      );
    });
  };
  const bringBack = () => {
    const session = away?.session;
    if (!session) return;
    setActing(true);
    setActError(null);
    void runAway(awayRpc.bringBack, {
      environmentId,
      input: { sessionId: session.sessionId },
    }).then((next) => {
      setActing(false);
      if (!next.ok) {
        setActError(next.error);
        return;
      }
      setAway((current) =>
        current === null ? current : { ...current, session: next.value, running: true },
      );
    });
  };
  const forceLocal = () => {
    const session = away?.session;
    if (!session) return;
    setActing(true);
    setActError(null);
    void runAway(awayRpc.forceLocal, {
      environmentId,
      input: { sessionId: session.sessionId },
    }).then((next) => {
      setActing(false);
      if (!next.ok) {
        setActError(next.error);
        return;
      }
      setAway((current) => (current === null ? current : { ...current, session: next.value }));
    });
  };
  const session = away?.session ?? null;
  const showSession =
    props.intent === "back" ||
    started ||
    (session !== null &&
      (away?.running === true || session.finishedAt === null || awaitsBringBack(session)));

  // The plan for the chosen machine; runs again on "Check again" and after approval.
  useEffect(() => {
    if (props.intent !== "away" || target === null) return;
    let live = true;
    setChecking(true);
    setError(null);
    void runAway(awayRpc.preflight, {
      environmentId,
      input: { targetEnvironmentId: target, coordinatorScope: "live" },
    }).then((next) => {
      if (!live) return;
      setChecking(false);
      if (next.ok) setPlan(next.value);
      else {
        setPlan(null);
        setError(next.error);
      }
    });
    return () => {
      live = false;
    };
  }, [environmentId, props.intent, recheck, target]);

  // While the target's owner has not answered, ask now and then; approval re-checks the plan.
  const pendingId = isAccessPending(request) ? request!.requestId : null;
  useEffect(() => {
    if (pendingId === null || target === null) return;
    let live = true;
    const timer = setInterval(() => {
      void runAway(awayRpc.accessStatus, {
        environmentId,
        input: { targetEnvironmentId: target, requestId: pendingId },
      }).then((next) => {
        if (!live || !next.ok) return;
        setRequest(next.value);
        if (next.value.status === "approved") setRecheck((count) => count + 1);
      });
    }, AWAY_ACCESS_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [environmentId, pendingId, target]);

  const pick = (next: EnvironmentId) => {
    setChosen(next);
    setPlan(null);
    setRequest(null);
    setRequestError(null);
  };

  const requestAccess = () => {
    if (plan === null) return;
    setRequesting(true);
    setRequestError(null);
    void runAway(awayRpc.requestAccess, {
      environmentId,
      input: { targetEnvironmentId: plan.targetEnvironmentId, missing: plan.missingGrants },
    }).then((next) => {
      setRequesting(false);
      if (next.ok) setRequest(next.value);
      else setRequestError(next.error);
    });
  };

  return (
    <AwayDialogView
      intent={props.intent}
      destinations={destinations}
      target={target}
      onTarget={pick}
      plan={plan?.targetEnvironmentId === target ? plan : null}
      checking={checking}
      error={error}
      requesting={requesting}
      request={request}
      requestError={requestError}
      onRequestAccess={requestAccess}
      onRecheck={() => setRecheck((count) => count + 1)}
      onClose={props.onClose}
      session={showSession ? session : null}
      running={away?.running === true || acting}
      selfEnvironmentId={environmentId}
      selfLabel={away?.machineLabel ?? "this machine"}
      confirming={confirming}
      actError={actError}
      onLeave={() => setConfirming(true)}
      onCancelLeave={() => setConfirming(false)}
      onConfirmLeave={leave}
      onBringBack={bringBack}
      runHereAnyway={showRunHereAnyway(away, awayReadAt)}
      onRunHereAnyway={forceLocal}
      onOpenThread={(threadId, environment) => {
        props.onClose();
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environment, threadId as ThreadId)),
        });
      }}
    />
  );
}

export interface AwayDialogViewProps {
  intent: AwayIntent;
  destinations: readonly HandoffDestination[];
  target: EnvironmentId | null;
  onTarget: (environmentId: EnvironmentId) => void;
  plan: AwayPlan | null;
  checking: boolean;
  error: string | null;
  requesting: boolean;
  request: AwayAccessRequestResult | null;
  requestError: string | null;
  onRequestAccess: () => void;
  onRecheck: () => void;
  onClose: () => void;
  /** The session to show instead of the plan: after Leave, while it runs, or to bring back. */
  session?: AwaySession | null;
  running?: boolean;
  selfEnvironmentId?: EnvironmentId;
  selfLabel?: string;
  /** Leave was pressed once; the second press moves the work. */
  confirming?: boolean;
  actError?: string | null;
  onLeave?: () => void;
  onCancelLeave?: () => void;
  onConfirmLeave?: () => void;
  onBringBack?: () => void;
  /** The target stayed silent ten minutes after a wake: offer Run here anyway. */
  runHereAnyway?: boolean;
  onRunHereAnyway?: () => void;
  onOpenThread?: (threadId: string, environmentId: EnvironmentId) => void;
}

const TONE = {
  ready: "text-success-foreground",
  attention: "text-warning-foreground",
  muted: "text-muted-foreground",
} as const;

function PlanRow({ item }: { item: AwayPlanItem }) {
  return (
    <li
      className="flex items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm"
      data-away-action={item.action}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">{item.title}</span>
        <span className="text-xs text-muted-foreground">{item.reason}</span>
      </span>
      <span className={cn("shrink-0 text-xs font-medium", TONE[awayActionTone(item.action)])}>
        {awayActionLabel(item.action)}
      </span>
    </li>
  );
}

/** Run here anyway, behind a confirm that says both machines may then run the coordinator. */
export function RunHereAnyway(props: {
  targetLabel: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      className={cn("flex flex-col gap-2 text-sm", props.className ?? "px-6")}
      data-testid="away-run-here-anyway"
    >
      {confirming ? (
        <p role="status" className="text-warning-foreground">
          {runHereAnywayConfirmText(props.targetLabel)}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        {confirming ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="destructive-outline"
          onClick={() => (confirming ? props.onConfirm() : setConfirming(true))}
        >
          {confirming ? "Run here anyway" : "Run here anyway…"}
        </Button>
      </div>
    </div>
  );
}

export function AwayDialogView(props: AwayDialogViewProps) {
  const groups = useMemo(() => (props.plan ? groupAwayPlan(props.plan) : []), [props.plan]);
  const targetLabel =
    props.destinations.find((item) => item.environmentId === props.target)?.label ??
    props.plan?.targetLabel ??
    "the other machine";
  const plan = props.plan;
  const pending = isAccessPending(props.request);
  const requestLine = accessRequestText(props.request, targetLabel);

  if (props.intent === "back" || props.session) {
    const session = props.session ?? null;
    const canBringBack = canBringBackSession(session, props.running === true);
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
        <DialogPopup className="sm:max-w-xl" data-testid="away-session-dialog">
          <DialogHeader>
            <DialogTitle>
              {session === null
                ? "Bring work back"
                : session.bringBackStartedAt !== null || props.intent === "back"
                  ? `Bring work back from ${session.targetLabel}`
                  : `Away on ${session.targetLabel}`}
            </DialogTitle>
            <DialogDescription>
              {session === null
                ? "Nothing left this machine."
                : "Threads continue there, routines keep their schedule, and nothing runs on both machines."}
            </DialogDescription>
          </DialogHeader>
          {session ? (
            <DialogPanel>
              <AwaySessionSummary
                session={session}
                running={props.running === true}
                selfEnvironmentId={props.selfEnvironmentId ?? session.targetEnvironmentId}
                selfLabel={props.selfLabel ?? "this machine"}
                {...(props.onOpenThread ? { onOpenThread: props.onOpenThread } : {})}
              />
            </DialogPanel>
          ) : null}
          {props.actError ? (
            <p role="alert" className="px-6 text-sm text-destructive-foreground">
              {props.actError}
            </p>
          ) : null}
          {session !== null && props.runHereAnyway && props.onRunHereAnyway ? (
            <RunHereAnyway targetLabel={session.targetLabel} onConfirm={props.onRunHereAnyway} />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              {props.running ? "Hide" : "Done"}
            </Button>
            {session !== null && session.broughtBackAt === null ? (
              <Button
                type="button"
                disabled={!canBringBack || !props.onBringBack}
                onClick={props.onBringBack}
              >
                {props.running && session.bringBackStartedAt !== null
                  ? "Bringing back…"
                  : "Bring back"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="sm:max-w-xl" data-testid="away-dialog">
        <DialogHeader>
          <DialogTitle>Leave this machine</DialogTitle>
          <DialogDescription>
            Pick the machine that keeps working while you are away. Nothing changes until you leave.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <fieldset className="flex min-w-0 flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">Leave work on</legend>
              {props.destinations.length > 0 ? (
                <MachineOptionRows
                  aria-label="Leave work on"
                  options={destinationOptions(props.destinations)}
                  value={props.target}
                  onChange={(value) => props.onTarget(value as EnvironmentId)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No other machine is paired. Pair one in Settings &gt; Machines.
                </p>
              )}
            </fieldset>

            {props.checking && plan === null ? (
              <p role="status" className="text-sm text-muted-foreground">
                {`Checking ${targetLabel}…`}
              </p>
            ) : null}
            {props.error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {props.error}
              </p>
            ) : null}

            {plan ? (
              <>
                <p className="text-sm text-muted-foreground" data-testid="away-plan-summary">
                  {awayPlanSummary(plan)}
                </p>
                {groups.map((group) => (
                  <section key={group.kind} className="flex flex-col gap-1.5">
                    <h3 className="text-sm font-medium">{`${group.title} (${group.items.length})`}</h3>
                    <ul className="flex flex-col gap-1.5" aria-label={group.title}>
                      {group.items.map((item) => (
                        <PlanRow key={`${item.kind}:${item.id}`} item={item} />
                      ))}
                    </ul>
                  </section>
                ))}
                {plan.missingGrants.length > 0 ? (
                  <section
                    className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3"
                    aria-label="Missing access"
                    data-testid="away-missing"
                  >
                    <h3 className="text-sm font-medium">{`Needed first (${plan.missingGrants.length})`}</h3>
                    <ul className="flex flex-col gap-1.5 text-sm">
                      {plan.missingGrants.map((gap) => (
                        <li
                          key={`${gap.kind}:${gap.machineEnvironmentId}:${gap.projectId ?? ""}:${gap.detail}`}
                          className="flex flex-col gap-0.5"
                        >
                          <span>{gap.detail}</span>
                          <span className="text-xs text-muted-foreground">
                            {missingIsOnTarget(gap, plan.targetEnvironmentId)
                              ? gap.fix
                              : `On this machine: ${gap.fix}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {canRequestAccess(plan) ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={props.requesting || pending}
                          onClick={props.onRequestAccess}
                        >
                          {props.requesting
                            ? "Sending…"
                            : pending
                              ? "Request sent"
                              : "Request access"}
                        </Button>
                        {requestLine ? (
                          <span role="status" className="text-xs text-muted-foreground">
                            {requestLine}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {props.requestError ? (
                      <p role="alert" className="text-xs text-destructive-foreground">
                        {props.requestError}
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : null}
            {props.confirming && plan ? (
              <p role="status" className="text-sm" data-testid="away-confirm">
                {`Running and queued threads, routines and coordinators listed as Moves go to ${targetLabel} now. The rest stay here and are listed in the summary. ${targetLabel} becomes your Away target: the next Leave and closing the lid use it. Change it in Settings, Machines.`}
              </p>
            ) : null}
            {props.actError ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                {props.actError}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={props.checking || props.target === null}
            onClick={props.onRecheck}
          >
            {props.checking ? "Checking…" : "Check again"}
          </Button>
          {props.confirming ? (
            <>
              <Button type="button" variant="outline" onClick={props.onCancelLeave}>
                Not now
              </Button>
              <Button
                type="button"
                disabled={props.running === true || props.onConfirmLeave === undefined}
                onClick={props.onConfirmLeave}
              >
                {props.running ? "Leaving…" : `Leave for ${targetLabel}`}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={plan === null || props.checking || props.onLeave === undefined}
              onClick={props.onLeave}
            >
              Leave
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

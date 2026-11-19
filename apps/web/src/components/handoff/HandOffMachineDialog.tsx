import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  HANDOFF_BATCH_MAX_PROJECTS,
  type EnvironmentId,
  type HandoffMachineRun,
  type HandoffPlanView,
  type HandoffPreflightResult,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { create } from "zustand";

import { englishPhrase, useTx, type TranslatePhrase } from "../../i18n";
import { useProjects, useThreadShells } from "../../state/entities";
import { randomUUID } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScopeAccess } from "../../state/session";
import { handoffBatch } from "../../studio/handoffBatch";
import {
  handoffMode,
  refreshHandoffMode,
  runHandoffMode,
  useHandoffModeSnapshot,
} from "../../studio/handoffMode";
import { useMachineNicknames } from "../../studio/machineNickname";
import {
  HANDOFF_BATCH_LIMIT,
  handoffCheckRequest,
  handoffMachineRows,
  initialHandoffTicks,
  sentHandoffRows,
  toggleHandoffTick,
  type HandoffMachineGroup,
  type HandoffMachineThreadRow,
} from "./handOffMachineRows";
import {
  automaticDestinations,
  folderWorkTicked,
  handoffUsageLines,
  movablePlanIds,
  planHandoffRows,
  threadsTicked,
} from "./handOffMachinePlan";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  HandOffProgress,
  HandOffProgressDialogHost,
  useHandOffProgressGroups,
} from "./HandOffProgress";
import {
  HandoffMachineResults,
  HandoffPreflightFailures,
  destinationNeedsUpdate,
  destinationsNeedingUpdate,
  destinationUpdateRows,
  pickDestination,
  preflightSummary,
  type HandoffDestination,
} from "./HandoffResults";
import { HandoffDestinationUpdate } from "./HandoffDestinationUpdate";
import { submittedGroups } from "./handOffProgress.logic";
import { destinationOptions, MachineOptionRows } from "./MachineOptionRows";
import { useHandoffDestinations } from "./useHandoffDestinations";

interface HandOffMachineRequest {
  readonly environmentId: EnvironmentId | null;
  /** Lists only this project's threads: the scope the machine menu opens it with. */
  readonly project?: { readonly id: ProjectId; readonly title: string } | undefined;
}

const useRequest = create<{ request: HandOffMachineRequest | null }>(() => ({
  request: null,
}));

/** Opens "Hand off work from {machine}"; without an id, for the machine this window serves. */
export function requestHandOffMachine(environmentId: EnvironmentId | null = null) {
  useRequest.setState({ request: { environmentId } });
}

/**
 * Opens the same dialog with one project as its scope, on the machine that
 * holds its threads. Each thread is checked against the chosen destination
 * before anything goes; coordinator conversations and routines are not listed
 * and do not move.
 */
export function requestMigrateProjectThreads(
  environmentId: EnvironmentId,
  project: { readonly id: ProjectId; readonly title: string },
) {
  useRequest.setState({ request: { environmentId, project } });
}

const close = () => useRequest.setState({ request: null });

/** Closes the dialog from outside it. */
export const closeHandOffMachine = close;

/** The open request outside React, for tests and non-component callers. */
export function readHandOffMachineRequest(): HandOffMachineRequest | null {
  return useRequest.getState().request;
}

export function HandOffMachineDialogHost() {
  const request = useRequest((state) => state.request);
  const primary = usePrimaryEnvironmentId();
  const environmentId = request?.environmentId ?? primary;
  return (
    <>
      {request && environmentId ? (
        <HandOffMachineDialog
          key={`${environmentId}:${request.project?.id ?? ""}`}
          environmentId={environmentId}
          project={request.project ?? null}
        />
      ) : null}
      <HandOffProgressDialogHost environmentId={primary} />
    </>
  );
}

export type { HandoffMachineThreadRow } from "./handOffMachineRows";

/** Each group's legend and list name, in the order AC-17 lists them. */
const GROUPS: ReadonlyArray<{
  readonly group: HandoffMachineGroup;
  readonly legend: string;
  readonly list: string;
}> = [
  { group: "running", legend: "Running ({n})", list: "Running threads" },
  { group: "queued", legend: "Queued ({n})", list: "Queued" },
  {
    group: "waiting",
    legend: "Waiting for your next message ({n})",
    list: "Waiting for your next message",
  },
  {
    group: "unsaved",
    legend: "Not running with unsaved work ({n})",
    list: "Not running with unsaved work",
  },
  { group: "folder-work", legend: "Project folder work ({n})", list: "Project folder work" },
  { group: "stays", legend: "Stays ({n})", list: "Stays here" },
];

export interface HandOffMachineDialogViewProps {
  machineName: string;
  /** The scope: one project's threads, or every project on the machine when absent. */
  projectName?: string | null;
  destinations: readonly HandoffDestination[];
  destinationId: EnvironmentId | null;
  onDestination: (environmentId: EnvironmentId) => void;
  /** What each machine adds per provider, as its plan said (AC-22); absent when not read. */
  usage?: ReadonlyMap<EnvironmentId, readonly string[]>;
  /**
   * False until the chosen machine's measured plan arrived: nothing can be sent on
   * the window's own rows or an unweighed plan. Absent reads as ready (fixtures).
   */
  planReady?: boolean;
  threads: readonly HandoffMachineThreadRow[];
  selected: ReadonlySet<ThreadId>;
  /** More rows are ticked than one hand off takes: the first ones go. */
  overLimit?: boolean;
  onToggle: (threadId: ThreadId, selected: boolean) => void;
  checking: boolean;
  preflight: ReadonlyMap<ThreadId, HandoffPreflightResult>;
  preflightError: string | null;
  /** Runs the checks again, for example after the destination updated. */
  onRecheck?: () => void;
  /** Update for the destination when its version check says to update it first. */
  destinationUpdate?: ReactNode;
  submitting: boolean;
  error: string | null;
  run: HandoffMachineRun | null;
  /**
   * The progress view of this hand off, once the machine has written its
   * records. It replaces the form while the hand off runs and after it.
   */
  progress?: ReactNode;
  destinationName: string;
  onSubmit: () => void;
  onCancel: () => void;
  onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}

/** The dialog's title: "Hand off work from Laptop". */
export function handOffMachineTitle(
  machineName: string,
  tx: TranslatePhrase = englishPhrase,
): string {
  return tx("Hand off work from {machine}", { machine: machineName });
}

/** The scope line: one project, or every project on the machine. */
export function handOffMachineScope(
  machineName: string,
  projectName: string | null | undefined,
  tx: TranslatePhrase = englishPhrase,
): string {
  return projectName
    ? tx("Scope: {project}", { project: projectName })
    : tx("Scope: every project on {machine}", { machine: machineName });
}

/** The primary button: "Hand off to Desk", "Checking…", or "Nothing can go" when none passed. */
export function handOffMachinePrimaryLabel(
  state: {
    submitting: boolean;
    checking: boolean;
    movable: number;
    machine?: string | null;
  },
  tx: TranslatePhrase = englishPhrase,
): string {
  if (state.submitting) return tx("Handing off…");
  if (state.checking) return tx("Checking…");
  if (state.movable === 0) return tx("Nothing can go");
  return state.machine ? tx("Hand off to {machine}", { machine: state.machine }) : tx("Hand off");
}

/** The dialog's body, without data wiring, so fixtures and tests can render each state. */
export function HandOffMachineDialogView(props: HandOffMachineDialogViewProps) {
  const tx = useTx();
  const isSelected = (threadId: ThreadId) => props.selected.has(threadId);
  // While a check runs, earlier results are stale: nothing counts as ready until it finishes.
  const resultFor = (threadId: ThreadId) =>
    props.checking ? undefined : props.preflight.get(threadId);
  // Folder work needs no thread check: ticked, it goes with the hand off.
  const movable = props.threads.filter(
    (thread) =>
      isSelected(thread.threadId) &&
      (thread.kind === "folder-work" ? !props.checking : resultFor(thread.threadId)?.ok),
  ).length;
  const failed =
    props.preflightError !== null ||
    props.threads.some(
      (thread) => isSelected(thread.threadId) && resultFor(thread.threadId)?.ok === false,
    );
  const noneOnline = !props.destinations.some((item) => item.state === "reachable");
  const canGo = props.threads.filter(
    (thread) => groupOf(thread) !== "stays" && thread.canTick !== false,
  ).length;
  const destinationName = props.destinationName || tx("the other machine");
  // Once the machine has records of this hand off, the view shows them; the server finishes
  // the hand off without this window, so the dialog can be closed.
  const leaving = props.progress !== undefined && props.progress !== null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && (!props.submitting || leaving)) props.onCancel();
      }}
    >
      <DialogPopup className="sm:max-w-lg" showCloseButton={!props.submitting || leaving}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !props.run &&
              !props.submitting &&
              !props.checking &&
              props.planReady !== false &&
              movable > 0
            )
              props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{handOffMachineTitle(props.machineName, tx)}</DialogTitle>
            {props.run || leaving ? null : (
              <DialogDescription>
                {tx(
                  "Tick what goes. It continues on the machine you pick. Anything that cannot go stays here, untouched, with its reason.",
                )}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogPanel>
            {leaving ? (
              <div className="flex flex-col gap-3">
                {/* What this window asked may have failed while its records were written. */}
                {props.error ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {props.error}
                  </p>
                ) : null}
                {props.progress}
              </div>
            ) : props.run ? (
              <HandoffMachineResults
                run={props.run}
                destinationName={props.destinationName}
                onOpenThread={props.onOpenThread}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground" data-slot="hand-off-scope">
                  {handOffMachineScope(props.machineName, props.projectName, tx)}
                </p>
                <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={props.submitting}>
                  <legend className="mb-1.5 text-sm font-medium">{tx("Hand off to")}</legend>
                  {props.destinations.length > 0 ? (
                    <MachineOptionRows
                      aria-label={tx("Hand off to")}
                      options={destinationOptions(props.destinations, props.usage)}
                      value={props.destinationId}
                      disabled={props.submitting}
                      onChange={(value) => props.onDestination(value as EnvironmentId)}
                    />
                  ) : null}
                  {noneOnline ? (
                    <p className="text-sm text-muted-foreground">
                      No other machine is online. Pair one in Settings › Machines.
                    </p>
                  ) : null}
                </fieldset>
                {canGo === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {props.projectName
                      ? tx("Nothing in {project} on {machine} can go.", {
                          project: props.projectName,
                          machine: props.machineName,
                        })
                      : tx("Nothing here can go.")}
                  </p>
                ) : null}
                {GROUPS.map(({ group, legend, list }) => {
                  const rows = props.threads.filter((thread) => groupOf(thread) === group);
                  if (rows.length === 0) return null;
                  return (
                    <fieldset
                      key={group}
                      className="flex min-w-0 flex-col gap-1.5"
                      disabled={props.submitting}
                    >
                      <legend className="mb-1.5 text-sm font-medium">
                        {tx(legend, { n: rows.length })}
                      </legend>
                      <ul className="flex flex-col gap-1.5" aria-label={tx(list)}>
                        {rows.map((thread) =>
                          group === "stays" || thread.canTick === false ? (
                            <li
                              key={thread.threadId}
                              data-thread-status={group === "stays" ? "stays" : "listed"}
                            >
                              <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border px-3 py-2 text-sm">
                                <span className="truncate font-medium">{thread.title}</span>
                                <span className="text-xs text-muted-foreground">
                                  {thread.reason ? tx(thread.reason) : null}
                                </span>
                              </div>
                            </li>
                          ) : (
                            <ThreadRow
                              key={thread.threadId}
                              thread={thread}
                              props={props}
                              on={isSelected(thread.threadId)}
                              result={
                                isSelected(thread.threadId) ? resultFor(thread.threadId) : undefined
                              }
                              destinationName={destinationName}
                            />
                          ),
                        )}
                      </ul>
                    </fieldset>
                  );
                })}
                {props.overLimit ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    {tx("Up to {n} threads go in one hand off. Hand off the rest after.", {
                      n: HANDOFF_BATCH_LIMIT,
                    })}
                  </p>
                ) : null}
                {props.destinationUpdate}
                {props.preflightError ? (
                  <p role="alert" className="text-xs text-destructive-foreground">
                    {`Couldn't reach ${destinationName}: ${props.preflightError}`}
                  </p>
                ) : null}
                {props.error ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {props.error}
                  </p>
                ) : null}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            {props.run || leaving ? (
              <>
                {leaving && !props.run ? (
                  <p className="mr-auto text-xs text-muted-foreground" role="status">
                    {tx("{machine} finishes this hand off by itself. You can close this.", {
                      machine: props.machineName,
                    })}
                  </p>
                ) : null}
                <Button type="button" onClick={props.onCancel}>
                  {tx("Done")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={props.submitting}
                  onClick={props.onCancel}
                >
                  Cancel
                </Button>
                {props.onRecheck &&
                props.destinationId !== null &&
                !props.checking &&
                !props.submitting &&
                failed ? (
                  <Button type="button" variant="outline" onClick={props.onRecheck}>
                    Try again
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    props.submitting ||
                    props.checking ||
                    props.destinationId === null ||
                    props.planReady === false ||
                    movable === 0
                  }
                >
                  {handOffMachinePrimaryLabel(
                    {
                      submitting: props.submitting,
                      checking: props.checking,
                      movable,
                      machine: props.destinationName || null,
                    },
                    tx,
                  )}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const EMPTY_TICKS: ReadonlySet<ThreadId> = new Set();

const groupOf = (thread: HandoffMachineThreadRow): HandoffMachineGroup => thread.group ?? "running";

/** One row that can go: its tick, and once checked, whether it goes and how. */
function ThreadRow({
  thread,
  props,
  on,
  result,
  destinationName,
}: {
  thread: HandoffMachineThreadRow;
  props: HandOffMachineDialogViewProps;
  on: boolean;
  result: HandoffPreflightResult | undefined;
  destinationName: string;
}) {
  const tx = useTx();
  return (
    <li data-thread-status={threadStatus(props, on, result)}>
      <label className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 text-sm">
        <Checkbox
          className="mt-0.5"
          checked={on}
          disabled={props.submitting}
          onCheckedChange={(checked) => props.onToggle(thread.threadId, checked === true)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-medium">{thread.title}</span>
          {result && !result.ok ? (
            <>
              <span
                role="status"
                className="flex items-center gap-1.5 text-xs text-destructive-foreground"
              >
                <XIcon className="size-3.5 shrink-0" aria-hidden />
                {preflightSummary(result, destinationName)}
              </span>
              <HandoffPreflightFailures result={result} />
            </>
          ) : result ? (
            <span className="text-xs text-muted-foreground">
              {result.resume
                ? "The current turn keeps running there."
                : "It will wait there for your next message."}
            </span>
          ) : thread.reason ? (
            <span className="text-xs text-muted-foreground">{tx(thread.reason)}</span>
          ) : null}
        </span>
        {result?.ok ? (
          <span
            role="status"
            className="flex shrink-0 items-center gap-1 text-xs text-success-foreground"
          >
            <CheckIcon className="size-3.5" aria-hidden />
            {tx("Goes")}
          </span>
        ) : on && props.checking ? (
          <span role="status" className="shrink-0 text-xs text-muted-foreground">
            Checking…
          </span>
        ) : null}
      </label>
    </li>
  );
}

function threadStatus(
  props: HandOffMachineDialogViewProps,
  selected: boolean,
  result: HandoffPreflightResult | undefined,
): "off" | "checking" | "ready" | "failed" | "idle" {
  if (!selected) return "off";
  if (props.checking) return "checking";
  if (result === undefined) return "idle";
  return result.ok ? "ready" : "failed";
}

function HandOffMachineDialog({
  environmentId,
  project,
}: {
  environmentId: EnvironmentId;
  project: { readonly id: ProjectId; readonly title: string } | null;
}) {
  const projectId = project?.id ?? null;
  const router = useRouter();
  const name = useMachineNicknames();
  const { snapshot } = useHandoffModeSnapshot(environmentId);
  const paired = useHandoffDestinations(environmentId, false);
  // Machines a check found without transfer records: shown as "Needs update", never a target.
  const [needsUpdate, setNeedsUpdate] = useState<
    ReadonlyMap<EnvironmentId, readonly HandoffPreflightResult[]>
  >(new Map());
  const destinations = useMemo(
    () => destinationsNeedingUpdate(paired, new Set(needsUpdate.keys())),
    [needsUpdate, paired],
  );
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(null);
  const groups = useHandOffProgressGroups(environmentId);
  // The name this window gave its batch: only that batch's records are its progress.
  const [batchId, setBatchId] = useState<string | null>(null);
  const projects = useProjects();
  const shells = useThreadShells();
  const clientRows = useMemo(
    () => handoffMachineRows({ environmentId, shells, snapshot, projects, projectId }),
    [environmentId, projectId, projects, shells, snapshot],
  );
  // The source's own plan (AC-17, AC-22): its rows for the chosen machine, and every
  // machine's usage lines. Without the call, or when it fails, the window's rows stand.
  const canPlan =
    useEnvironmentScopeAccess(environmentId, AuthOrchestrationOperateScope) === "granted";
  const [plans, setPlans] = useState<ReadonlyMap<EnvironmentId, HandoffPlanView>>(new Map());
  // Only a weighed plan decides the rows and what is sent; the others give usage lines.
  const [measured, setMeasured] = useState<ReadonlyMap<EnvironmentId, HandoffPlanView>>(new Map());
  const [planFailed, setPlanFailed] = useState(false);
  const reachable = destinations
    .filter((item) => item.state === "reachable")
    .map((item) => item.environmentId);
  const reachableKey = JSON.stringify(reachable);
  // Nothing is picked for the person but a machine with a different account that has room.
  const evidence = useMemo(() => automaticDestinations(plans), [plans]);
  const chosen = pickDestination(destinations, destinationId, evidence);
  const chosenPlan = chosen === null ? undefined : measured.get(chosen);
  const threads = useMemo(
    () => (chosenPlan === undefined ? clientRows : planHandoffRows(chosenPlan)),
    [chosenPlan, clientRows],
  );
  const planSettled = !canPlan || planFailed || chosenPlan !== undefined;
  // The ticks are decided once, from the first rows the dialog shows; after that
  // only the person's own ticks change them, and a freed slot stays empty.
  const [ticked, setTicked] = useState<{
    readonly ticks: ReadonlySet<ThreadId>;
    readonly overLimit: boolean;
  } | null>(null);
  if (ticked === null && planSettled && threads.length > 0) setTicked(initialHandoffTicks(threads));
  const ticks = ticked?.ticks ?? EMPTY_TICKS;
  const selected = useMemo(() => sentHandoffRows(threads, ticks), [threads, ticks]);
  const [preflight, setPreflight] = useState<ReadonlyMap<ThreadId, HandoffPreflightResult>>(
    new Map(),
  );
  const [checking, setChecking] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<HandoffMachineRun | null>(null);

  const destination = chosen;
  const [recheckPlan, setRecheckPlan] = useState(0);
  useEffect(() => {
    if (!canPlan || run) return;
    let live = true;
    for (const target of JSON.parse(reachableKey) as EnvironmentId[]) {
      void runHandoffMode(handoffBatch.plan, {
        environmentId,
        input: { destinationEnvironmentId: target, projectId, measure: target === destination },
      }).then((next) => {
        if (!live) return;
        if (!next.ok) {
          if (target === destination) setPlanFailed(true);
          return;
        }
        setPlans((current) => new Map(current).set(target, next.value));
        if (target === destination)
          setMeasured((current) => new Map(current).set(target, next.value));
      });
    }
    return () => {
      live = false;
    };
  }, [canPlan, destination, environmentId, projectId, reachableKey, recheckPlan, run]);
  const usage = useMemo(
    () => new Map([...plans].map(([id, plan]) => [id, handoffUsageLines(plan)] as const)),
    [plans],
  );
  // The ids go to the check as an array; the key only tells the effect the set changed.
  const selectedKey = handoffCheckRequest(new Set(threadsTicked(selected))).key;
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    const threadIds = JSON.parse(selectedKey) as ThreadId[];
    if (destination === null || threadIds.length === 0 || run) return;
    let live = true;
    setChecking(true);
    setPreflightError(null);
    void runHandoffMode(handoffMode.preflight, {
      environmentId,
      input: {
        destinationEnvironmentId: destination,
        threadIds,
      },
    }).then((next) => {
      if (!live) return;
      setChecking(false);
      if (!next.ok) {
        setPreflight(new Map());
        setPreflightError(next.error);
        return;
      }
      if (destinationNeedsUpdate(next.value)) {
        // Its row turns into "Needs update" and the next machine that can take work is checked.
        setNeedsUpdate((current) => new Map(current).set(destination, next.value));
        setPreflight(new Map());
        return;
      }
      setPreflight(new Map(next.value.map((result) => [result.threadId, result])));
    });
    return () => {
      live = false;
    };
  }, [destination, environmentId, recheck, run, selectedKey]);

  // Until the machine has written this hand off's records, look for them often.
  const awaitingRecords = submitting && batchId !== null;
  useEffect(() => {
    if (!awaitingRecords) return;
    const timer = window.setInterval(() => void refreshHandoffMode(environmentId), 1_500);
    return () => window.clearInterval(timer);
  }, [awaitingRecords, environmentId]);

  // One batch can cover several projects: each is its own card. Another window's
  // hand off of the same threads is not this window's progress.
  const shown = submittedGroups(groups, batchId, projectId);

  const destinationName = destination
    ? (destinations.find((item) => item.environmentId === destination)?.label ?? name(destination))
    : "";

  return (
    <HandOffMachineDialogView
      machineName={name(environmentId, snapshot?.machineLabel)}
      projectName={project === null ? null : project.title || "This project"}
      destinations={destinations}
      destinationId={destination}
      usage={usage}
      planReady={chosenPlan !== undefined}
      onDestination={(next) => {
        setDestinationId(next);
        setPreflight(new Map());
        setError(null);
      }}
      threads={threads}
      selected={selected}
      overLimit={ticked?.overLimit ?? false}
      onToggle={(threadId, on) =>
        setTicked((current) => {
          const next = toggleHandoffTick(current?.ticks ?? EMPTY_TICKS, threadId, on);
          return { ticks: next.ticks, overLimit: (current?.overLimit ?? false) || next.refused };
        })
      }
      checking={checking}
      preflight={preflight}
      preflightError={preflightError}
      onRecheck={() => {
        setRecheck((count) => count + 1);
        setRecheckPlan((count) => count + 1);
      }}
      destinationUpdate={
        <>
          {destinationUpdateRows(
            needsUpdate,
            destination,
            [...preflight.values()],
            (id) => paired.find((item) => item.environmentId === id)?.label ?? name(id),
          ).map((row) => (
            <HandoffDestinationUpdate
              key={row.environmentId}
              environmentId={row.environmentId}
              label={row.label}
              results={row.results}
              {...(needsUpdate.has(row.environmentId)
                ? {
                    onUpdated: () => {
                      setNeedsUpdate((current) => {
                        const next = new Map(current);
                        next.delete(row.environmentId);
                        return next;
                      });
                      setRecheck((count) => count + 1);
                    },
                  }
                : {})}
            />
          ))}
        </>
      }
      submitting={submitting}
      error={error}
      run={run}
      progress={
        shown.length > 0 ? (
          <div className="flex flex-col gap-6">
            {shown.map((group) => (
              <HandOffProgress
                key={group.key}
                environmentId={environmentId}
                group={group}
                onLeave={close}
              />
            ))}
          </div>
        ) : null
      }
      destinationName={
        run ? name(run.destinationEnvironmentId, run.destinationLabel) : destinationName
      }
      onSubmit={() => {
        if (destination === null || chosenPlan === undefined) return;
        // Only what the weighed plan for this machine lets go is sent.
        const movableIds = movablePlanIds(chosenPlan);
        const threadIds = threadsTicked(
          threads
            .map((thread) => thread.threadId)
            .filter(
              (threadId) =>
                movableIds.has(threadId) && selected.has(threadId) && preflight.get(threadId)?.ok,
            ),
        );
        const folderWork = folderWorkTicked(
          threads
            .filter((thread) => thread.kind === "folder-work")
            .map((thread) => thread.threadId)
            .filter((threadId) => movableIds.has(threadId) && selected.has(threadId))
            .slice(0, HANDOFF_BATCH_MAX_PROJECTS),
        );
        setSubmitting(true);
        setError(null);
        const batch = randomUUID();
        setBatchId(batch);
        void refreshHandoffMode(environmentId);
        void runHandoffMode(handoffMode.handOffMachine, {
          environmentId,
          input: {
            destinationEnvironmentId: destination,
            reason: "manual",
            threadIds,
            batchId: batch,
            ...(folderWork.length === 0 ? {} : { folderWork }),
          },
        }).then((next) => {
          setSubmitting(false);
          if (next.ok) setRun(next.value);
          else setError(next.error);
        });
      }}
      onCancel={close}
      onOpenThread={(threadId, target) => {
        close();
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(target, threadId)),
        });
      }}
    />
  );
}

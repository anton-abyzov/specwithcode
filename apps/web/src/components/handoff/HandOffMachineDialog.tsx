import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { threadRuntimeIsActive } from "@specweave-studio/client-runtime/state/shell";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type {
  EnvironmentId,
  HandoffMachineRun,
  HandoffPreflightResult,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { create } from "zustand";

import { readThreadShell, useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  handoffMachineCandidates,
  handoffMode,
  runHandoffMode,
  useHandoffModeSnapshot,
} from "../../studio/handoffMode";
import { useMachineNicknames } from "../../studio/machineNickname";
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
  HandoffMachineResults,
  HandoffPreflightFailures,
  preflightSummary,
  type HandoffDestination,
} from "./HandoffResults";
import { HandoffDestinationUpdate } from "./HandoffDestinationUpdate";
import { destinationOptions, MachineOptionRows } from "./MachineOptionRows";
import { useHandoffDestinations } from "./useHandoffDestinations";

interface HandOffMachineRequest {
  readonly environmentId: EnvironmentId | null;
  /** Lists only this project's threads: the switcher's "Move {M}'s running threads…". */
  readonly project?: { readonly id: ProjectId; readonly title: string } | undefined;
}

const useRequest = create<{ request: HandOffMachineRequest | null }>(() => ({
  request: null,
}));

/** Opens "Move running threads"; without an id it moves threads off the machine this window serves. */
export function requestHandOffMachine(environmentId: EnvironmentId | null = null) {
  useRequest.setState({ request: { environmentId } });
}

/**
 * Opens "Move {project}'s running threads" for one project's running threads
 * that are kept ready to move, on the machine that holds them. Each thread is checked against the chosen
 * destination before anything moves; the coordinator stays where it is.
 */
export function requestMigrateProjectThreads(
  environmentId: EnvironmentId,
  project: { readonly id: ProjectId; readonly title: string },
) {
  useRequest.setState({ request: { environmentId, project } });
}

const close = () => useRequest.setState({ request: null });

export function HandOffMachineDialogHost() {
  const request = useRequest((state) => state.request);
  const primary = usePrimaryEnvironmentId();
  const environmentId = request?.environmentId ?? primary;
  return request && environmentId ? (
    <HandOffMachineDialog
      key={`${environmentId}:${request.project?.id ?? ""}`}
      environmentId={environmentId}
      project={request.project ?? null}
    />
  ) : null;
}

export interface HandoffMachineThreadRow {
  readonly threadId: ThreadId;
  readonly title: string;
}

export interface HandOffMachineDialogViewProps {
  machineName: string;
  /** Set when the dialog migrates one project's threads instead of the whole machine's. */
  projectName?: string | null;
  destinations: readonly HandoffDestination[];
  destinationId: EnvironmentId | null;
  onDestination: (environmentId: EnvironmentId) => void;
  threads: readonly HandoffMachineThreadRow[];
  selected: ReadonlySet<ThreadId>;
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
  destinationName: string;
  onSubmit: () => void;
  onCancel: () => void;
  onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}

/** The dialog's title: "Move running threads", or "Move atlas's running threads" for one project. */
export function handOffMachineTitle(projectName?: string | null): string {
  return projectName ? `Move ${projectName}'s running threads` : "Move running threads";
}

/** The primary button: "Move 2 threads", "Checking…", or "Nothing ready to move" when none passed. */
export function handOffMachinePrimaryLabel(state: {
  submitting: boolean;
  checking: boolean;
  movable: number;
}): string {
  if (state.submitting) return "Moving…";
  if (state.checking) return "Checking…";
  if (state.movable === 0) return "Nothing ready to move";
  return state.movable === 1 ? "Move 1 thread" : `Move ${state.movable} threads`;
}

/** The dialog's body, without data wiring, so fixtures and tests can render each state. */
export function HandOffMachineDialogView(props: HandOffMachineDialogViewProps) {
  const isSelected = (threadId: ThreadId) => props.selected.has(threadId);
  // While a check runs, earlier results are stale: nothing counts as ready until it finishes.
  const resultFor = (threadId: ThreadId) =>
    props.checking ? undefined : props.preflight.get(threadId);
  const movable = props.threads.filter(
    (thread) => isSelected(thread.threadId) && resultFor(thread.threadId)?.ok,
  ).length;
  const failed =
    props.preflightError !== null ||
    props.threads.some(
      (thread) => isSelected(thread.threadId) && resultFor(thread.threadId)?.ok === false,
    );
  const noneOnline = !props.destinations.some((item) => item.state === "reachable");
  const destinationName = props.destinationName || "the other machine";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.submitting) props.onCancel();
      }}
    >
      <DialogPopup className="sm:max-w-lg" showCloseButton={!props.submitting}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.run && !props.submitting && !props.checking && movable > 0) props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{handOffMachineTitle(props.projectName)}</DialogTitle>
            {props.run ? null : (
              <DialogDescription>
                {
                  "They continue on the machine you pick. Anything that can't move stays here, untouched."
                }
                {props.projectName
                  ? ` ${props.projectName}'s coordinator stays on ${props.machineName}.`
                  : null}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogPanel>
            {props.run ? (
              <HandoffMachineResults
                run={props.run}
                destinationName={props.destinationName}
                onOpenThread={props.onOpenThread}
              />
            ) : (
              <div className="flex flex-col gap-4">
                <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={props.submitting}>
                  <legend className="mb-1.5 text-sm font-medium">Move to</legend>
                  {props.destinations.length > 0 ? (
                    <MachineOptionRows
                      aria-label="Move to"
                      options={destinationOptions(props.destinations)}
                      value={props.destinationId}
                      disabled={props.submitting}
                      onChange={(value) => props.onDestination(value as EnvironmentId)}
                    />
                  ) : null}
                  {noneOnline ? (
                    <p className="text-sm text-muted-foreground">
                      No other machine is online. Pair one in Settings › Connections.
                    </p>
                  ) : null}
                </fieldset>
                <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={props.submitting}>
                  <legend className="mb-1.5 text-sm font-medium">
                    {`Threads (${props.threads.length})`}
                  </legend>
                  {props.threads.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {props.projectName
                        ? `Nothing of ${props.projectName} is running on ${props.machineName} that's set to keep ready to move.`
                        : "Nothing is running here that's set to keep ready to move."}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1.5" aria-label="Running threads">
                      {props.threads.map((thread) => {
                        const on = isSelected(thread.threadId);
                        const result = on ? resultFor(thread.threadId) : undefined;
                        return (
                          <li
                            key={thread.threadId}
                            data-thread-status={threadStatus(props, on, result)}
                          >
                            <label className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2 text-sm">
                              <Checkbox
                                className="mt-0.5"
                                checked={on}
                                disabled={props.submitting}
                                onCheckedChange={(checked) =>
                                  props.onToggle(thread.threadId, checked === true)
                                }
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
                                ) : null}
                              </span>
                              {result?.ok ? (
                                <span
                                  role="status"
                                  className="flex shrink-0 items-center gap-1 text-xs text-success-foreground"
                                >
                                  <CheckIcon className="size-3.5" aria-hidden />
                                  Ready
                                </span>
                              ) : on && props.checking ? (
                                <span
                                  role="status"
                                  className="shrink-0 text-xs text-muted-foreground"
                                >
                                  Checking…
                                </span>
                              ) : null}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </fieldset>
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
            {props.run ? (
              <Button type="button" onClick={props.onCancel}>
                Done
              </Button>
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
                    movable === 0
                  }
                >
                  {handOffMachinePrimaryLabel({
                    submitting: props.submitting,
                    checking: props.checking,
                    movable,
                  })}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
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
  const destinations = useHandoffDestinations(environmentId, false);
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(null);
  const projects = useProjects();
  const threads = useMemo<HandoffMachineThreadRow[]>(
    () =>
      handoffMachineCandidates(snapshot, (threadId) => {
        const shell = readThreadShell(scopeThreadRef(environmentId, threadId));
        if (shell === null || !threadRuntimeIsActive(shell.runtime)) return false;
        // A personal assistant's threads stay on their machine.
        const owner = projects.find(
          (candidate) =>
            candidate.environmentId === environmentId && candidate.id === shell.projectId,
        );
        return !isPersonalAssistantProject(owner);
      })
        .filter((thread) => projectId === null || thread.projectId === projectId)
        .map((thread) => ({
          threadId: thread.threadId,
          title:
            readThreadShell(scopeThreadRef(environmentId, thread.threadId))?.title ||
            "Untitled thread",
        })),
    [environmentId, projectId, projects, snapshot],
  );
  const [deselected, setDeselected] = useState<ReadonlySet<ThreadId>>(new Set());
  const selected = useMemo(
    () => new Set(threads.map((thread) => thread.threadId).filter((id) => !deselected.has(id))),
    [deselected, threads],
  );
  const [preflight, setPreflight] = useState<ReadonlyMap<ThreadId, HandoffPreflightResult>>(
    new Map(),
  );
  const [checking, setChecking] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<HandoffMachineRun | null>(null);

  const destination =
    destinationId ?? destinations.find((item) => item.state === "reachable")?.environmentId ?? null;
  const selectedKey = [...selected].toSorted().join(",");
  const [recheck, setRecheck] = useState(0);

  useEffect(() => {
    if (destination === null || selectedKey === "" || run) return;
    let live = true;
    setChecking(true);
    setPreflightError(null);
    void runHandoffMode(handoffMode.preflight, {
      environmentId,
      input: {
        destinationEnvironmentId: destination,
        threadIds: selectedKey.split(",") as ThreadId[],
      },
    }).then((next) => {
      if (!live) return;
      setChecking(false);
      if (!next.ok) {
        setPreflight(new Map());
        setPreflightError(next.error);
        return;
      }
      setPreflight(new Map(next.value.map((result) => [result.threadId, result])));
    });
    return () => {
      live = false;
    };
  }, [destination, environmentId, recheck, run, selectedKey]);

  const destinationName = destination
    ? (destinations.find((item) => item.environmentId === destination)?.label ?? name(destination))
    : "";

  return (
    <HandOffMachineDialogView
      machineName={name(environmentId, snapshot?.machineLabel)}
      projectName={project === null ? null : project.title || "This project"}
      destinations={destinations}
      destinationId={destination}
      onDestination={(next) => {
        setDestinationId(next);
        setPreflight(new Map());
        setError(null);
      }}
      threads={threads}
      selected={selected}
      onToggle={(threadId, on) =>
        setDeselected((current) => {
          const next = new Set(current);
          if (on) next.delete(threadId);
          else next.add(threadId);
          return next;
        })
      }
      checking={checking}
      preflight={preflight}
      preflightError={preflightError}
      onRecheck={() => setRecheck((count) => count + 1)}
      destinationUpdate={
        <HandoffDestinationUpdate
          environmentId={destination}
          label={destinationName}
          results={[...preflight.values()]}
        />
      }
      submitting={submitting}
      error={error}
      run={run}
      destinationName={
        run ? name(run.destinationEnvironmentId, run.destinationLabel) : destinationName
      }
      onSubmit={() => {
        if (destination === null) return;
        const threadIds = threads
          .map((thread) => thread.threadId)
          .filter((threadId) => selected.has(threadId) && preflight.get(threadId)?.ok);
        setSubmitting(true);
        setError(null);
        void runHandoffMode(handoffMode.handOffMachine, {
          environmentId,
          input: { destinationEnvironmentId: destination, reason: "manual", threadIds },
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

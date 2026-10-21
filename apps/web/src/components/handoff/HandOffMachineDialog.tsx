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
import { useEffect, useId, useMemo, useState } from "react";
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
import { Label } from "../ui/label";
import {
  HandoffDestinationSelect,
  HandoffMachineResults,
  HandoffPreflightFailures,
  preflightSummary,
  type HandoffDestination,
} from "./HandoffResults";
import { useHandoffDestinations } from "./useHandoffDestinations";

interface HandOffMachineRequest {
  readonly environmentId: EnvironmentId | null;
  /** Lists only this project's threads: the switcher's "Migrate threads…". */
  readonly project?: { readonly id: ProjectId; readonly title: string } | undefined;
}

const useRequest = create<{ request: HandOffMachineRequest | null }>(() => ({
  request: null,
}));

/** Opens "Hand off this machine…"; without an id it hands off the machine this window serves. */
export function requestHandOffMachine(environmentId: EnvironmentId | null = null) {
  useRequest.setState({ request: { environmentId } });
}

/**
 * Opens "Migrate threads…" for one project's running handoff-mode threads on
 * the machine that holds them. Each thread is checked against the chosen
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
  submitting: boolean;
  error: string | null;
  run: HandoffMachineRun | null;
  destinationName: string;
  onSubmit: () => void;
  onCancel: () => void;
  onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}

/** The dialog's body, without data wiring, so fixtures and tests can render each state. */
export function HandOffMachineDialogView(props: HandOffMachineDialogViewProps) {
  const id = useId();
  const movable = props.threads.filter(
    (thread) => props.selected.has(thread.threadId) && props.preflight.get(thread.threadId)?.ok,
  ).length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.submitting) props.onCancel();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.run) props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {props.projectName ? "Migrate threads…" : "Hand off this machine…"}
            </DialogTitle>
            <DialogDescription>
              {props.projectName
                ? `${props.projectName}'s running threads in handoff mode on ${props.machineName} continue on the machine you choose. The coordinator stays where it is. A thread that fails a check stays on ${props.machineName}, untouched.`
                : `Running threads in handoff mode on ${props.machineName} continue on the machine you choose. A thread that fails a check stays here, untouched.`}
            </DialogDescription>
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
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-machine`}>Machine</Label>
                  <HandoffDestinationSelect
                    id={`${id}-machine`}
                    destinations={props.destinations}
                    value={props.destinationId}
                    disabled={props.submitting}
                    onChange={props.onDestination}
                  />
                </div>
                {props.threads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {props.projectName
                      ? `No thread of ${props.projectName} in handoff mode is running on ${props.machineName}.`
                      : "No thread in handoff mode is running here."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2" aria-label="Running threads">
                    {props.threads.map((thread) => {
                      const result = props.preflight.get(thread.threadId);
                      return (
                        <li key={thread.threadId}>
                          <label className="flex items-start gap-2 text-sm">
                            <Checkbox
                              checked={props.selected.has(thread.threadId)}
                              disabled={props.submitting}
                              onCheckedChange={(checked) =>
                                props.onToggle(thread.threadId, checked === true)
                              }
                            />
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="truncate">{thread.title}</span>
                              {result ? (
                                <>
                                  <span
                                    className={
                                      result.ok
                                        ? "text-xs text-muted-foreground"
                                        : "text-xs text-destructive-foreground"
                                    }
                                  >
                                    {preflightSummary(result)}
                                  </span>
                                  <HandoffPreflightFailures result={result} />
                                </>
                              ) : props.checking && props.selected.has(thread.threadId) ? (
                                <span className="text-xs text-muted-foreground">Checking…</span>
                              ) : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {props.preflightError ? (
                  <p role="alert" className="text-xs text-destructive-foreground">
                    {`Couldn't check: ${props.preflightError}`}
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
                  variant="ghost"
                  disabled={props.submitting}
                  onClick={props.onCancel}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    props.submitting ||
                    props.checking ||
                    props.destinationId === null ||
                    movable === 0
                  }
                >
                  {props.submitting
                    ? "Handing off…"
                    : movable === 1
                      ? `Hand off 1 thread`
                      : `Hand off ${movable} threads`}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
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
        setPreflightError(next.error);
        return;
      }
      setPreflight(new Map(next.value.map((result) => [result.threadId, result])));
    });
    return () => {
      live = false;
    };
  }, [destination, environmentId, run, selectedKey]);

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

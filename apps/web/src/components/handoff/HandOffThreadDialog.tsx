import type {
  EnvironmentId,
  HandOffResult,
  ModelSelection,
  ScopedThreadRef,
  ThreadId,
} from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";

import { readThreadShell } from "../../state/entities";
import { handoffMode, runHandoffMode } from "../../studio/handoffMode";
import { useMachineNicknames } from "../../studio/machineNickname";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  HandoffPreflightPanel,
  type HandoffDestination,
  type PreflightView,
} from "./HandoffResults";
import { HandoffDestinationUpdate } from "./HandoffDestinationUpdate";
import { HandoffModelPicker, useHandoffModelSummary } from "./HandoffModelPicker";
import { destinationOptions, MachineOptionRows } from "./MachineOptionRows";
import { useHandoffDestinations } from "./useHandoffDestinations";

type Request = {
  readonly threadRef: ScopedThreadRef;
  readonly mode: HandOffThreadDialogMode;
  readonly destinationEnvironmentId?: EnvironmentId | undefined;
  /** The model a caller already checked for that machine (the limit banner's verdict). */
  readonly modelSelection?: ModelSelection | undefined;
};

const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Opens "Move to another machine…" for one thread, optionally on a chosen machine. */
export function requestHandOffThread(
  threadRef: ScopedThreadRef,
  options?: {
    readonly destinationEnvironmentId?: EnvironmentId;
    readonly modelSelection?: ModelSelection;
  },
) {
  useRequest.setState({
    request: {
      threadRef,
      mode: "move",
      destinationEnvironmentId: options?.destinationEnvironmentId,
      modelSelection: options?.modelSelection,
    },
  });
}

/** Opens "Switch model and continue…": the thread keeps going on this machine with another model. */
export function requestSwitchModel(threadRef: ScopedThreadRef) {
  useRequest.setState({ request: { threadRef, mode: "switch-model" } });
}

const close = () => useRequest.setState({ request: null });

export function HandOffThreadDialogHost() {
  const request = useRequest((state) => state.request);
  return request ? (
    <HandOffThreadDialog
      key={`${request.mode}:${request.threadRef.environmentId}:${request.threadRef.threadId}`}
      threadRef={request.threadRef}
      mode={request.mode}
      initialDestinationId={request.destinationEnvironmentId ?? null}
      initialModel={request.modelSelection ?? null}
    />
  ) : null;
}

/** "move" sends the thread to another machine; "switch-model" keeps it here with another model. */
export type HandOffThreadDialogMode = "move" | "switch-model";

export interface HandOffThreadDialogViewProps {
  /** Defaults to "move". */
  mode?: HandOffThreadDialogMode;
  title: string;
  destinations: readonly HandoffDestination[];
  destinationId: EnvironmentId | null;
  onDestination: (environmentId: EnvironmentId) => void;
  /** "Claude Code · Opus 5.5" for the summary line; null when the thread has no model yet. */
  modelSummary?: string | null;
  modelPicker: ReactNode;
  /** Whether "More options" (the model picker) is open; open by default when no model is set. */
  moreOptionsOpen?: boolean;
  onMoreOptionsChange?: (open: boolean) => void;
  preflight: PreflightView;
  /** Update for the destination when its version check says to update it first. */
  destinationUpdate?: ReactNode;
  onRecheck: () => void;
  submitting: boolean;
  error: string | null;
  result: { readonly value: HandOffResult; readonly machine: string } | null;
  onSubmit: () => void;
  onCancel: () => void;
  onOpenContinuation: () => void;
}

/** True when a result notice says something stayed behind, so it reads as a warning. */
export function noticeIsWarning(notice: string): boolean {
  return /^not carried over\b/i.test(notice.trim());
}

/** The label on the main button for the dialog's state. */
export function handOffPrimaryLabel(props: {
  mode: HandOffThreadDialogMode;
  submitting: boolean;
  checking: boolean;
  machine: string | null;
}): string {
  if (props.submitting) return props.mode === "move" ? "Moving…" : "Switching…";
  if (props.checking) return "Checking…";
  if (props.mode === "switch-model") return "Switch and continue";
  return props.machine ? `Move to ${props.machine}` : "Move";
}

/** The dialog's body, without data wiring, so fixtures and tests can render each state. */
export function HandOffThreadDialogView(props: HandOffThreadDialogViewProps) {
  const mode = props.mode ?? "move";
  const destination = props.destinations.find((item) => item.environmentId === props.destinationId);
  const machine = destination?.label ?? null;
  const ready =
    props.preflight.state === "done" && props.preflight.results.every((result) => result.ok);
  const canRetry =
    props.preflight.state === "error" || (props.preflight.state === "done" && !ready);
  const choices = props.destinations.filter((item) => item.state !== "this-machine");
  const noneOnline = !choices.some((item) => item.state === "reachable");
  const modelMissing = props.modelSummary === null;
  const notice = props.result?.value.notice ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.submitting) props.onCancel();
      }}
    >
      <DialogPopup className="sm:max-w-md" showCloseButton={!props.submitting}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.result) props.onSubmit();
          }}
        >
          {props.result ? (
            <DialogHeader>
              <DialogTitle>
                {mode === "move" ? `Moved to ${props.result.machine}` : "Model switched"}
              </DialogTitle>
            </DialogHeader>
          ) : (
            <DialogHeader>
              <DialogTitle>
                {mode === "move" ? `Move "${props.title}"` : "Switch model"}
              </DialogTitle>
              <DialogDescription>
                {mode === "move"
                  ? "Its conversation and file changes go with it. This copy stops and stays here to read."
                  : `"${props.title}" keeps going here with the model you pick.`}
              </DialogDescription>
            </DialogHeader>
          )}
          <DialogPanel>
            {props.result ? (
              <div className="flex flex-col gap-2" role="status">
                <p className="text-sm">
                  {mode === "move"
                    ? `"${props.title}" continues on ${props.result.machine}.`
                    : `"${props.title}" continues here with the model you picked.`}
                </p>
                {notice ? (
                  noticeIsWarning(notice) ? (
                    <p className="flex items-start gap-1.5 text-xs text-warning-foreground">
                      <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
                      <span>{notice}</span>
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{notice}</p>
                  )
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {mode === "move" ? (
                  <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={props.submitting}>
                    <legend className="mb-1.5 text-sm font-medium">Machine</legend>
                    {choices.length > 0 ? (
                      <MachineOptionRows
                        aria-label="Machine"
                        options={destinationOptions(choices)}
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
                ) : null}
                {mode === "move" ? (
                  <Collapsible
                    {...(props.moreOptionsOpen === undefined
                      ? { defaultOpen: modelMissing }
                      : { open: props.moreOptionsOpen })}
                    {...(props.onMoreOptionsChange
                      ? { onOpenChange: (open: boolean) => props.onMoreOptionsChange?.(open) }
                      : {})}
                  >
                    <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate" data-slot="handoff-model-summary">
                        {typeof props.modelSummary === "string"
                          ? `Model: ${props.modelSummary}`
                          : "Model"}
                      </span>
                      <CollapsibleTrigger
                        className="group inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                        disabled={props.submitting}
                      >
                        More options
                        <ChevronDownIcon
                          className="size-3.5 transition-transform group-data-panel-open:rotate-180"
                          aria-hidden
                        />
                      </CollapsibleTrigger>
                    </div>
                    <CollapsiblePanel>
                      <div className="flex flex-col gap-1.5 pt-3">
                        <span className="text-xs font-medium">
                          {machine ? `Model on ${machine}` : "Model"}
                        </span>
                        {props.modelPicker}
                        {modelMissing ? (
                          <p className="text-xs text-muted-foreground">
                            Choose a model to continue with.
                          </p>
                        ) : null}
                      </div>
                    </CollapsiblePanel>
                  </Collapsible>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Model</span>
                    {props.modelPicker}
                    {modelMissing ? (
                      <p className="text-xs text-muted-foreground">
                        Choose a model to continue with.
                      </p>
                    ) : null}
                  </div>
                )}
                <HandoffPreflightPanel
                  preflight={props.preflight}
                  {...(machine ? { machine } : {})}
                  here={mode === "switch-model"}
                />
                {props.destinationUpdate}
                {props.error ? (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {props.error}
                  </p>
                ) : null}
              </div>
            )}
          </DialogPanel>
          <DialogFooter>
            {props.result ? (
              <Button type="button" onClick={props.onOpenContinuation}>
                {mode === "move" ? `Open on ${props.result.machine}` : "Open thread"}
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
                {canRetry ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={props.submitting}
                    onClick={props.onRecheck}
                  >
                    Try again
                  </Button>
                ) : null}
                <Button type="submit" disabled={props.submitting || !ready}>
                  {handOffPrimaryLabel({
                    mode,
                    submitting: props.submitting,
                    checking: props.preflight.state === "checking",
                    machine,
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

function HandOffThreadDialog({
  threadRef,
  mode,
  initialDestinationId,
  initialModel = null,
}: {
  threadRef: ScopedThreadRef;
  mode: HandOffThreadDialogMode;
  initialDestinationId: EnvironmentId | null;
  /** A model already checked for the chosen machine; else the thread's own. */
  initialModel?: ModelSelection | null;
}) {
  const router = useRouter();
  const name = useMachineNicknames();
  const [thread] = useState(() => readThreadShell(threadRef));
  const destinations = useHandoffDestinations(threadRef.environmentId, mode === "switch-model");
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(initialDestinationId);
  const [model, setModel] = useState<ModelSelection | null>(
    () => initialModel ?? thread?.modelSelection ?? null,
  );
  // A thread with no model opens on the picker, so it is never a dead end.
  const [moreOptionsOpen, setMoreOptionsOpen] = useState(
    () => !(initialModel ?? thread?.modelSelection),
  );
  const [preflight, setPreflight] = useState<PreflightView>({ state: "idle" });
  const [check, setCheck] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ value: HandOffResult; machine: string } | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // Moving defaults to the first reachable other machine; switching stays on this one.
  const destination =
    mode === "switch-model"
      ? threadRef.environmentId
      : (destinationId ??
        destinations.find((item) => item.state === "reachable")?.environmentId ??
        null);
  const destinationLabel =
    destinations.find((item) => item.environmentId === destination)?.label ??
    (destination ? name(destination) : "");
  const modelSummary = useHandoffModelSummary(threadRef.environmentId, destination, model);

  useEffect(() => {
    if (destination === null || model === null) return;
    let live = true;
    setPreflight({ state: "checking" });
    void runHandoffMode(handoffMode.preflight, {
      environmentId: threadRef.environmentId,
      input: {
        destinationEnvironmentId: destination,
        threadIds: [threadRef.threadId],
        modelSelection: model,
      },
    }).then((next) => {
      if (!live) return;
      setPreflight(
        next.ok ? { state: "done", results: next.value } : { state: "error", message: next.error },
      );
    });
    return () => {
      live = false;
    };
  }, [check, destination, model, threadRef.environmentId, threadRef.threadId]);

  // Nothing to check without a machine and a model; an earlier verdict no longer applies.
  const shownPreflight: PreflightView =
    destination === null || model === null ? { state: "idle" } : preflight;

  if (thread === null) return null;

  const openThread = (threadId: ThreadId, environmentId: EnvironmentId) => {
    close();
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  const submit = async () => {
    if (destination === null) return;
    setSubmitting(true);
    setError(null);
    const next = await runHandoffMode(handoffMode.handOff, {
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        destinationEnvironmentId: destination,
        ...(model ? { modelSelection: model } : {}),
      },
    });
    if (mounted.current) setSubmitting(false);
    if (!next.ok) {
      if (mounted.current) setError(next.error);
      return;
    }
    const machine = name(next.value.environmentId, next.value.machineLabel);
    // The open dialog shows the result itself; a toast only when it is gone.
    if (mounted.current) {
      setResult({ value: next.value, machine });
      return;
    }
    const notice = next.value.notice;
    toastManager.add(
      stackedThreadToast({
        type: notice && noticeIsWarning(notice) ? "warning" : "success",
        title: mode === "move" ? `Moved to ${machine}` : "Model switched",
        ...(notice ? { description: notice } : {}),
      }),
    );
  };

  const recheck = () => {
    setError(null);
    setCheck((value) => value + 1);
  };

  return (
    <HandOffThreadDialogView
      mode={mode}
      title={thread.title || "Untitled thread"}
      destinations={destinations}
      destinationId={destination}
      onDestination={(environmentId) => {
        setDestinationId(environmentId);
        setError(null);
      }}
      modelSummary={modelSummary}
      modelPicker={
        <HandoffModelPicker
          sourceEnvironmentId={threadRef.environmentId}
          destinationEnvironmentId={destination}
          value={model}
          disabled={submitting}
          ariaLabel={mode === "move" && destinationLabel ? `Model on ${destinationLabel}` : "Model"}
          onChange={(selection) => {
            setModel(selection);
            setError(null);
          }}
        />
      }
      moreOptionsOpen={moreOptionsOpen}
      onMoreOptionsChange={setMoreOptionsOpen}
      preflight={shownPreflight}
      destinationUpdate={
        shownPreflight.state === "done" ? (
          <HandoffDestinationUpdate
            environmentId={destination}
            label={destinationLabel}
            results={shownPreflight.results}
            onUpdated={recheck}
          />
        ) : null
      }
      onRecheck={recheck}
      submitting={submitting}
      error={error}
      result={result}
      onSubmit={() => void submit()}
      onCancel={close}
      onOpenContinuation={() => {
        if (result) openThread(result.value.threadId, result.value.environmentId);
      }}
    />
  );
}

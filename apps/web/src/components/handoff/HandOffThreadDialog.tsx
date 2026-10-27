import type {
  EnvironmentId,
  HandOffResult,
  ModelSelection,
  ScopedThreadRef,
  ThreadId,
} from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState, type ReactNode } from "react";
import { create } from "zustand";

import { readThreadShell } from "../../state/entities";
import { handoffMode, runHandoffMode } from "../../studio/handoffMode";
import { useMachineNicknames } from "../../studio/machineNickname";
import { buildThreadRouteParams } from "../../threadRoutes";
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
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  HandoffDestinationSelect,
  HandoffPreflightPanel,
  type HandoffDestination,
  type PreflightView,
} from "./HandoffResults";
import { HandoffDestinationUpdate } from "./HandoffDestinationUpdate";
import { HandoffModelPicker } from "./HandoffModelPicker";
import { useHandoffDestinations } from "./useHandoffDestinations";

const useRequest = create<{ request: ScopedThreadRef | null }>(() => ({ request: null }));

/** Opens "Hand off to…" for one thread. */
export function requestHandOffThread(threadRef: ScopedThreadRef) {
  useRequest.setState({ request: threadRef });
}

const close = () => useRequest.setState({ request: null });

export function HandOffThreadDialogHost() {
  const request = useRequest((state) => state.request);
  return request ? (
    <HandOffThreadDialog key={`${request.environmentId}:${request.threadId}`} threadRef={request} />
  ) : null;
}

export interface HandOffThreadDialogViewProps {
  title: string;
  destinations: readonly HandoffDestination[];
  destinationId: EnvironmentId | null;
  onDestination: (environmentId: EnvironmentId) => void;
  modelPicker: ReactNode;
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

/** The dialog's body, without data wiring, so fixtures and tests can render each state. */
export function HandOffThreadDialogView(props: HandOffThreadDialogViewProps) {
  const id = useId();
  const destination = props.destinations.find((item) => item.environmentId === props.destinationId);
  const ready =
    props.preflight.state === "done" && props.preflight.results.every((result) => result.ok);
  const sameMachine = destination?.state === "this-machine";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.submitting) props.onCancel();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.result) props.onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Hand off to…</DialogTitle>
            <DialogDescription>
              {`"${props.title}" continues from its latest checkpoint: its changes, conversation and handoff note. It stops here and becomes read-only.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {props.result ? (
              <div className="flex flex-col gap-2" role="status">
                <p className="text-sm">{`Continued on ${props.result.machine}.`}</p>
                {props.result.value.notice ? (
                  <p className="text-xs text-muted-foreground">{props.result.value.notice}</p>
                ) : null}
              </div>
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
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Provider and model</span>
                  {props.modelPicker}
                  {sameMachine ? (
                    <p className="text-xs text-muted-foreground">
                      On this machine the same thread continues with the model you pick.
                    </p>
                  ) : null}
                </div>
                <HandoffPreflightPanel preflight={props.preflight} />
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
                Open continuation
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
                {props.preflight.state === "done" && !ready ? (
                  <Button type="button" variant="outline" onClick={props.onRecheck}>
                    Check again
                  </Button>
                ) : null}
                <Button type="submit" disabled={props.submitting || !ready}>
                  {props.submitting
                    ? "Handing off…"
                    : destination
                      ? `Hand off to ${destination.label}`
                      : "Hand off"}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function HandOffThreadDialog({ threadRef }: { threadRef: ScopedThreadRef }) {
  const router = useRouter();
  const name = useMachineNicknames();
  const [thread] = useState(() => readThreadShell(threadRef));
  const destinations = useHandoffDestinations(threadRef.environmentId, true);
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(null);
  const [model, setModel] = useState<ModelSelection | null>(() => thread?.modelSelection ?? null);
  const [preflight, setPreflight] = useState<PreflightView>({ state: "idle" });
  const [check, setCheck] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ value: HandOffResult; machine: string } | null>(null);

  // Default to the first reachable machine other than this one.
  const fallback =
    destinations.find((item) => item.state === "reachable")?.environmentId ??
    destinations[0]?.environmentId ??
    null;
  const destination = destinationId ?? fallback;

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
    setSubmitting(false);
    if (!next.ok) {
      setError(next.error);
      return;
    }
    const machine = name(next.value.environmentId, next.value.machineLabel);
    setResult({ value: next.value, machine });
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Continued on ${machine}`,
        ...(next.value.notice ? { description: next.value.notice } : {}),
      }),
    );
  };

  return (
    <HandOffThreadDialogView
      title={thread.title || "Untitled thread"}
      destinations={destinations}
      destinationId={destination}
      onDestination={(environmentId) => {
        setDestinationId(environmentId);
        setError(null);
      }}
      modelPicker={
        model ? (
          <HandoffModelPicker
            sourceEnvironmentId={threadRef.environmentId}
            destinationEnvironmentId={destination}
            value={model}
            disabled={submitting}
            onChange={setModel}
          />
        ) : null
      }
      preflight={preflight}
      destinationUpdate={
        preflight.state === "done" ? (
          <HandoffDestinationUpdate
            environmentId={destination}
            label={
              destinations.find((item) => item.environmentId === destination)?.label ??
              (destination ? name(destination) : "")
            }
            results={preflight.results}
          />
        ) : null
      }
      onRecheck={() => setCheck((value) => value + 1)}
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

import type { ConfirmDialogOptions, ConfirmDialogVariant } from "@specweave-studio/contracts";
import type { ReactNode } from "react";

type ConfirmDialogRequest = {
  readonly message: string;
  readonly variant: ConfirmDialogVariant;
  /** Button labels; absent means "Confirm" and "Cancel". */
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** A third button between the two; absent means none. */
  readonly alternateLabel?: string;
  /** Rich content under the description, such as a list of what is affected. */
  readonly details?: ReactNode;
};

/** Which button closed the dialog; dismissing it counts as cancel. */
export type ConfirmDialogChoice = "confirm" | "alternate" | "cancel";

export type ConfirmDialogState =
  | { readonly status: "idle" }
  | ({ readonly status: "confirming" } & ConfirmDialogRequest)
  | ({ readonly status: "closing" } & ConfirmDialogRequest);

type PendingConfirmation = ConfirmDialogRequest & {
  readonly resolve: (choice: ConfirmDialogChoice) => void;
};

function requestOf(pending: PendingConfirmation): ConfirmDialogRequest {
  const { resolve: _resolve, ...request } = pending;
  return request;
}

const idleState: ConfirmDialogState = { status: "idle" };
let state: ConfirmDialogState = idleState;
let activeConfirmation: PendingConfirmation | null = null;
let queuedConfirmations: PendingConfirmation[] = [];
let registeredHostCount = 0;
const listeners = new Set<() => void>();

function publish(next: ConfirmDialogState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function resolvePendingConfirmations(choice: ConfirmDialogChoice): void {
  activeConfirmation?.resolve(choice);
  for (const confirmation of queuedConfirmations) {
    confirmation.resolve(choice);
  }
  activeConfirmation = null;
  queuedConfirmations = [];
}

export function readConfirmDialogState(): ConfirmDialogState {
  return state;
}

export function subscribeConfirmDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the renderer host that can present themed confirmations. The
 * returned cleanup function also cancels any request left without a host.
 */
export function registerConfirmDialogHost(): () => void {
  registeredHostCount += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registeredHostCount = Math.max(0, registeredHostCount - 1);

    if (registeredHostCount === 0) {
      resolvePendingConfirmations("cancel");
      publish(idleState);
    }
  };
}

/**
 * Requests a themed confirmation when a host is mounted. An undefined result
 * means no themed host is currently available.
 */
export function requestConfirmDialog(
  message: string,
  options?: ConfirmDialogOptions,
): Promise<boolean> | undefined {
  return requestChoiceDialog(message, options)?.then((choice) => choice === "confirm");
}

/**
 * Like `requestConfirmDialog`, with an optional third button
 * (`alternateLabel`). Undefined when no themed host is available.
 */
export function requestChoiceDialog(
  message: string,
  options?: ConfirmDialogOptions & {
    readonly alternateLabel?: string;
    readonly details?: ReactNode;
  },
): Promise<ConfirmDialogChoice> | undefined {
  if (registeredHostCount === 0) return undefined;

  return new Promise<ConfirmDialogChoice>((resolve) => {
    const pending: PendingConfirmation = {
      message,
      variant: options?.variant ?? "default",
      ...(options?.confirmLabel ? { confirmLabel: options.confirmLabel } : {}),
      ...(options?.cancelLabel ? { cancelLabel: options.cancelLabel } : {}),
      ...(options?.alternateLabel ? { alternateLabel: options.alternateLabel } : {}),
      ...(options?.details ? { details: options.details } : {}),
      resolve,
    };
    if (activeConfirmation || state.status === "closing") {
      queuedConfirmations.push(pending);
      return;
    }

    activeConfirmation = pending;
    publish({ status: "confirming", ...requestOf(pending) });
  });
}

export function respondToConfirmDialog(response: boolean | ConfirmDialogChoice): void {
  if (state.status !== "confirming" || !activeConfirmation) return;

  const confirmation = activeConfirmation;
  activeConfirmation = null;
  confirmation.resolve(response === true ? "confirm" : response === false ? "cancel" : response);
  const { status: _status, ...request } = state;
  publish({ status: "closing", ...request });
}

export function completeConfirmDialogClose(): void {
  if (state.status !== "closing") return;

  const next = queuedConfirmations.shift();
  if (!next) {
    publish(idleState);
    return;
  }

  activeConfirmation = next;
  publish({ status: "confirming", ...requestOf(next) });
}

export function resetConfirmDialogForTests(): void {
  resolvePendingConfirmations("cancel");
  registeredHostCount = 0;
  publish(idleState);
  listeners.clear();
}

import {
  RelayClientInstallProgressStageSchema,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export class RelayClientInstallConfirmationConflictError extends Schema.TaggedError<RelayClientInstallConfirmationConflictError>()(
  "RelayClientInstallConfirmationConflictError",
  {
    requestedVersion: Schema.String,
    activeVersion: Schema.String,
    activeDialogStatus: Schema.Literals(["confirming", "installing", "closing"]),
    activeInstallStage: Schema.optional(RelayClientInstallProgressStageSchema),
  },
) {
  override get message(): string {
    return `Cannot confirm relay client installation ${this.requestedVersion}; installation ${this.activeVersion} has dialog status ${this.activeDialogStatus}.`;
  }
}

export type RelayClientInstallDialogState =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly version: string }
  | {
      readonly status: "installing";
      readonly version: string;
      readonly stage: RelayClientInstallProgressStage;
      /** Started without the question: the caller draws the progress, so the dialog stays shut. */
      readonly inline?: true;
    }
  | {
      readonly status: "closing";
      readonly view:
        | { readonly status: "confirming"; readonly version: string }
        | {
            readonly status: "installing";
            readonly version: string;
            readonly stage: RelayClientInstallProgressStage;
          };
    };

const idleState: RelayClientInstallDialogState = { status: "idle" };
let state: RelayClientInstallDialogState = idleState;
let resolveConfirmation: ((confirmed: boolean) => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: RelayClientInstallDialogState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export function readRelayClientInstallDialogState(): RelayClientInstallDialogState {
  return state;
}

export function subscribeRelayClientInstallDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestRelayClientInstallConfirmation(version: string): Promise<boolean> {
  if (state.status !== "idle") {
    const activeInstall = state.status === "closing" ? state.view : state;
    return Promise.reject(
      new RelayClientInstallConfirmationConflictError({
        requestedVersion: version,
        activeVersion: activeInstall.version,
        activeDialogStatus: state.status,
        ...(activeInstall.status === "installing"
          ? { activeInstallStage: activeInstall.stage }
          : {}),
      }),
    );
  }

  publish({ status: "confirming", version });
  return new Promise<boolean>((resolve) => {
    resolveConfirmation = resolve;
  });
}

/**
 * Starts an install the person has already agreed to, such as the link that
 * follows Sign in during first-run setup. Nothing is asked and the dialog does
 * not open: whoever started it shows `stage` where the person is looking.
 */
export function startRelayClientInstallInline(version: string): void {
  if (state.status !== "idle") {
    const activeInstall = state.status === "closing" ? state.view : state;
    throw new RelayClientInstallConfirmationConflictError({
      requestedVersion: version,
      activeVersion: activeInstall.version,
      activeDialogStatus: state.status,
      ...(activeInstall.status === "installing" ? { activeInstallStage: activeInstall.stage } : {}),
    });
  }
  publish({ status: "installing", version, stage: "checking", inline: true });
}

export function respondToRelayClientInstallConfirmation(confirmed: boolean): void {
  if (state.status !== "confirming" || !resolveConfirmation) {
    return;
  }

  const resolve = resolveConfirmation;
  resolveConfirmation = null;
  publish(
    confirmed
      ? { status: "installing", version: state.version, stage: "checking" }
      : { status: "closing", view: state },
  );
  resolve(confirmed);
}

export function reportRelayClientInstallProgress(event: RelayClientInstallProgressEvent): void {
  if (state.status !== "installing" || event.type !== "progress") {
    return;
  }
  publish({ ...state, stage: event.stage });
}

export function finishRelayClientInstall(): void {
  resolveConfirmation?.(false);
  resolveConfirmation = null;
  if (state.status === "installing" && state.inline) {
    // No dialog was open, so there is no close to wait for.
    publish(idleState);
    return;
  }
  if (state.status === "confirming" || state.status === "installing") {
    publish({ status: "closing", view: state });
  }
}

export function completeRelayClientInstallDialogClose(): void {
  if (state.status === "closing") {
    publish(idleState);
  }
}

export function resetRelayClientInstallDialogForTests(): void {
  resolveConfirmation?.(false);
  resolveConfirmation = null;
  publish(idleState);
  listeners.clear();
}

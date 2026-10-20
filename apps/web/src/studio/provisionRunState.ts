import type {
  ProvisionEvent,
  ProvisionItem,
  ProvisionItemId,
  ProvisionReadback,
} from "@specweave-studio/contracts";

export const PROVISION_LOG_LINES = 200;

export interface ProvisionRunState {
  readonly status: "idle" | "running" | "done" | "failed";
  readonly items: ReadonlyArray<ProvisionItem>;
  readonly logs: Partial<Record<ProvisionItemId, ReadonlyArray<string>>>;
  /** The plan while running, the final readback once done. */
  readonly readback: ProvisionReadback | null;
  readonly error: string | null;
}

export const IDLE_PROVISION_RUN: ProvisionRunState = {
  status: "idle",
  items: [],
  logs: {},
  readback: null,
  error: null,
};

export function startProvisionRun(previous: ProvisionRunState): ProvisionRunState {
  // A retry keeps the rows it already knows so the list does not flash empty.
  return { ...previous, status: "running", error: null, logs: {} };
}

export function reduceProvisionEvent(
  state: ProvisionRunState,
  event: ProvisionEvent,
): ProvisionRunState {
  switch (event.type) {
    case "plan":
      return { ...state, items: event.readback.items, readback: event.readback };
    case "item": {
      const known = state.items.some((item) => item.id === event.item.id);
      return {
        ...state,
        items: known
          ? state.items.map((item) => (item.id === event.item.id ? event.item : item))
          : [...state.items, event.item],
      };
    }
    case "log": {
      const lines = [...(state.logs[event.id] ?? []), event.line].slice(-PROVISION_LOG_LINES);
      return { ...state, logs: { ...state.logs, [event.id]: lines } };
    }
    case "done":
      return {
        ...state,
        status: event.readback.ok ? "done" : "failed",
        items: event.readback.items,
        readback: event.readback,
      };
  }
}

export function failProvisionRun(state: ProvisionRunState, error: string): ProvisionRunState {
  return { ...state, status: "failed", error };
}

/** A run that ended with a failed step or a root step can continue where it stopped. */
export function canResumeProvision(state: ProvisionRunState): boolean {
  return (
    state.status === "failed" &&
    (state.items.some((item) => item.status === "failed" || item.status === "needs-root") ||
      state.error !== null)
  );
}

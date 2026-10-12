export type ManagedRunStatus = "created" | "running" | "idle" | "completed" | "stopped" | "error";
export type ManagedPhaseStatus = "pending" | "running" | "ended";
export interface ManagedPhase {
  readonly id: string;
  readonly name: string;
  readonly status: ManagedPhaseStatus;
}
export interface ManagedRun {
  readonly id: string;
  readonly name: string;
  readonly status: ManagedRunStatus;
  readonly phases: readonly ManagedPhase[];
}
export interface ManagedWorkflowState {
  readonly runs: readonly ManagedRun[];
  readonly messages: readonly string[];
  readonly status:
    | "running"
    | "completed"
    | "budget_reached"
    | "requires_action"
    | "failed"
    | "terminated";
  readonly sawWorkflow: boolean;
}

export const emptyManagedWorkflowState = (): ManagedWorkflowState => ({
  runs: [],
  messages: [],
  status: "running",
  sawWorkflow: false,
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const string = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/** Forward-compatible primary-stream reducer. It never equates idle or a phase end with success. */
export function reduceManagedWorkflowEvent(
  state: ManagedWorkflowState,
  input: unknown,
): ManagedWorkflowState {
  const event = object(input);
  const type = string(event.type);
  const id = string(event.workflow_run_id);
  if (type === "agent.message") {
    const content = Array.isArray(event.content) ? event.content : [];
    const text = content
      .map((part) => string(object(part).text))
      .filter(Boolean)
      .join("\n");
    return text
      ? { ...state, messages: [...state.messages, text.slice(0, 32_768)].slice(-32) }
      : state;
  }
  if (type === "workflow_run.created" && id) {
    const phases = (Array.isArray(event.phases) ? event.phases : [])
      .map((value) => {
        const phase = object(value);
        return {
          id: string(phase.id),
          name: string(phase.name).slice(0, 64),
          status: "pending" as const,
        };
      })
      .filter((phase) => phase.id);
    return {
      ...state,
      status: "running",
      sawWorkflow: true,
      runs: [
        ...state.runs.filter((run) => run.id !== id),
        { id, name: string(event.name).slice(0, 64), status: "created", phases },
      ],
    };
  }
  if (type.startsWith("workflow_run.") && id) {
    const runs = state.runs.map((run) => {
      if (run.id !== id) return run;
      if (type === "workflow_run.status_running") return { ...run, status: "running" as const };
      if (type === "workflow_run.status_idle") return { ...run, status: "idle" as const };
      if (type === "workflow_run.status_ended") {
        const result = string(object(event.result).type);
        return {
          ...run,
          status:
            result === "completed"
              ? ("completed" as const)
              : result === "stopped"
                ? ("stopped" as const)
                : ("error" as const),
        };
      }
      if (type === "workflow_run.phase_started" || type === "workflow_run.phase_ended") {
        const phaseId = string(event.workflow_run_phase_id);
        const status =
          type === "workflow_run.phase_started" ? ("running" as const) : ("ended" as const);
        const existing = run.phases.some((phase) => phase.id === phaseId);
        return {
          ...run,
          phases: existing
            ? run.phases.map((phase) => (phase.id === phaseId ? { ...phase, status } : phase))
            : [...run.phases, { id: phaseId, name: "Unlisted phase", status }],
        };
      }
      return run;
    });
    return { ...state, runs };
  }
  if (type === "session.status_terminated") return { ...state, status: "terminated" };
  if (type === "session.status_idle") {
    const reason = string(object(event.stop_reason).type, string(event.stop_reason));
    if (reason === "budget_reached" || reason === "requires_action")
      return { ...state, status: reason };
    if (
      reason === "end_turn" &&
      (state.sawWorkflow || state.messages.length > 0) &&
      state.runs.every((run) => ["completed", "stopped", "error"].includes(run.status))
    ) {
      return {
        ...state,
        status: state.runs.some((run) => run.status !== "completed") ? "failed" : "completed",
      };
    }
    if (reason && reason !== "end_turn") return { ...state, status: "failed" };
  }
  return state;
}

/** SSE framing is independent of TCP chunk boundaries and supports CRLF and multiline data. */
export function createManagedSseDecoder() {
  let pending = "";
  return (chunk: string): unknown[] => {
    pending += chunk;
    if (pending.length > 1_048_576)
      throw new Error("Managed Agents event exceeded the frame limit.");
    const values: unknown[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending)) !== null) {
      const frame = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") values.push(JSON.parse(data));
    }
    return values;
  };
}

export type ThreadQueueWaitReason =
  | "turn"
  | "stopped"
  | "failure"
  | "usage_limit"
  | "restart"
  | "starting";

/** Set by the fixture before it renders. */
export const fixtureWorkflow: { current: unknown } = { current: null };

export function deriveThreadQueueWorkflowState(): never {
  return fixtureWorkflow.current as never;
}

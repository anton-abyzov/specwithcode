// The delegation limits live in OrchestratorMcpService.ts: a separate module
// imported there shifted check order and widened the WebSocket layer's
// inferred requirements to `any` (Effect diagnostic TS377030 in server.ts).
export {
  DEFAULT_DELEGATION_LIMITS,
  MAX_DELEGATION_DEPTH,
  MAX_LINEAGE_WALK,
  MAX_LIVE_CHILD_TASKS_PER_RUN,
  delegationLimitRefusal,
  delegationParentId,
  liveChildTaskCount,
  type DelegationLimits,
  type LineageThread,
} from "./OrchestratorMcpService.ts";

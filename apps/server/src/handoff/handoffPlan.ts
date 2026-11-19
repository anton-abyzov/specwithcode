/** Stub: the per-thread hand off plan (1390, T-10). Tests first. */
import * as Schema from "effect/Schema";

export const HANDOFF_PLAN_CAPABILITY = "handoff.plan";
export const PeerCheckRequest = Schema.Struct({ stub: Schema.Literal("stub") });
export type PeerCheckRequest = any;
export const PeerCheckResponse = Schema.Struct({ stub: Schema.Literal("stub") });
export type PeerCheckResponse = any;
export type CheckSignIn = any;
export type HandoffMeasure = any;
export type HandoffPlanFacts = any;
export type HandoffThreadFact = any;
export const planCapabilityFailure = (_input: any): any => null;
export const unknownCheckPath = (_label: string): any => ({});
export const checkAnswer = (_input: any): any => ({ kind: "skipped" });
export const confirmTarget = (_input: any): any => ({ failures: [], evidence: null });
export const planThread = (_facts: any, _thread: any): any => null;
export const folderWorkItem = (_facts: any, _work: any): any => null;
export const buildHandoffPlan = (_facts: any): any => ({ items: [] });
export const outcomeLine = (_disposition: string, _machine: string): string => "";
export const grewPastLimit = (_before: any, _after: any): string | null => null;
export const checkRef = (_operationId: string, _threadId: string): string => "refs/stub";
export const measureTravel = async (_input: any): Promise<any> => ({ bytes: 0, files: 0, over: null });

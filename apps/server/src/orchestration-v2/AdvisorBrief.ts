/**
 * The brief an advisor is sent: what the thread was asked, what it did and
 * where it stands, inside a token budget. A second consult in the same thread
 * carries only what happened since the previous one.
 *
 * @module AdvisorBrief
 */
import type { OrchestrationV2ThreadProjection } from "@specweave-studio/contracts";

/** The stored records a brief is built from; read with `getThreadRecords`. */
export type AdvisorBriefRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "messages" | "turnItems" | "subagents"
>;

export interface AdvisorBriefInput {
  readonly records: AdvisorBriefRecords;
  /** The one question the thread most wants reviewed. */
  readonly focus?: string | undefined;
  /** The largest brief allowed; one UTF-8 byte counts as one token. */
  readonly budgetTokens: number;
}

export interface AdvisorBrief {
  /** The whole message the advisor child is started with. */
  readonly text: string;
  /** Size of `text` in UTF-8 bytes, counted as tokens. Never above the budget. */
  readonly tokens: number;
  /** Activity items left out to fit the budget, oldest first. */
  readonly leftOut: number;
  /** True when an earlier consult delivered advice and only later activity is included. */
  readonly sinceLastConsult: boolean;
}

export function buildAdvisorBrief(_input: AdvisorBriefInput): AdvisorBrief {
  throw new Error("AdvisorBrief is not built yet.");
}

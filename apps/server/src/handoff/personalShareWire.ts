/**
 * The `personal-share` peer path (1448 D-13 to D-15): two machines of one
 * SpecWithCode Connect account find out whether they share one Percy, and
 * link it, without a window open. Same authentication as the linked sync
 * paths: the caller's work grant here names it.
 *
 * Phase 1 carries states only, both ways (`personalShareDecision.phase1Answer`):
 * a side that refuses the other sends only its reason. Phase 2 carries
 * content, both ways, only after both sides accepted each other in phase 1:
 * the caller checks the callee's phase-1 answer and its own rules before it
 * puts content in a request, and the callee checks its own rules before it
 * puts any in a response. Content is the link's identity and shared settings,
 * the shared memory files by name and hash, and the text of `MEMORY.md`;
 * local-only and secret-flagged files are never listed or sent.
 *
 * @module personalShareWire
 */
import * as Schema from "effect/Schema";

import {
  LogicalProjectMember,
  NonNegativeInt,
  PROJECT_MEMORY_FILE_BYTES,
  PROJECT_MEMORY_MAX_FILES,
} from "@specweave-studio/contracts";

import { LinkedPersonalSettings } from "./linkedSyncWire.ts";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const envId = text(128);

export const PersonalShareRefusal = Schema.Literals([
  "switch_off",
  "not_confirmed",
  "legacy_grant",
  "no_grant",
  "other_account",
  "older_version",
]);

/** One side's phase-1 state for the other: a reason only, or its state once it accepts. */
export const PersonalSharePhase1 = Schema.Union([
  Schema.Struct({
    accepted: Schema.Literal(false),
    protocolVersion: NonNegativeInt,
    environmentId: envId,
    reason: PersonalShareRefusal,
  }),
  Schema.Struct({
    accepted: Schema.Literal(true),
    protocolVersion: NonNegativeInt,
    environmentId: envId,
    switchOn: Schema.Literal(true),
    linkId: text(128),
    start: Schema.Boolean,
    name: Schema.optional(text(120)),
    linked: Schema.Boolean,
    members: Schema.Array(envId).check(Schema.isMaxLength(64)),
    memoryFileCount: NonNegativeInt,
  }),
]);
export type PersonalSharePhase1 = typeof PersonalSharePhase1.Type;

/** What one seat shares in phase 2. */
export const PersonalShareContent = Schema.Struct({
  /** This seat as a link member. */
  self: LogicalProjectMember,
  /** The link it is in: its title and members; null while it is in no link with others. */
  link: Schema.NullOr(
    Schema.Struct({
      id: text(128),
      title: text(200),
      members: Schema.Array(LogicalProjectMember).check(Schema.isMaxLength(64)),
    }),
  ),
  settings: LinkedPersonalSettings,
  memory: Schema.Struct({
    files: Schema.Array(Schema.Struct({ name: text(256), sha256: text(64) })).check(
      Schema.isMaxLength(PROJECT_MEMORY_MAX_FILES),
    ),
    /** The text of the shared `MEMORY.md`; null when there is none to share. */
    index: Schema.NullOr(text(PROJECT_MEMORY_FILE_BYTES)),
  }),
});
export type PersonalShareContent = typeof PersonalShareContent.Type;

export const PersonalShareRequest = Schema.Struct({
  protocolVersion: NonNegativeInt,
  phase: Schema.Literals([1, 2]),
  /** The caller's account link id; the callee also checks the Connect user header. */
  linkId: Schema.NullOr(text(128)),
  /** The caller's phase-1 state for the callee. */
  state: PersonalSharePhase1,
  /** Phase 2 only, and only after the callee accepted the caller in phase 1. */
  content: Schema.optional(PersonalShareContent),
});
export type PersonalShareRequest = typeof PersonalShareRequest.Type;

export const PersonalShareResponse = Schema.Struct({
  state: PersonalSharePhase1,
  /** Phase 2 only, and only when the callee's own rules pass for the caller. */
  content: Schema.optional(PersonalShareContent),
});
export type PersonalShareResponse = typeof PersonalShareResponse.Type;

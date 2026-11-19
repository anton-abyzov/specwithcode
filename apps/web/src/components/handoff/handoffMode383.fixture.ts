/**
 * The handoff mode shapes of release 1.0.383 (tag `v1.0.383`), the last one
 * before transfer records, copied field for field from that tag's
 * `packages/contracts/src/handoffMode.ts`. Tests decode with these to show what
 * a window or a machine of that release does with today's payloads. The field
 * schemas are today's: none of them changed since that tag.
 */
import {
  EnvironmentId,
  HandoffConfig,
  HandoffIncomingReplica,
  HandoffMachineRun,
  HandoffModeSetting,
  HandoffThreadState,
  IsoDateTime,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export const HandoffModeSnapshot383 = Schema.Struct({
  environmentId: EnvironmentId,
  machineLabel: Schema.String,
  config: HandoffConfig,
  projectModes: Schema.Record(Schema.String, HandoffModeSetting),
  threads: Schema.Array(HandoffThreadState),
  incoming: Schema.Array(HandoffIncomingReplica),
  pausedSince: Schema.NullOr(IsoDateTime),
  machineRun: Schema.NullOr(HandoffMachineRun),
});

/** `handoffModeResumeFenced` took no field. */
export const HandoffResumeFencedInput383 = Schema.Struct({});

export const HandOffMachineInput383 = Schema.Struct({
  destinationEnvironmentId: EnvironmentId,
  reason: Schema.Literals(["manual", "sleep", "away", "back"]),
  threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(100))),
});

/** A snapshot as a 1.0.383 machine sends it: no `transfers`, no `transferBatches`. */
export const SNAPSHOT_FROM_383 = {
  environmentId: "env-old",
  machineLabel: "Old Mac",
  config: {
    defaultMode: "off",
    noteModel: "off",
    pushToOrigin: false,
    sleepTarget: null,
    autoTakeoverMinutes: 0,
  },
  projectModes: {},
  threads: [],
  incoming: [],
  pausedSince: null,
  machineRun: null,
} as const;

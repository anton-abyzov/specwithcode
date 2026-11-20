/**
 * Two machines hold a handoff copy of the same thread, and its source goes
 * quiet (1390 AC-36). Carried here from the automatic coordinator takeover
 * cases, which went with equal coordinators: this one is about a thread, not
 * a coordinator, and still holds. A source on the previous release may name a
 * standby with a delay; no machine keeps that designation or continues the
 * thread on silence.
 */
import {
  type HandoffIncomingReplica,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { peerPastFence } from "./HandoffAutoContinue.ts";
import {
  previousAutoContinueCandidates,
  previousAutoContinueMinutes,
} from "./previousRelease.test.fixture.ts";
import {
  EMPTY_HANDOFF_DOCUMENT,
  type HandoffIncomingDetail,
  heartbeatContinued,
  incomingKey,
} from "./handoffState.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-26T14:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
/** Each machine's copy of the shared project. */
const PROJECTS = { m4: "easychamp-m4", m1: "easychamp-m1", m3: "easychamp-m3" } as const;

describe("a thread's handoff copies when its source goes quiet", () => {
  it("with two machines holding handoff copies, silence continues the thread on neither", () => {
    const thread = ThreadId.make("thread:fix-build");
    // What a source on the previous release still sends its standby: a delay to act after.
    const minutes = previousAutoContinueMinutes({ autoTakeoverMinutes: 1 });
    expect(minutes).toBe(5);
    const heartbeatTo = (peer: string) => ({
      sourceEnvironmentId: "m4",
      leases: [
        {
          sourceThreadId: thread,
          epoch: 1,
          ...(peer === "m1" ? { autoContinueMinutes: minutes! } : {}),
        },
      ],
    });
    const copyOn = (projectId: string) => {
      const replica = {
        sourceEnvironmentId: "m4",
        sourceLabel: "M4",
        sourceThreadId: thread,
        projectId,
        title: "Fix the build",
        checkpoint: { sequence: 3, runEnding: "active" },
        lease: { holderEnvironmentId: "m4", epoch: 1, renewedAt: iso(T0), state: "active" },
        sourceLastSeenAt: iso(T0),
        sourceUnreachable: false,
        receivedAt: iso(T0),
        continuedThreadId: null,
      } as unknown as HandoffIncomingReplica;
      return {
        ...EMPTY_HANDOFF_DOCUMENT,
        incoming: [replica],
        incomingDetails: {
          [incomingKey("m4", thread)]: {
            sourceProjectId: PROJECTS.m4,
            autoContinueMinutes: null,
          } as unknown as HandoffIncomingDetail,
        },
      };
    };
    const heardAt = T0 + MINUTE;
    // Neither the standby M1, named with a delay, nor M3 keeps a designation.
    for (const member of ["m1", "m3"] as const) {
      const [, heard] = heartbeatContinued(
        copyOn(PROJECTS[member]),
        heartbeatTo(member),
        iso(heardAt),
      );
      expect(heard.incomingDetails?.[incomingKey("m4", thread)]?.autoContinueMinutes).toBeNull();
      expect(
        previousAutoContinueCandidates(heard, {
          nowMs: heardAt + 24 * 60 * MINUTE,
          watchingSinceMs: T0,
          projectOf: () => null,
        }),
      ).toEqual([]);
    }
    // A standby an earlier release armed still fences this copy 130 seconds before it may act.
    const armed = { minutes: minutes!, baselineAt: iso(heardAt) };
    expect(peerPastFence(armed, heardAt + 5 * MINUTE - 130_000 - 1)).toBe(false);
    expect(peerPastFence(armed, heardAt + 5 * MINUTE - 130_000)).toBe(true);
  });
});

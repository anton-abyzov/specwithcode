import { ProviderInstanceId, RunId, RuntimeRequestId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { limitHandoffTrigger } from "./MachineLimitHandoff.ts";

const stoppedAt = Date.parse("2026-10-21T10:00:00.000Z");
const limited = {
  id: ThreadId.make("t1"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  status: "failed" as const,
  latestRunId: RunId.make("r2"),
  activeRunId: null,
  pendingRuntimeRequest: null,
  settledOverride: null,
  latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
};
const base = {
  thread: limited,
  rule: {
    providerLimitAction: "switch" as const,
    providerLimitMachineTargets: [
      {
        environmentId: "minis",
        machineLabel: "Minis",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      },
    ],
    providerLimitTargetOrder: "other-machine-first" as const,
  },
  nowMs: stoppedAt + 60_000,
  stopped: true,
  atThreshold: false,
  localStep: null,
  windowKey: "five_hour",
} as unknown as Parameters<typeof limitHandoffTrigger>[0];
const pending = (detail: object): Parameters<typeof limitHandoffTrigger>[0] => ({
  ...base,
  thread: {
    ...limited,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("q1"),
      createdAt: DateTime.makeUnsafe(stoppedAt),
      ...detail,
    },
  } as unknown as Parameters<typeof limitHandoffTrigger>[0]["thread"],
});

describe("limitHandoffTrigger with a pending request", () => {
  it("hands off past a question the next message answers", () => {
    expect(
      limitHandoffTrigger(
        pending({ kind: "user_input", responseCapability: { type: "message" }, runId: "r2" }),
      )?.key,
    ).toBe("limit-handoff:t1:r2");
  });

  it("hands off past a request an earlier run left", () => {
    expect(
      limitHandoffTrigger(
        pending({
          kind: "command",
          responseCapability: { type: "not_resumable", reason: "ended" },
          runId: "r1",
        }),
      ),
    ).not.toBeNull();
  });

  it("waits on an approval of the stopped run, or a request it cannot read", () => {
    expect(
      limitHandoffTrigger(
        pending({
          kind: "command",
          responseCapability: { type: "not_resumable", reason: "ended" },
          runId: "r2",
        }),
      ),
    ).toBeNull();
    expect(limitHandoffTrigger(pending({ kind: "user_input" }))).toBeNull();
  });
});

describe("limitHandoffTrigger for a thread on a track (1390 AC-37)", () => {
  const out = {
    kind: "track" as const,
    track: "daily" as const,
    outHere: true,
    fingerprints: [`sha256:${"a".repeat(64)}`],
    earliestResetMs: null,
  };
  const withTrack = (
    track: NonNullable<Parameters<typeof limitHandoffTrigger>[0]["track"]>,
    patch: Partial<Parameters<typeof limitHandoffTrigger>[0]> = {},
    order: "other-machine-first" | "same-machine-first" = "other-machine-first",
  ) =>
    limitHandoffTrigger({
      ...base,
      rule: { ...base.rule, providerLimitTargetOrder: order },
      track,
      ...patch,
    });

  const orders = ["other-machine-first", "same-machine-first"] as const;

  it.each(orders)("asks no machine while the track has room here, under %s", (order) => {
    // A second local source, or a later local model, still has room.
    const here = { ...out, outHere: false };
    expect(withTrack(here, { localStep: "switch" }, order)).toBeNull();
    // Even with no local step found this sweep, the track itself is not out.
    expect(withTrack(here, { localStep: null }, order)).toBeNull();
  });

  it.each(orders)("asks a machine once the track is out here, under %s", (order) => {
    const trigger = withTrack(out, { localStep: null }, order);
    expect(trigger).toMatchObject({ key: "limit-handoff:t1:r2", reason: "usage-limit" });
    expect(trigger?.track).toEqual(out);
    // A local step off the track does not hold it back: the track comes before the order.
    expect(withTrack(out, { localStep: "switch" }, order)?.track).toEqual(out);
  });

  it("still lets a banked reset, credits or API credits go first", () => {
    for (const localStep of ["redeem-reset", "spend-credits", "api-credits", "resume-api"])
      expect(withTrack(out, { localStep })).toBeNull();
  });

  it("starts nothing for a thread whose track is not known, or a review thread", () => {
    expect(withTrack({ kind: "held", reason: "Its track is not known." })).toBeNull();
  });

  it("leaves a project without tracks on its saved order", () => {
    const none = { kind: "none" as const };
    expect(withTrack(none, { localStep: "switch" }, "other-machine-first")?.key).toBe(
      "limit-handoff:t1:r2",
    );
    expect(withTrack(none, { localStep: "switch" }, "other-machine-first")?.track).toBeUndefined();
    expect(withTrack(none, { localStep: "switch" }, "same-machine-first")).toBeNull();
    expect(withTrack(none, { localStep: null }, "same-machine-first")).not.toBeNull();
  });

  it("keeps ask, wait and no targets as they are", () => {
    for (const providerLimitAction of ["ask", "wait"])
      expect(
        limitHandoffTrigger({
          ...base,
          rule: { ...base.rule, providerLimitAction } as never,
          track: out,
        }),
      ).toBeNull();
    expect(
      limitHandoffTrigger({
        ...base,
        rule: { ...base.rule, providerLimitMachineTargets: [] },
        track: out,
      }),
    ).toBeNull();
    // A stop that resets within the project's wait is no trigger at all.
    expect(withTrack(out, { stopped: false })).toBeNull();
  });
});

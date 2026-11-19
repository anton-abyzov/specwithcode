/**
 * The automatic start of a hand off when a thread's track is out on this
 * machine (1390 T-13): the track a thread is on, when that track is out here
 * (AC-37), what a machine's answer means for it (AC-38), and the wait when no
 * machine has the track (AC-39).
 */
import {
  EnvironmentId,
  HANDOFF_TRACK_START_CAPABILITY,
  HANDOFF_V2_CAPABILITY,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  confirmTarget,
  HANDOFF_PLAN_CAPABILITY,
  PeerCheckRequest,
  type PeerCheckEvidence,
  type PeerCheckResponse,
  unknownCheckPath,
} from "../handoff/handoffPlan.ts";
import {
  HANDOFF_CAPABILITIES,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_WORKTREE_SET_CAPABILITY,
  PeerPreflightRequest,
  TakeoverRequest,
} from "../handoff/handoffWire.ts";
import {
  encodePreviousPreflightRequest,
  overTheWire,
  PREVIOUS_RELEASE,
  PreviousTakeoverRequest,
} from "../handoff/previousRelease383.test.fixture.ts";
import { provider } from "../studio/fixtures.ts";
import { accountFingerprint, accountPoolKey } from "../usage/providerUsageSummary.ts";
import {
  judgeTrackMachine,
  limitHandoffTrackState,
  TRACK_RECHECK_UNKNOWN_MS,
  TRACK_RECHECK_UNREACHED_MS,
  trackDecision,
  trackOutReason,
  trackStartCapabilityFailure,
} from "./limitHandoffTrack.ts";

const now = Date.parse("2026-11-19T14:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const claude = ProviderInstanceId.make("claudeAgent");
const claudeTwo = ProviderInstanceId.make("claudeAgent-2");
const codex = ProviderInstanceId.make("codex");
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const FABLE = "claude-fable-5-2";
const SOL = "gpt-6.1-sol";

function source(
  id: ProviderInstanceId,
  driver: string,
  account: string,
  models: ReadonlyArray<string>,
  usedPercent: number,
  resetsAt = iso(now + 3 * 60 * 60_000),
): ServerProvider {
  const base = provider(id, driver, now);
  return {
    ...base,
    auth: { ...base.auth, email: account },
    models: models.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    })),
    usageLimits: {
      ...base.usageLimits!,
      windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent, resetsAt }],
    },
  } as ServerProvider;
}

const pool = (entry: ServerProvider) => accountFingerprint(accountPoolKey(entry)!);

const tracks = {
  threadModelMode: "tracks" as const,
  modelLanes: {
    routine: [
      { instanceId: claude, model: OPUS },
      { instanceId: claude, model: SONNET },
    ],
    complex: [{ instanceId: claude, model: FABLE }],
  },
  defaultModelProviders: [] as ReadonlyArray<ProviderInstanceId>,
  providerLimitExcludedModels: [],
  providerLimitSwitchAtPercent: null,
};

const thread = (patch: Record<string, unknown> = {}) =>
  ({
    id: ThreadId.make("t1"),
    providerInstanceId: claude,
    modelSelection: { instanceId: claude, model: OPUS },
    ...patch,
  }) as Parameters<typeof limitHandoffTrackState>[0]["thread"];

const routed = (lane: "routine" | "complex", extra: Record<string, unknown> = {}) => ({
  routing: { lane, ...extra },
});

const state = (
  providers: ReadonlyArray<ServerProvider>,
  patch: Record<string, unknown> = {},
  rule: Record<string, unknown> = tracks,
) =>
  limitHandoffTrackState({
    thread: thread(patch),
    rule: rule as Parameters<typeof limitHandoffTrackState>[0]["rule"],
    providers,
    nowMs: now,
  });

describe("the track a thread is on", () => {
  const spent = [source(claude, "claudeAgent", "a@example.test", [OPUS, SONNET, FABLE], 100)];

  it("is not read for a review told only by its title: it stays with its reviewer", () => {
    // No routing marker, and Opus is on the Daily track alone.
    const only = {
      ...tracks,
      modelLanes: { routine: [{ instanceId: claude, model: OPUS }], complex: [] },
    };
    expect(state(spent, { title: "Adversarial review: Sign in" }, only)).toMatchObject({
      kind: "held",
    });
    expect(state(spent, { title: "Sign in with passkeys" }, only)).toMatchObject({
      kind: "track",
      track: "daily",
    });
  });

  it("starts nothing when the track ran out on more account pools than a check can name", () => {
    const ids = Array.from({ length: 17 }, (_, index) =>
      ProviderInstanceId.make(`claudeAgent-${index}`),
    );
    const many = ids.map((id, index) =>
      source(id, "claudeAgent", `account-${index}@example.test`, [OPUS], 100),
    );
    const rule = {
      ...tracks,
      modelLanes: { routine: ids.map((instanceId) => ({ instanceId, model: OPUS })), complex: [] },
    };
    const on = (count: number) =>
      limitHandoffTrackState({
        thread: thread({
          providerInstanceId: ids[0],
          modelSelection: { instanceId: ids[0]!, model: OPUS },
          ...routed("routine"),
        }),
        rule: {
          ...rule,
          modelLanes: { routine: rule.modelLanes.routine.slice(0, count), complex: [] },
        } as Parameters<typeof limitHandoffTrackState>[0]["rule"],
        providers: many.slice(0, count),
        nowMs: now,
      });
    // Sixteen pools fit in one check; a seventeenth would go unnamed, so nothing starts.
    expect(on(16)).toMatchObject({ kind: "track", outHere: true });
    expect(new Set((on(16) as { fingerprints: ReadonlyArray<string> }).fingerprints).size).toBe(16);
    expect(on(17)).toMatchObject({ kind: "held" });
  });

  it("is none in a project that is not on tracks: its saved order decides as before", () => {
    expect(state(spent, routed("routine"), { ...tracks, threadModelMode: "model" })).toEqual({
      kind: "none",
    });
  });

  it("comes from the routing decision, not from which list names the model", () => {
    // Opus is on Daily here; the task was routed as Complex work.
    const both = {
      ...tracks,
      modelLanes: { ...tracks.modelLanes, complex: [{ instanceId: claude, model: OPUS }] },
    };
    expect(state(spent, routed("complex"), both)).toMatchObject({
      kind: "track",
      track: "complex",
    });
    expect(state(spent, routed("routine"), both)).toMatchObject({ kind: "track", track: "daily" });
  });

  it("with no routing decision, is the one track that names its model", () => {
    expect(state(spent)).toMatchObject({ kind: "track", track: "daily" });
    expect(state(spent, { modelSelection: { instanceId: claude, model: FABLE } })).toMatchObject({
      kind: "track",
      track: "complex",
    });
  });

  it("is never guessed: a model on both tracks, or on neither, holds the thread here", () => {
    const both = {
      ...tracks,
      modelLanes: { ...tracks.modelLanes, complex: [{ instanceId: claude, model: OPUS }] },
    };
    expect(state(spent, {}, both).kind).toBe("held");
    expect(state(spent, { modelSelection: { instanceId: codex, model: SOL } }).kind).toBe("held");
  });

  it("holds a review thread: it keeps its reviewer", () => {
    expect(state(spent, routed("routine", { reviewFamily: "claude" })).kind).toBe("held");
    expect(state(spent, { routing: { taskClass: "review" } }).kind).toBe("held");
  });
});

describe("a track is out on this machine only when nothing on it has room here (AC-37)", () => {
  const first = (used: number) =>
    source(claude, "claudeAgent", "a@example.test", [OPUS, SONNET, FABLE], used);

  it("is not out while a second source of the thread's model has room", () => {
    const second = source(claudeTwo, "claudeAgent", "b@example.test", [OPUS], 20);
    expect(state([first(100), second], routed("routine"))).toMatchObject({
      kind: "track",
      track: "daily",
      outHere: false,
    });
  });

  it("is not out while a later model of the track has room", () => {
    // Opus is spent on both of its sources; Sonnet, next on Daily, runs on Codex's account.
    const rule = {
      ...tracks,
      modelLanes: {
        ...tracks.modelLanes,
        routine: [
          { instanceId: claude, model: OPUS },
          { instanceId: codex, model: SOL },
        ],
      },
    };
    const second = source(claudeTwo, "claudeAgent", "b@example.test", [OPUS], 100);
    const later = source(codex, "codex", "c@example.test", [SOL], 30);
    expect(state([first(100), second, later], routed("routine"), rule)).toMatchObject({
      kind: "track",
      outHere: false,
    });
  });

  it("is out when every source and every later model is spent, whatever another track has", () => {
    const rule = {
      ...tracks,
      modelLanes: {
        routine: [
          { instanceId: claude, model: OPUS },
          { instanceId: codex, model: SOL },
        ],
        // Complex still has room on a third account: it is another track.
        complex: [{ instanceId: ProviderInstanceId.make("claudeAgent-3"), model: FABLE }],
      },
    };
    const a = first(100);
    const b = source(claudeTwo, "claudeAgent", "b@example.test", [OPUS], 100);
    const c = source(codex, "codex", "c@example.test", [SOL], 100, iso(now + 60 * 60_000));
    const other = source(
      ProviderInstanceId.make("claudeAgent-3"),
      "claudeAgent",
      "d@example.test",
      [FABLE],
      10,
    );
    const out = state([a, b, c, other], routed("routine"), rule);
    expect(out).toMatchObject({ kind: "track", track: "daily", outHere: true });
    if (out.kind !== "track") throw new Error("expected a track");
    // Every pool the track ran out on here, on any provider, and none of another track's.
    expect([...out.fingerprints].sort()).toEqual([pool(a), pool(b), pool(c)].sort());
    expect(out.fingerprints).not.toContain(pool(other));
    // The first of them to reset is when the track has room here again.
    expect(out.earliestResetMs).toBe(now + 60 * 60_000);
  });

  it("at a threshold, a source at it is spent and one below it is not", () => {
    const rule = { ...tracks, providerLimitSwitchAtPercent: 90 };
    const second = (used: number) =>
      source(claudeTwo, "claudeAgent", "b@example.test", [OPUS, SONNET], used);
    expect(state([first(95), second(92)], routed("routine"), rule)).toMatchObject({
      outHere: true,
    });
    expect(state([first(95), second(60)], routed("routine"), rule)).toMatchObject({
      outHere: false,
    });
  });
});

const minis = EnvironmentId.make("env-minis");
const m5 = EnvironmentId.make("env-m5");
const t1 = ThreadId.make("t1");
const opus: ModelSelection = { instanceId: claude, model: OPUS };

const evidence = (patch: Partial<PeerCheckEvidence> = {}): PeerCheckEvidence => ({
  modelSelection: opus,
  providerName: "Claude",
  kind: "different-account",
  line: "Different Claude account · 60% left",
  percentLeft: 60,
  automatic: true,
  accountFingerprint: `sha256:${"b".repeat(64)}`,
  usedPercent: 40,
  resetsAt: iso(now + 2 * 60 * 60_000),
  observedAt: iso(now - 60_000),
  ...patch,
});

const answered = (
  result: Partial<PeerCheckResponse["results"][number]>,
  capabilities: ReadonlyArray<string> = HANDOFF_CAPABILITIES,
  machineLabel = "Minis",
) => ({
  kind: "answered" as const,
  response: {
    machineLabel,
    protocolVersion: HANDOFF_PROTOCOL_VERSION,
    appVersion: "1.0.390",
    capabilities: [...capabilities],
    results: [{ sourceThreadId: t1, failures: [], evidence: null, ...result }],
  } satisfies PeerCheckResponse,
});

const judged = (
  answer: Parameters<typeof judgeTrackMachine>[0]["answer"],
  environmentId = minis,
  machineLabel = "Minis",
) => judgeTrackMachine({ environmentId, machineLabel, threadId: t1, answer });

describe("what a machine's answer means for the track (AC-38)", () => {
  it("a machine whose project runs on one model has no room for a track, whatever is signed in", () => {
    // The receiver's own answer for a project that is not on tracks there.
    const confirmed = confirmTarget({
      machineLabel: "Minis",
      sourceLabel: "M4",
      start: "automatic",
      thresholdPercent: 99,
      nowMs: now,
      project: { title: "App", inGrant: true },
      otherHolder: null,
      thread: {
        modelSelection: { instanceId: claude, model: OPUS },
        track: "daily",
        driverKind: "claudeAgent",
        accountFingerprints: [`sha256:${"a".repeat(64)}`],
      },
      trackEntries: null,
      signIns: [
        {
          provider: {
            instanceId: claude,
            driver: "claudeAgent",
            displayName: "Claude",
            enabled: true,
            installed: true,
            authStatus: "authenticated",
            models: [{ slug: OPUS }],
          },
          usage: {
            accountFingerprint: `sha256:${"b".repeat(64)}`,
            usedPercent: 10,
            resetsAt: iso(now + 60 * 60_000),
            signedIn: true,
            observedAt: iso(now - 60_000),
          },
        },
      ],
      accountRefusal: () => null,
    });
    const judged = judgeTrackMachine({
      environmentId: EnvironmentId.make("env-minis"),
      machineLabel: "Minis",
      threadId: t1,
      answer: answered(confirmed),
    });
    expect(judged.state).toBe("out");
    expect(judged.evidence).toBeNull();
    expect(judged.line).toContain("does not use the Daily track here");
  });

  it("is a target on a sign-in of the track with a fresh reading below the threshold", () => {
    const sonnet = { instanceId: claudeTwo, model: SONNET };
    const result = judged(answered({ evidence: evidence({ modelSelection: sonnet }) }));
    expect(result).toMatchObject({ state: "room", machineLabel: "Minis" });
    // The sign-in the machine confirmed is the one the thread runs on there.
    expect(result.evidence?.modelSelection).toEqual(sonnet);
  });

  it("adds nothing on the same depleted pool", () => {
    const result = judged(
      answered({
        failures: [
          { check: "provider", message: "Minis: Same Claude account as M4: adds no usage" },
        ],
        evidence: evidence({
          kind: "same-account",
          automatic: false,
          line: "Same Claude account as M4: adds no usage",
        }),
      }),
    );
    expect(result).toMatchObject({
      state: "out",
      line: "Minis: Same Claude account as M4: adds no usage",
    });
  });

  it("never qualifies on unknown or stale usage, whatever the unknown-usage setting says", () => {
    const stale = evidence({ kind: "usage-unknown", automatic: false, line: "Usage unknown" });
    expect(
      judged(
        answered({
          failures: [{ check: "provider", message: "Minis: Usage unknown" }],
          evidence: stale,
        }),
      ).state,
    ).toBe("out");
    // Even an answer with no failure listed is not a target without a reading that qualifies.
    expect(judged(answered({ evidence: stale })).state).toBe("out");
    // A reset read with usage nobody verified is not when the track is back.
    expect(
      judged(answered({ evidence: { ...stale, resetsAt: iso(now + 30 * 60_000) } })).resetsAt,
    ).toBeNull();
    expect(judged(answered({ evidence: null })).state).toBe("out");
  });

  it("is not a target off the track: another track's room is never taken", () => {
    expect(
      judged(
        answered({
          failures: [
            { check: "model", message: "Minis: nothing on the Daily track is set up here" },
          ],
        }),
      ),
    ).toMatchObject({
      state: "out",
      line: "Minis: nothing on the Daily track is set up here",
    });
  });

  it("is not read as out when the machine could not be asked or cannot take the project", () => {
    expect(judged({ kind: "unreachable", line: "Minis: offline" })).toMatchObject({
      state: "unreachable",
      line: "Minis: offline",
    });
    expect(
      judged(
        answered({
          failures: [{ check: "project-link", message: "Minis: App isn't linked there" }],
        }),
      ).state,
    ).toBe("error");
    expect(
      judged({ kind: "failed", error: { message: "Minis did not answer.", needsUpdate: false } })
        .state,
    ).toBe("error");
  });
});

const decide = (patch: Partial<Parameters<typeof trackDecision>[0]> = {}) =>
  trackDecision({
    threadId: t1,
    track: "daily",
    machineLabel: "M4",
    outHere: true,
    localResetMs: null,
    machines: [],
    target: null,
    nowMs: now,
    ...patch,
  });

const out = (environmentId: EnvironmentId, label: string, resetsAt: string | null) =>
  judged(
    answered(
      {
        failures: [{ check: "provider", message: `${label}: Claude limit reached` }],
        evidence: evidence({ automatic: false, line: "Claude limit reached", resetsAt }),
      },
      HANDOFF_CAPABILITIES,
      label,
    ),
    environmentId,
    label,
  );

describe("when no machine has the track, the thread stays and names the next reset (AC-39)", () => {
  it("names the earliest of two reset times, and checks again at it", () => {
    const decision = decide({
      localResetMs: now + 4 * 60 * 60_000,
      machines: [
        out(minis, "Minis", iso(now + 3 * 60 * 60_000)),
        out(m5, "M5", iso(now + 90 * 60_000)),
      ],
    });
    expect(decision).toMatchObject({
      threadId: t1,
      track: "daily",
      trackOut: true,
      reason: "Daily track out of tokens on M4",
      target: null,
      everyMachineOut: true,
      earliestReset: { machineLabel: "M5", at: iso(now + 90 * 60_000) },
      recheckAt: iso(now + 90 * 60_000),
    });
    expect(decision.machines.map((machine) => machine.state)).toEqual(["out", "out"]);
  });

  it("names this machine when its own reset comes first", () => {
    expect(
      decide({
        localResetMs: now + 30 * 60_000,
        machines: [out(minis, "Minis", iso(now + 3 * 60 * 60_000))],
      }).earliestReset,
    ).toEqual({ machineLabel: "M4", at: iso(now + 30 * 60_000) });
  });

  it("says the reset is unknown with no reset time, and asks again no sooner than the reading ages", () => {
    const decision = decide({ machines: [out(minis, "Minis", null), out(m5, "M5", null)] });
    expect(decision).toMatchObject({ everyMachineOut: true, earliestReset: null });
    expect(decision.recheckAt).toBe(iso(now + TRACK_RECHECK_UNKNOWN_MS));
    // A reset already past is no reset to wait for.
    expect(decide({ machines: [out(minis, "Minis", iso(now - 60_000))] }).earliestReset).toBeNull();
  });

  it("is not out on every machine while one could not be asked, and that one is asked again", () => {
    const decision = decide({
      machines: [
        out(minis, "Minis", iso(now + 60 * 60_000)),
        judged({ kind: "unreachable", line: "M5: offline" }, m5, "M5"),
      ],
    });
    expect(decision.everyMachineOut).toBe(false);
    expect(decision.target).toBeNull();
    expect(decision.recheckAt).toBe(iso(now + TRACK_RECHECK_UNREACHED_MS));
  });

  it("with no machine set up, the track is out everywhere it could run", () => {
    expect(decide()).toMatchObject({ everyMachineOut: true, earliestReset: null });
  });

  it("records the machine and sign-in chosen when one has room", () => {
    const sonnet = { instanceId: claudeTwo, model: SONNET };
    const decision = decide({
      machines: [judged(answered({ evidence: evidence({ modelSelection: sonnet }) }))],
      target: {
        environmentId: minis,
        machineLabel: "Minis",
        modelSelection: sonnet,
        disposition: "resume",
      },
    });
    expect(decision).toMatchObject({
      everyMachineOut: false,
      recheckAt: null,
      target: { machineLabel: "Minis", modelSelection: sonnet, disposition: "resume" },
    });
  });

  it("words the reason by track and machine, within the transfer record's limit", () => {
    expect(trackOutReason("complex", "m4")).toBe("Complex track out of tokens on m4");
    expect(trackOutReason("daily", "x".repeat(300)).length).toBeLessThanOrEqual(120);
  });
});

describe(`the automatic track start with a machine on ${PREVIOUS_RELEASE}, and with one from before it (EC2-04, EC2-09)`, () => {
  const M4 = EnvironmentId.make("env-m4");
  const P1 = ProjectId.make("p1");

  it("names its own capability, beside the transfer record's and the plan's", () => {
    expect(HANDOFF_TRACK_START_CAPABILITY).toBe("handoff.track-start");
    expect(HANDOFF_CAPABILITIES).toEqual([
      HANDOFF_V2_CAPABILITY,
      HANDOFF_PLAN_CAPABILITY,
      HANDOFF_TRACK_START_CAPABILITY,
      HANDOFF_WORKTREE_SET_CAPABILITY,
    ]);
  });

  it(`as the target: ${PREVIOUS_RELEASE} has no check path, so it reads "Needs update" and the thread stays`, () => {
    const result = judged(
      { kind: "failed", error: unknownCheckPath("OLD") },
      EnvironmentId.make("env-old"),
      "OLD",
    );
    expect(result.state).toBe("needs-update");
    expect(result.line.startsWith("Needs update: OLD ")).toBe(true);
    // One machine that needs an update is not "out on every machine".
    expect(decide({ machines: [result] })).toMatchObject({ target: null, everyMachineOut: false });
  });

  it("as the target: a machine that plans but names no track start stays, whatever it answered", () => {
    const before = [HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY];
    const result = judged(answered({ evidence: evidence() }, before));
    expect(result.state).toBe("needs-update");
    expect(result.line.startsWith("Needs update: Minis ")).toBe(true);
    expect(result.evidence).toBeNull();
    // With the capability the same answer is a target.
    expect(judged(answered({ evidence: evidence() })).state).toBe("room");
  });

  it(`as the source: ${PREVIOUS_RELEASE} and a machine that only plans are not answered for a track start`, () => {
    // What the release sends names no capability, and is no check at all.
    const sent = overTheWire(
      encodePreviousPreflightRequest({
        sourceEnvironmentId: M4,
        protocolVersion: 2,
        appVersion: "1.0.383",
        threads: [{ sourceThreadId: t1, sourceProjectId: P1, sequence: 1, modelSelection: opus }],
      }),
    );
    const read = Option.getOrThrow(Schema.decodeUnknownOption(PeerPreflightRequest)(sent));
    expect(read.capabilities).toBeUndefined();
    expect(Option.isNone(Schema.decodeUnknownOption(PeerCheckRequest)(sent))).toBe(true);
    const from = (capabilities: ReadonlyArray<string> | undefined, start = "automatic") =>
      trackStartCapabilityFailure({
        peerLabel: "The source machine",
        capabilities,
        start: start as "automatic" | "manual",
        tracked: true,
      });
    expect(from(read.capabilities)?.check).toBe("version");
    expect(from([HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY])?.message).toMatch(
      /^Needs update: The source machine /,
    );
    expect(from(HANDOFF_CAPABILITIES)).toBeNull();
    // A hand off by hand, or a thread with no track, asks nothing of this capability.
    expect(from([HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY], "manual")).toBeNull();
    expect(
      trackStartCapabilityFailure({
        peerLabel: "The source machine",
        capabilities: [HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY],
        start: "automatic",
        tracked: false,
      }),
    ).toBeNull();
  });

  it(`as the source: what this build sends still decodes on ${PREVIOUS_RELEASE}`, () => {
    // The takeover of an automatic track start, with its key and reason, adds no field the release rejects.
    const takeover = Schema.encodeSync(TakeoverRequest)({
      sourceEnvironmentId: M4,
      sourceThreadId: t1,
      epoch: 2,
      sequence: 1,
      reason: "handoff",
      modelSelection: opus,
      trigger: {
        kind: "automatic",
        key: "limit-handoff:t1:r1",
        reason: trackOutReason("daily", "M4"),
      },
    });
    expect(
      Option.isSome(Schema.decodeUnknownOption(PreviousTakeoverRequest)(overTheWire(takeover))),
    ).toBe(true);
    // And this build's check, with the capability in its list, is still a check.
    const check = Schema.encodeSync(PeerCheckRequest)({
      sourceEnvironmentId: M4,
      sourceLabel: "M4",
      protocolVersion: HANDOFF_PROTOCOL_VERSION,
      appVersion: "1.0.390",
      capabilities: [...HANDOFF_CAPABILITIES],
      start: "automatic",
      thresholdPercent: null,
      threads: [
        {
          sourceThreadId: t1,
          sourceProjectId: P1,
          modelSelection: opus,
          track: "daily",
          driverKind: "claudeAgent",
          accountFingerprints: [`sha256:${"a".repeat(64)}`],
        },
      ],
    });
    expect(Option.isSome(Schema.decodeUnknownOption(PeerCheckRequest)(overTheWire(check)))).toBe(
      true,
    );
  });
});

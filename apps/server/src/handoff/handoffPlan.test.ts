// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
/**
 * The per-thread hand off plan (1390): what the receiver confirms about its
 * own track and account, what each thread does on arrival, what is measured on
 * the checkpoint that would travel, and the plan's own capability against a
 * machine on the latest release and against one that keeps transfer records
 * but plans nothing.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HANDOFF_V2_CAPABILITY,
  type ModelSelection,
  type OrchestratorMcpProviderUsage,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { unscopedGrant } from "../fleet/workGrantPolicy.ts";
import { handoffRef } from "./checkpointGit.ts";
import {
  buildHandoffPlan,
  type CheckSignIn,
  checkAnswer,
  checkRef,
  confirmTarget,
  folderWorkItem,
  grewPastLimit,
  HANDOFF_PLAN_CAPABILITY,
  type HandoffMeasure,
  type HandoffPlanFacts,
  type HandoffThreadFact,
  measureTravel,
  outcomeLine,
  PeerCheckRequest,
  PeerCheckResponse,
  planCapabilityFailure,
  planThread,
  trackOfThread,
  unknownCheckPath,
} from "./handoffPlan.ts";
import { makeRig, type RigMachine } from "./handoffTransfer.test.fixture.ts";
import {
  HANDOFF_CAPABILITIES,
  HANDOFF_PROTOCOL_VERSION,
  PEER_PATHS,
  PeerPreflightRequest,
} from "./handoffWire.ts";
import {
  PREVIOUS_PEER_PATHS,
  PREVIOUS_RELEASE,
  PreviousPeerPreflightRequest,
  encodePreviousPreflightRequest,
  overTheWire,
} from "./previousRelease383.test.fixture.ts";

const temporary: Array<string> = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    NodeFS.rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const now = Date.parse("2026-11-19T14:00:00.000Z");
const fresh = "2026-11-19T13:58:00.000Z";
const stale = "2026-11-19T13:30:00.000Z";
const laterReset = "2026-11-19T18:00:00.000Z";
const poolA = `sha256:${"a".repeat(64)}`;
const poolB = `sha256:${"b".repeat(64)}`;

const M4 = EnvironmentId.make("env-m4");
const MINI = EnvironmentId.make("env-mini");
const P1 = ProjectId.make("project-1");
const t1 = ThreadId.make("thread:one");

const fable: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-2",
};
const fableWork: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent-work"),
  model: "claude-fable-5-2",
};
const astra: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
};
const opus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const usage = (
  overrides: Partial<OrchestratorMcpProviderUsage> = {},
): OrchestratorMcpProviderUsage => ({
  accountFingerprint: poolB,
  usedPercent: 40,
  resetsAt: laterReset,
  signedIn: true,
  observedAt: fresh,
  ...overrides,
});

const signIn = (
  selection: ModelSelection,
  driver: string,
  name: string,
  reading: Partial<OrchestratorMcpProviderUsage> = {},
): CheckSignIn => ({
  provider: {
    instanceId: selection.instanceId,
    driver,
    displayName: name,
    enabled: true,
    installed: true,
    authStatus: "authenticated",
    models: [{ slug: selection.model }],
  },
  usage: usage(reading),
});

const confirm = (overrides: Partial<Parameters<typeof confirmTarget>[0]> = {}) =>
  confirmTarget({
    machineLabel: "Minis",
    sourceLabel: "M4",
    start: "automatic",
    thresholdPercent: 99,
    nowMs: now,
    project: { title: "App", inGrant: true },
    otherHolder: null,
    thread: {
      modelSelection: fable,
      track: "complex",
      driverKind: "claudeAgent",
      accountFingerprints: [poolA],
    },
    trackEntries: [fable],
    signIns: [signIn(fable, "claudeAgent", "Claude")],
    accountRefusal: () => null,
    ...overrides,
  });

describe("the receiver confirms its own track, account and usage (AC-38)", () => {
  it("confirms the actual model, the account and a fresh reading below the threshold", () => {
    const answer = confirm();
    expect(answer.failures).toEqual([]);
    expect(answer.evidence).toMatchObject({
      modelSelection: fable,
      providerName: "Claude",
      kind: "different-account",
      line: "Different Claude account · 60% left",
      automatic: true,
      accountFingerprint: poolB,
      usedPercent: 40,
      observedAt: fresh,
    });
  });

  it("needs no copy of the thread: nothing here asks for a checkpoint", () => {
    expect(confirm().failures.map((failure) => failure.check)).not.toContain("checkpoint");
  });

  it("adds nothing on the same depleted pool, and tries the next sign-in on that track", () => {
    const shared = confirm({
      signIns: [signIn(fable, "claudeAgent", "Claude", { accountFingerprint: poolA })],
    });
    expect(shared.failures).toEqual([
      { check: "provider", message: "Minis: Same Claude account as M4: adds no usage" },
    ]);
    expect(shared.evidence).toMatchObject({ kind: "same-account", automatic: false });

    const next = confirm({
      trackEntries: [fable, fableWork, astra],
      signIns: [
        signIn(fable, "claudeAgent", "Claude", { accountFingerprint: poolA }),
        signIn(fableWork, "claudeAgent", "Claude (work)", { usedPercent: 12 }),
        signIn(astra, "codex", "Codex"),
      ],
    });
    expect(next.failures).toEqual([]);
    expect(next.evidence).toMatchObject({
      modelSelection: fableWork,
      line: "Different Claude (work) account · 88% left",
      automatic: true,
    });
  });

  it("never qualifies an automatic move on unknown or stale usage", () => {
    for (const reading of [
      { usedPercent: null },
      { observedAt: stale },
      { observedAt: stale, resetsAt: laterReset, usedPercent: 10 },
      { observedAt: null },
      { accountFingerprint: null },
    ] satisfies ReadonlyArray<Partial<OrchestratorMcpProviderUsage>>) {
      const answer = confirm({ signIns: [signIn(fable, "claudeAgent", "Claude", reading)] });
      expect(answer.failures).toEqual([{ check: "provider", message: "Minis: Usage unknown" }]);
      expect(answer.evidence).toMatchObject({ kind: "usage-unknown", automatic: false });
    }
    const atThreshold = confirm({
      signIns: [signIn(fable, "claudeAgent", "Claude", { usedPercent: 99 })],
    });
    expect(atThreshold.failures).toHaveLength(1);
    expect(atThreshold.evidence?.automatic).toBe(false);
  });

  it("allows a same-account or unknown target by hand, with its line", () => {
    const same = confirm({
      start: "manual",
      signIns: [signIn(fable, "claudeAgent", "Claude", { accountFingerprint: poolA })],
    });
    expect(same.failures).toEqual([]);
    expect(same.evidence?.line).toBe("Same Claude account as M4: adds no usage");
    expect(same.evidence?.automatic).toBe(false);

    const unknown = confirm({
      start: "manual",
      signIns: [signIn(fable, "claudeAgent", "Claude", { observedAt: stale })],
    });
    expect(unknown.failures).toEqual([]);
    expect(unknown.evidence?.line).toBe("Usage unknown");

    // A sign-in with room still comes before one that adds nothing.
    const better = confirm({
      start: "manual",
      trackEntries: [fable, fableWork],
      signIns: [
        signIn(fable, "claudeAgent", "Claude", { accountFingerprint: poolA }),
        signIn(fableWork, "claudeAgent", "Claude (work)"),
      ],
    });
    expect(better.evidence?.modelSelection).toEqual(fableWork);
  });

  it("is no target for another track, by hand or automatically", () => {
    for (const start of ["automatic", "manual"] as const) {
      const answer = confirm({
        start,
        // The machine has the Daily model signed in, with room, and nothing on Complex.
        trackEntries: [],
        signIns: [signIn(opus, "claudeAgent", "Claude")],
      });
      expect(answer.failures).toEqual([
        { check: "model", message: "Minis: nothing on the Complex track is set up here" },
      ]);
      expect(answer.evidence).toBeNull();
    }
  });

  it("is no target when its copy of the project has no tracks, though the model is signed in", () => {
    // What the receiver passes for a project that runs one fixed model: no track at all.
    for (const start of ["automatic", "manual"] as const) {
      const answer = confirm({ start, trackEntries: null });
      expect(answer.failures).toEqual([
        { check: "model", message: "Minis: App does not use the Complex track here" },
      ]);
      expect(answer.evidence).toBeNull();
    }
  });

  it("skips a pool the track is already out on, whichever provider serves it", () => {
    const poolC = `sha256:${"c".repeat(64)}`;
    // The track ran out on Claude (pool A) and on Codex (pool C); the thread stopped on Claude.
    const thread = {
      modelSelection: fable,
      track: "complex" as const,
      driverKind: "claudeAgent",
      accountFingerprints: [poolA, poolC],
    };
    const only = confirm({
      thread,
      trackEntries: [astra],
      signIns: [signIn(astra, "codex", "Codex", { accountFingerprint: poolC, usedPercent: 12 })],
    });
    expect(only.evidence).toMatchObject({ kind: "same-account", automatic: false });
    expect(only.failures).toEqual([
      { check: "provider", message: "Minis: Same Codex account as M4: adds no usage" },
    ]);
    const next = confirm({
      thread,
      trackEntries: [astra, fableWork],
      signIns: [
        signIn(astra, "codex", "Codex", { accountFingerprint: poolC, usedPercent: 12 }),
        signIn(fableWork, "claudeAgent", "Claude (work)"),
      ],
    });
    expect(next.failures).toEqual([]);
    expect(next.evidence?.modelSelection).toEqual(fableWork);
  });

  it("intersects its sign-ins with what the grant allows", () => {
    const refusal = "Minis: this machine lets M4 use only these sign-ins: codex.";
    const answer = confirm({
      trackEntries: [fable, astra],
      signIns: [signIn(fable, "claudeAgent", "Claude"), signIn(astra, "codex", "Codex")],
      accountRefusal: (instanceId) => (instanceId === fable.instanceId ? refusal : null),
    });
    expect(answer.failures).toEqual([]);
    expect(answer.evidence?.modelSelection).toEqual(astra);

    const none = confirm({ accountRefusal: () => refusal });
    expect(none.failures).toEqual([{ check: "grant", message: refusal }]);
    expect(none.evidence).toBeNull();
  });

  it("checks the named model when the thread has no track", () => {
    const answer = confirm({
      thread: {
        modelSelection: opus,
        track: null,
        driverKind: "claudeAgent",
        accountFingerprints: [poolA],
      },
      trackEntries: null,
      signIns: [signIn(opus, "claudeAgent", "Claude")],
    });
    expect(answer.failures).toEqual([]);
    expect(answer.evidence?.modelSelection).toEqual(opus);
  });

  it("still names the link, the grant, the provider and the lease", () => {
    expect(confirm({ project: null }).failures.map((failure) => failure.check)).toEqual([
      "project-link",
    ]);
    expect(
      confirm({ project: { title: "App", inGrant: false } }).failures.map(
        (failure) => failure.check,
      ),
    ).toEqual(["grant"]);
    expect(confirm({ otherHolder: "M3" }).failures.map((failure) => failure.check)).toEqual([
      "lease",
    ]);
    expect(confirm({ signIns: [] }).failures).toEqual([
      { check: "provider", message: "Minis: claudeAgent is not set up" },
    ]);
  });
});

describe("the reset a machine with no room names (AC-39)", () => {
  it("is the earliest of its sign-ins on the track, not the first one listed", () => {
    const at14 = "2026-11-19T14:30:00.000Z";
    const answer = confirm({
      trackEntries: [fable, astra],
      signIns: [
        signIn(fable, "claudeAgent", "Claude", { usedPercent: 100, resetsAt: laterReset }),
        signIn(astra, "codex", "Codex", { usedPercent: 100, resetsAt: at14 }),
      ],
    });
    expect(answer.failures.map((failure) => failure.check)).toEqual(["provider"]);
    expect(answer.evidence).toMatchObject({ automatic: false, resetsAt: at14 });
  });

  it("skips a reset that has passed and one nobody named", () => {
    const answer = confirm({
      trackEntries: [fable, fableWork, astra],
      signIns: [
        signIn(fable, "claudeAgent", "Claude", { usedPercent: 100, resetsAt: null }),
        signIn(fableWork, "claudeAgent", "Claude", { usedPercent: 100, resetsAt: stale }),
        signIn(astra, "codex", "Codex", { usedPercent: 100, resetsAt: laterReset }),
      ],
    });
    expect(answer.evidence).toMatchObject({ automatic: false, resetsAt: laterReset });
  });
});

describe("the thread's track at the source", () => {
  const lanes = { complex: [fable, astra], routine: [opus] };
  const both = { complex: [fable, opus], routine: [opus, astra] };
  const track = (input: Partial<Parameters<typeof trackOfThread>[0]>) =>
    trackOfThread({ review: false, model: opus.model, lanes, routedLane: null, ...input });

  it("is the track its routing chose, whatever else names the model", () => {
    expect(track({ lanes: both, routedLane: "routine" })).toEqual({
      track: "daily",
      ambiguous: false,
    });
    expect(track({ lanes: both, routedLane: "complex" })).toEqual({
      track: "complex",
      ambiguous: false,
    });
    expect(track({ review: true, routedLane: "routine" }).track).toBe("review");
  });

  it("without a routing decision, is the one track that names its model", () => {
    expect(track({ model: fable.model })).toEqual({ track: "complex", ambiguous: false });
    expect(track({ model: opus.model })).toEqual({ track: "daily", ambiguous: false });
  });

  it("is not guessed when both tracks name the model", () => {
    expect(track({ lanes: both })).toEqual({ track: null, ambiguous: true });
  });

  it("is none for a project without tracks, or a model on neither", () => {
    expect(track({ lanes: null, routedLane: "complex" })).toEqual({
      track: null,
      ambiguous: false,
    });
    expect(track({ lanes: null, review: true }).track).toBeNull();
    expect(track({ model: "other" })).toEqual({ track: null, ambiguous: false });
  });
});

const checked = (overrides: Partial<HandoffThreadFact> = {}): HandoffThreadFact => ({
  id: t1,
  title: "Fix the parser",
  projectId: P1,
  personal: false,
  activity: "running",
  unsaved: false,
  pending: null,
  runEnding: "active",
  lastTurnEndedAt: null,
  reviewStay: null,
  worktreeSet: false,
  brokenFolder: null,
  trackAmbiguous: false,
  check: {
    kind: "checked",
    failures: [],
    evidence: {
      modelSelection: fable,
      providerName: "Claude",
      kind: "different-account",
      line: "Different Claude account · 60% left",
      percentLeft: 60,
      automatic: true,
      accountFingerprint: poolB,
      usedPercent: 40,
      resetsAt: laterReset,
      observedAt: fresh,
    },
  },
  measure: { bytes: 2048, files: 3, over: null },
  usage: null,
  ...overrides,
});

const facts = (overrides: Partial<HandoffPlanFacts> = {}): HandoffPlanFacts => ({
  start: "manual",
  self: { environmentId: M4, label: "M4" },
  target: { environmentId: MINI, label: "Minis" },
  rule: null,
  threads: [],
  folderWork: [],
  nowMs: now,
  ...overrides,
});

const automatic = (overrides: Partial<HandoffPlanFacts> = {}) =>
  facts({
    start: "automatic",
    rule: { action: "switch", hasTargets: true, thresholdPercent: 99 },
    ...overrides,
  });

const atThreshold = { usedPercent: 99, windowKey: laterReset, movedInWindow: false };

describe("a hand off by hand (AC-17, AC-19, AC-20)", () => {
  it("lists each thread once, ticked, in the group of what it is doing", () => {
    const plan = buildHandoffPlan(
      facts({
        threads: [
          checked({ id: ThreadId.make("t:running") }),
          checked({ id: ThreadId.make("t:queued"), activity: "queued", runEnding: "none" }),
          checked({ id: ThreadId.make("t:waiting"), activity: "waiting", runEnding: "completed" }),
          checked({
            id: ThreadId.make("t:unsaved"),
            activity: "settled",
            runEnding: "completed",
            unsaved: true,
          }),
        ],
      }),
    );
    expect(plan.items.map((item) => [item.id, item.group, item.ticked, item.disposition])).toEqual([
      ["t:running", "running", true, "resume"],
      ["t:queued", "queued", true, "ready"],
      ["t:waiting", "waiting", true, "ready"],
      ["t:unsaved", "unsaved", true, "ready"],
    ]);
    expect(plan.items[0]?.evidence?.line).toBe("Different Claude account · 60% left");
    expect(plan.items[0]?.measure).toEqual({ bytes: 2048, files: 3, over: null });
  });

  it("has no coordinator item and no routine item", () => {
    const plan = buildHandoffPlan(
      facts({
        threads: [checked()],
        folderWork: [
          {
            projectId: P1,
            title: "App",
            uncommittedFiles: 179,
            branches: ["a", "b"],
            brokenFolder: null,
            measure: { bytes: 4096, files: 179, over: null },
          },
        ],
      }),
    );
    expect(new Set(plan.items.map((item) => item.kind))).toEqual(
      new Set(["thread", "folder-work"]),
    );
  });

  it("moves an idle or finished thread with unsaved work, and starts no turn there", () => {
    for (const fact of [
      checked({ activity: "settled", runEnding: "completed", unsaved: true }),
      checked({ activity: "waiting", runEnding: "user-stop", unsaved: true }),
      checked({ activity: "waiting", runEnding: "failed", unsaved: true }),
    ]) {
      const item = planThread(facts(), fact);
      expect(item).toMatchObject({ group: "unsaved", ticked: true, disposition: "ready" });
    }
  });

  it("never restarts a turn for a finished thread whose files are moved", () => {
    // Settled after a limit stop, picked for its unsaved files: the files move, nothing runs.
    expect(
      planThread(
        facts(),
        checked({ activity: "settled", runEnding: "usage-limit", unsaved: true }),
      ),
    ).toMatchObject({ group: "unsaved", ticked: true, disposition: "ready" });
    for (const runEnding of ["handoff", "sleep", "active"] as const) {
      expect(
        planThread(facts(), checked({ activity: "settled", runEnding, unsaved: true })),
      ).toMatchObject({ disposition: "ready" });
    }
    // A thread that stopped on the limit and still waits is the one being continued.
    expect(
      planThread(
        facts(),
        checked({ activity: "waiting", runEnding: "usage-limit", unsaved: true }),
      ),
    ).toMatchObject({ ticked: true, disposition: "resume" });
  });

  it("cannot be ticked before it was measured", () => {
    for (const plan of [facts(), automatic()]) {
      const item = planThread(
        plan,
        checked({
          activity: "waiting",
          runEnding: "usage-limit",
          usage: { usedPercent: 100, windowKey: laterReset, movedInWindow: false },
          measure: null,
        }),
      );
      expect(item).toMatchObject({
        group: "stays",
        disposition: "stays",
        stay: "unmeasured",
        ticked: false,
        canTick: false,
        reason: "Not measured yet.",
        measure: null,
      });
    }
    expect(
      folderWorkItem(facts(), {
        projectId: P1,
        title: "App",
        uncommittedFiles: 3,
        branches: ["a"],
        brokenFolder: null,
        measure: null,
      }),
    ).toMatchObject({
      group: "stays",
      disposition: "stays",
      stay: "unmeasured",
      ticked: false,
      canTick: false,
    });
  });

  it("names why a thread stays, and a Stays row cannot be ticked", () => {
    const stays = (fact: Partial<HandoffThreadFact>) => planThread(facts(), checked(fact));
    for (const pending of ["question", "approval", "sign-in"] as const) {
      expect(stays({ pending })).toMatchObject({
        group: "stays",
        disposition: "stays",
        ticked: false,
        canTick: false,
        stay: pending,
        reason: "Answer it first",
      });
    }
    expect(stays({ activity: "waiting", runEnding: "user-stop" })).toMatchObject({
      disposition: "stays",
      stay: "user-stop",
    });
    expect(stays({ activity: "settled", runEnding: "completed" })).toMatchObject({
      disposition: "stays",
      stay: "settled",
    });
    expect(
      stays({ reviewStay: "Review stays here: no permitted reviewer on Minis" }),
    ).toMatchObject({
      stay: "review",
      reason: "Review stays here: no permitted reviewer on Minis",
    });
    expect(stays({ brokenFolder: "/work/app-1" })).toMatchObject({
      stay: "broken-folder",
      reason: "Its folder's Git data is broken: /work/app-1",
    });
    expect(stays({ personal: true })).toMatchObject({ stay: "personal", disposition: "stays" });
    expect(stays({ worktreeSet: true })).toMatchObject({ stay: "worktree-set" });
  });

  it("keeps a thread the target cannot take, with the target's words", () => {
    const item = planThread(
      facts(),
      checked({
        check: {
          kind: "checked",
          failures: [{ check: "provider", message: "Minis: Claude not signed in" }],
          evidence: null,
        },
      }),
    );
    expect(item).toMatchObject({
      disposition: "stays",
      stay: "target",
      reason: "Minis: Claude not signed in",
    });
    expect(planThread(facts(), checked({ check: { kind: "skipped" } }))).toMatchObject({
      disposition: "stays",
      reason: "Not checked against Minis.",
    });
  });

  it("lists project folder work ticked, as files and branches only on the source", () => {
    const item = folderWorkItem(facts(), {
      projectId: P1,
      title: "App",
      uncommittedFiles: 179,
      branches: Array.from({ length: 11 }, (_, index) => `b${index}`),
      brokenFolder: null,
      measure: { bytes: 4096, files: 179, over: null },
    });
    expect(item).toMatchObject({
      kind: "folder-work",
      group: "folder-work",
      ticked: true,
      disposition: "ready",
      reason: "179 uncommitted files and 11 branches only on M4",
    });
    expect(
      folderWorkItem(facts(), {
        projectId: P1,
        title: "App",
        uncommittedFiles: 0,
        branches: [],
        brokenFolder: null,
        measure: null,
      }),
    ).toBeNull();
    // An automatic start moves threads only.
    expect(
      folderWorkItem(automatic(), {
        projectId: P1,
        title: "App",
        uncommittedFiles: 3,
        branches: [],
        brokenFolder: null,
        measure: null,
      }),
    ).toBeNull();
  });
});

describe("each thread's disposition in an automatic batch (AC-41)", () => {
  const limitStop = checked({
    activity: "waiting",
    runEnding: "usage-limit",
    lastTurnEndedAt: "2026-11-19T12:00:00.000Z",
    usage: { usedPercent: 100, windowKey: laterReset, movedInWindow: false },
  });
  const idle = (endedAt: string, overrides: Partial<HandoffThreadFact> = {}) =>
    checked({
      activity: "waiting",
      runEnding: "completed",
      lastTurnEndedAt: endedAt,
      usage: atThreshold,
      ...overrides,
    });

  it('a limit stop reads "Resumed on {machine}"', () => {
    const item = planThread(automatic(), limitStop);
    expect(item).toMatchObject({ disposition: "resume", ticked: true });
    expect(outcomeLine("resume", "Minis")).toBe("Resumed on Minis");
  });

  it('an idle thread at 99% within ten minutes reads "Ready on {machine}"', () => {
    const item = planThread(automatic(), idle("2026-11-19T13:51:00.000Z"));
    expect(item).toMatchObject({ disposition: "ready", ticked: true, group: "waiting" });
    expect(outcomeLine("ready", "Minis")).toBe("Ready on Minis");
  });

  it("one idle longer is not in the batch", () => {
    expect(planThread(automatic(), idle("2026-11-19T13:49:00.000Z"))).toBeNull();
    expect(
      planThread(automatic(), idle("2026-11-19T13:51:00.000Z", { lastTurnEndedAt: null })),
    ).toBeNull();
  });

  it("with the threshold turned off only the limit stop moves", () => {
    const off = automatic({ rule: { action: "switch", hasTargets: true, thresholdPercent: null } });
    const plan = buildHandoffPlan({
      ...off,
      threads: [limitStop, idle("2026-11-19T13:51:00.000Z", { id: ThreadId.make("t:idle") })],
    });
    expect(plan.items.map((item) => [item.id, item.disposition])).toEqual([[t1, "resume"]]);
  });

  it("moves an idle thread once per usage window", () => {
    expect(
      planThread(
        automatic(),
        idle("2026-11-19T13:51:00.000Z", { usage: { ...atThreshold, movedInWindow: true } }),
      ),
    ).toBeNull();
  });

  it("never takes a healthy sibling because its track matches", () => {
    expect(
      planThread(
        automatic(),
        checked({ activity: "running", runEnding: "active", usage: atThreshold }),
      ),
    ).toBeNull();
    expect(
      planThread(
        automatic(),
        idle("2026-11-19T13:51:00.000Z", { usage: { ...atThreshold, usedPercent: 60 } }),
      ),
    ).toBeNull();
    expect(
      planThread(automatic(), checked({ activity: "settled", runEnding: "completed" })),
    ).toBeNull();
  });

  it("never moves a thread whose track is not known, by hand or automatically", () => {
    const reason = "Its model is on more than one track, and nothing says which one it runs on.";
    expect(planThread(automatic(), { ...limitStop, trackAmbiguous: true })).toMatchObject({
      disposition: "stays",
      stay: "track",
      ticked: false,
      canTick: false,
      reason,
    });
    // By hand too: a person may accept an account that adds nothing, never a track
    // nobody can name. The target answered for the model alone, which proves no track.
    for (const fact of [
      checked({ trackAmbiguous: true }),
      checked({ trackAmbiguous: true, activity: "waiting", runEnding: "completed" }),
      checked({ trackAmbiguous: true, activity: "settled", runEnding: "completed", unsaved: true }),
    ]) {
      expect(planThread(facts(), fact)).toMatchObject({
        group: "stays",
        disposition: "stays",
        stay: "track",
        ticked: false,
        canTick: false,
        reason,
      });
    }
    // A thread with no track at all still moves on the model it names.
    expect(planThread(facts(), checked({ trackAmbiguous: false }))).toMatchObject({
      disposition: "resume",
      ticked: true,
    });
  });

  it("needs switch with targets", () => {
    for (const rule of [
      null,
      { action: "ask", hasTargets: true, thresholdPercent: 99 },
      { action: "wait", hasTargets: true, thresholdPercent: 99 },
      { action: "switch", hasTargets: false, thresholdPercent: 99 },
    ]) {
      expect(planThread(automatic({ rule }), limitStop)).toBeNull();
    }
  });

  it("keeps a picked thread here when its target evidence does not qualify", () => {
    const evidence = {
      modelSelection: fable,
      providerName: "Claude",
      kind: "same-account" as const,
      line: "Same Claude account as M4: adds no usage",
      percentLeft: null,
      automatic: false,
      accountFingerprint: poolA,
      usedPercent: 100,
      resetsAt: laterReset,
      observedAt: fresh,
    };
    const item = planThread(automatic(), {
      ...limitStop,
      check: { kind: "checked", failures: [], evidence },
    });
    expect(item).toMatchObject({
      disposition: "stays",
      stay: "target",
      reason: "Minis: Same Claude account as M4: adds no usage",
    });
    // The same answer by hand is allowed, with that line on the row.
    expect(
      planThread(facts(), { ...checked(), check: { kind: "checked", failures: [], evidence } }),
    ).toMatchObject({ disposition: "resume", evidence: { line: evidence.line } });
    // A pending question stays in either start.
    expect(planThread(automatic(), { ...limitStop, pending: "question" })).toMatchObject({
      disposition: "stays",
      reason: "Answer it first",
    });
  });
});

describe("limits measured on what will travel (AC-34)", () => {
  const over = (measure: HandoffMeasure) => planThread(facts(), checked({ measure }));

  it("keeps an item over a limit under Stays, with the file or the count", () => {
    expect(
      over({
        bytes: 0,
        files: 4,
        over: { limit: "file", path: "data/dump.bin", bytes: 12 * 1024 * 1024 },
      }),
    ).toMatchObject({
      disposition: "stays",
      stay: "limit",
      reason: "data/dump.bin is 12 MB, over the 10 MB limit for one file",
    });
    expect(
      over({ bytes: 0, files: 20_001, over: { limit: "files", count: 20_001 } }),
    ).toMatchObject({ stay: "limit", reason: "20,001 files, over the 20,000 file limit" });
    expect(
      over({
        bytes: 70 * 1024 * 1024,
        files: 9,
        over: { limit: "bundle", bytes: 70 * 1024 * 1024 },
      }),
    ).toMatchObject({ stay: "limit", reason: "70 MB to send, over the 64 MB limit" });
  });

  it("says so when an item grew past a limit between the check and the run", () => {
    const before: HandoffMeasure = { bytes: 1024, files: 2, over: null };
    expect(grewPastLimit(before, { bytes: 2048, files: 3, over: null })).toBeNull();
    expect(
      grewPastLimit(before, {
        bytes: 1024,
        files: 3,
        over: { limit: "file", path: "big.bin", bytes: 11 * 1024 * 1024 },
      }),
    ).toBe(
      "It grew past a limit after the check: big.bin is 11 MB, over the 10 MB limit for one file",
    );
  });

  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const repository = () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-plan-")),
    );
    temporary.push(root);
    git(root, "init", "-q", "-b", "main");
    NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base");
    return root;
  };

  const checkRefs = (root: string) => git(root, "for-each-ref", "refs/specwithcode/check/");

  it("measures the bundle that would travel, on a scratch ref it deletes", async () => {
    const root = repository();
    NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 2;\n");
    NodeFS.writeFileSync(NodePath.join(root, "new.ts"), "export const b = 1;\n");
    let asked: ReadonlyArray<string> = [];
    const measure = await measureTravel({
      cwd: root,
      threadId: t1,
      operationId: "op-1",
      known: async (candidates) => {
        asked = candidates;
        // While the target is asked, the checkpoint sits on this operation's own ref.
        expect(checkRefs(root)).toContain(checkRef("op-1", t1));
        return candidates;
      },
    });
    expect(asked).toContain(git(root, "rev-parse", "HEAD"));
    expect(measure.over).toBeNull();
    expect(measure.files).toBe(2);
    expect(measure.bytes).toBeGreaterThan(0);
    // Nothing is left behind, and the thread's own hand off ref was never written.
    expect(checkRefs(root)).toBe("");
    expect(git(root, "for-each-ref", handoffRef(t1))).toBe("");
    expect(git(root, "status", "--porcelain")).toContain("new.ts");

    // A target that holds none of the history gets the whole branch, which is larger.
    const whole = await measureTravel({
      cwd: root,
      threadId: t1,
      operationId: "op-2",
      known: async () => [],
    });
    expect(whole.bytes).toBeGreaterThan(measure.bytes);
  });

  it("names the file or the count that exceeded a limit", async () => {
    const root = repository();
    NodeFS.writeFileSync(NodePath.join(root, "big.bin"), Buffer.alloc(4096, 7));
    NodeFS.writeFileSync(NodePath.join(root, "small.ts"), "export {};\n");
    const file = await measureTravel({
      cwd: root,
      threadId: t1,
      operationId: "op-3",
      known: async (candidates) => candidates,
      limits: { maxFileBytes: 1024, maxFiles: 20_000, maxBundleBytes: 64 * 1024 * 1024 },
    });
    expect(file.over).toEqual({ limit: "file", path: "big.bin", bytes: 4096 });

    const count = await measureTravel({
      cwd: root,
      threadId: t1,
      operationId: "op-4",
      known: async (candidates) => candidates,
      limits: { maxFileBytes: 10 * 1024 * 1024, maxFiles: 1, maxBundleBytes: 64 * 1024 * 1024 },
    });
    expect(count.over).toEqual({ limit: "files", count: 2 });

    const bundle = await measureTravel({
      cwd: root,
      threadId: t1,
      operationId: "op-5",
      known: async (candidates) => candidates,
      limits: { maxFileBytes: 10 * 1024 * 1024, maxFiles: 20_000, maxBundleBytes: 16 },
    });
    expect(bundle.over).toMatchObject({ limit: "bundle" });
    expect(checkRefs(root)).toBe("");
  });

  it("never deletes a scratch ref another measure of the same operation holds", async () => {
    const root = repository();
    NodeFS.writeFileSync(NodePath.join(root, "new.ts"), "export const b = 1;\n");
    const held = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", checkRef("op-7", t1), held);
    await expect(
      measureTravel({
        cwd: root,
        threadId: t1,
        operationId: "op-7",
        known: async (candidates) => candidates,
      }),
    ).rejects.toThrow();
    expect(git(root, "rev-parse", checkRef("op-7", t1))).toBe(held);
  });

  it("names a committed file over the limit with its real size", async () => {
    const root = repository();
    const base = git(root, "rev-parse", "HEAD");
    NodeFS.writeFileSync(NodePath.join(root, "big.bin"), Buffer.alloc(4096, 7));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "a large file nobody pushed");
    git(root, "rm", "-q", "big.bin");
    git(root, "commit", "-q", "-m", "and its removal");
    const measure = await measureTravel({
      cwd: root,
      threadId: t1,
      operationId: "op-8",
      // The target holds the base only, so both commits travel.
      known: async () => [base],
      limits: { maxFileBytes: 1024, maxFiles: 20_000, maxBundleBytes: 64 * 1024 * 1024 },
    });
    expect(measure.over).toEqual({ limit: "file", path: "big.bin", bytes: 4096 });
  });

  it("deletes its scratch ref when the target cannot be asked", async () => {
    const root = repository();
    NodeFS.writeFileSync(NodePath.join(root, "new.ts"), "export const b = 1;\n");
    await expect(
      measureTravel({
        cwd: root,
        threadId: t1,
        operationId: "op-6",
        known: async () => {
          throw new Error("Minis did not answer.");
        },
      }),
    ).rejects.toThrow("Minis did not answer.");
    expect(checkRefs(root)).toBe("");
    expect(git(root, "for-each-ref", handoffRef(t1))).toBe("");
  });
});

const request = (overrides: Partial<PeerCheckRequest> = {}): PeerCheckRequest => ({
  sourceEnvironmentId: M4,
  sourceLabel: "M4",
  protocolVersion: HANDOFF_PROTOCOL_VERSION,
  appVersion: "1.0.390",
  capabilities: [HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY],
  start: "manual",
  thresholdPercent: 99,
  threads: [
    {
      sourceThreadId: t1,
      sourceProjectId: P1,
      modelSelection: opus,
      track: null,
      driverKind: "claudeAgent",
      accountFingerprints: [poolA],
    },
  ],
  ...overrides,
});

/** The answer encodes, travels as JSON and decodes again on the asking machine. */
const surviveTheWire = (answer: PeerCheckResponse) =>
  Option.isSome(
    Schema.decodeUnknownOption(PeerCheckResponse)(
      overTheWire(Schema.encodeSync(PeerCheckResponse)(answer)),
    ),
  );

const caller = (machine: RigMachine) => ({
  sourceEnvironmentId: machine.environmentId,
  grant: unscopedGrant(machine.environmentId),
});

describe("the plan's own capability (EC2-04)", () => {
  it("is advertised beside the transfer record, and is not the transfer record", () => {
    expect(HANDOFF_PLAN_CAPABILITY).not.toBe(HANDOFF_V2_CAPABILITY);
    // Later wire features add their own names after these two.
    expect(HANDOFF_CAPABILITIES.slice(0, 2)).toEqual([
      HANDOFF_V2_CAPABILITY,
      HANDOFF_PLAN_CAPABILITY,
    ]);
    expect(PEER_PATHS.has("check")).toBe(true);
  });

  it('reads "Needs update" for a machine that does not name it', () => {
    expect(
      planCapabilityFailure({
        peerLabel: "Minis",
        capabilities: [HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY],
      }),
    ).toBeNull();
    for (const capabilities of [undefined, [], [HANDOFF_V2_CAPABILITY]]) {
      const failure = planCapabilityFailure({ peerLabel: "Minis", capabilities });
      expect(failure?.check).toBe("version");
      expect(failure?.message.startsWith("Needs update: Minis ")).toBe(true);
    }
  });

  it.effect("answers a check for a thread it holds no copy of, with its own evidence", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      const answer = yield* b.receiver.check(
        caller(a),
        request({
          sourceEnvironmentId: a.environmentId,
          threads: [{ ...request().threads[0]!, sourceProjectId: a.projectId }],
        }),
      );
      expect(answer.capabilities).toEqual([...HANDOFF_CAPABILITIES]);
      expect(answer.results).toHaveLength(1);
      expect(answer.results[0]?.failures).toEqual([]);
      expect(answer.results[0]?.evidence?.modelSelection).toEqual(opus);
      // By hand a reading nobody has is allowed, with its line.
      expect(answer.results[0]?.evidence?.line).toBe("Usage unknown");
      expect(surviveTheWire(answer)).toBe(true);

      // The same call for an automatic start does not qualify on that reading.
      const strict = yield* b.receiver.check(
        caller(a),
        request({
          sourceEnvironmentId: a.environmentId,
          start: "automatic",
          threads: [{ ...request().threads[0]!, sourceProjectId: a.projectId }],
        }),
      );
      expect(strict.results[0]?.failures.map((failure) => failure.message)).toEqual([
        `${b.label}: Usage unknown`,
      ]);
      // A thread on a track is not confirmed on the model it names: this copy of the
      // project runs one fixed model, so it has no Daily track to offer.
      const tracked = yield* b.receiver.check(
        caller(a),
        request({
          sourceEnvironmentId: a.environmentId,
          threads: [{ ...request().threads[0]!, sourceProjectId: a.projectId, track: "daily" }],
        }),
      );
      expect(tracked.results[0]?.failures).toEqual([
        { check: "model", message: `${b.label}: App does not use the Daily track here` },
      ]);
      expect(tracked.results[0]?.evidence).toBeNull();
      // The existing preflight still asks for the copy, as before.
      const preflight = yield* b.receiver.preflight(caller(a), {
        sourceEnvironmentId: a.environmentId,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "1.0.390",
        capabilities: [...HANDOFF_CAPABILITIES],
        threads: [
          { sourceThreadId: t1, sourceProjectId: a.projectId, sequence: 1, modelSelection: opus },
        ],
      });
      expect(preflight.results[0]?.failures.map((failure) => failure.check)).toEqual([
        "checkpoint",
      ]);
    }),
  );
});

describe(`the plan with a machine on ${PREVIOUS_RELEASE}, and with one that only keeps transfer records (EC2-09)`, () => {
  it("adds one path and no field to the bodies the release reads", () => {
    expect(PREVIOUS_PEER_PATHS.has("check")).toBe(false);
    for (const path of PREVIOUS_PEER_PATHS) expect(PEER_PATHS.has(path)).toBe(true);
    // This build's preflight, with the plan's capability in its list, still decodes there.
    const preflight = Schema.encodeSync(PeerPreflightRequest)({
      sourceEnvironmentId: M4,
      protocolVersion: HANDOFF_PROTOCOL_VERSION,
      appVersion: "1.0.390",
      capabilities: [...HANDOFF_CAPABILITIES],
      threads: [{ sourceThreadId: t1, sourceProjectId: P1, sequence: 1, modelSelection: opus }],
    });
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(PreviousPeerPreflightRequest)(overTheWire(preflight)),
      ),
    ).toBe(true);
  });

  it(`as the source: ${PREVIOUS_RELEASE} never plans, and its preflight is read as before`, () => {
    // What the release sends decodes here unchanged; it names no capability at all.
    const sent = overTheWire(
      encodePreviousPreflightRequest({
        sourceEnvironmentId: M4,
        protocolVersion: 2,
        appVersion: "1.0.383",
        threads: [{ sourceThreadId: t1, sourceProjectId: P1, sequence: 1, modelSelection: opus }],
      }),
    );
    const read = Schema.decodeUnknownOption(PeerPreflightRequest)(sent);
    expect(Option.isSome(read)).toBe(true);
    expect(Option.getOrThrow(read).capabilities).toBeUndefined();
    // Its preflight body is not a check: nothing of it is taken for a plan.
    expect(Option.isNone(Schema.decodeUnknownOption(PeerCheckRequest)(sent))).toBe(true);
  });

  it(`as the target: ${PREVIOUS_RELEASE} has no check path, which reads "Needs update" and Stays`, () => {
    const error = unknownCheckPath("OLD");
    expect(error).toMatchObject({ check: "version", uncertain: false, needsUpdate: true });
    const check = checkAnswer({
      peerLabel: "OLD",
      threadId: t1,
      answer: { kind: "failed", error },
    });
    expect(check.kind).toBe("needs-update");
    const item = planThread(
      facts({ target: { environmentId: MINI, label: "OLD" } }),
      checked({ check }),
    );
    expect(item).toMatchObject({ disposition: "stays", stay: "needs-update", ticked: false });
    expect(item?.reason?.startsWith("Needs update: OLD ")).toBe(true);
    // The same in an automatic start: it stays, it is never sent on a guess.
    expect(
      planThread(automatic(), checked({ activity: "waiting", runEnding: "usage-limit", check })),
    ).toMatchObject({
      disposition: "stays",
      stay: "needs-update",
    });
  });

  it("as the target: a machine with transfer records and no plan Stays, whatever it answered", () => {
    const answer: PeerCheckResponse = {
      machineLabel: "Minis",
      protocolVersion: HANDOFF_PROTOCOL_VERSION,
      appVersion: "1.0.384",
      capabilities: [HANDOFF_V2_CAPABILITY],
      results: [{ sourceThreadId: t1, failures: [], evidence: null }],
    };
    const check = checkAnswer({
      peerLabel: "Minis",
      threadId: t1,
      answer: { kind: "answered", response: answer },
    });
    expect(check).toMatchObject({ kind: "needs-update" });
    expect(planThread(facts(), checked({ check }))).toMatchObject({
      disposition: "stays",
      stay: "needs-update",
    });
    // With the capability the same answer is a checked row.
    expect(
      checkAnswer({
        peerLabel: "Minis",
        threadId: t1,
        answer: {
          kind: "answered",
          response: { ...answer, capabilities: [HANDOFF_V2_CAPABILITY, HANDOFF_PLAN_CAPABILITY] },
        },
      }),
    ).toEqual({ kind: "checked", failures: [], evidence: null });
  });

  it.effect("as the source: a machine with transfer records and no plan is told to update", () =>
    Effect.gen(function* () {
      const rig = yield* makeRig(temporary);
      const [a, b] = rig.machines as [RigMachine, RigMachine];
      const thread = { ...request().threads[0]!, sourceProjectId: a.projectId };
      for (const capabilities of [[HANDOFF_V2_CAPABILITY], undefined]) {
        const answer = yield* b.receiver.check(
          caller(a),
          request({ sourceEnvironmentId: a.environmentId, capabilities, threads: [thread] }),
        );
        const failures = answer.results[0]?.failures ?? [];
        expect(failures.map((failure) => failure.check)).toContain("version");
        expect(failures.some((failure) => failure.message.startsWith("Needs update: "))).toBe(true);
        expect(answer.results[0]?.evidence).toBeNull();
      }
      // Its transfer-record preflight is answered exactly as before the plan existed.
      const preflight = yield* b.receiver.preflight(caller(a), {
        sourceEnvironmentId: a.environmentId,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: "1.0.384",
        capabilities: [HANDOFF_V2_CAPABILITY],
        threads: [
          { sourceThreadId: t1, sourceProjectId: a.projectId, sequence: 1, modelSelection: opus },
        ],
      });
      expect(preflight.results[0]?.failures.map((failure) => failure.check)).toEqual([
        "checkpoint",
      ]);
      expect(preflight.capabilities).toContain(HANDOFF_V2_CAPABILITY);
    }),
  );
});

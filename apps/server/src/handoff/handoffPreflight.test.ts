import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HandoffRunEnding,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";

import { EMPTY_HANDOFF_DOCUMENT, emptyThreadRecord, type HandoffDocument } from "./handoffState.ts";
import {
  HANDOFF_CONTINUE_TEXT,
  HANDOFF_SEED_MAX_CHARS,
  checkFailures,
  handoffSeed,
  type PreflightFacts,
  preflightFailures,
  shouldResume,
} from "./handoffPreflight.ts";
import { turnRefusal } from "./HandoffTurnGate.ts";

const claude: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const ready: PreflightFacts = {
  machineLabel: "Tower H",
  project: { title: "SpecWeave", inGrant: true },
  checkpointSequence: 4,
  requiredSequence: 4,
  missingFiles: [],
  modelSelection: claude,
  provider: {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    authStatus: "authenticated",
    models: [{ slug: "claude-opus-5-5" }],
  },
  otherHolder: null,
};

const messages = (facts: Partial<PreflightFacts>) =>
  preflightFailures({ ...ready, ...facts }).map((failure) => failure.message);

describe("preflightFailures", () => {
  it("passes a thread the destination can run", () => {
    expect(preflightFailures(ready)).toEqual([]);
  });

  it("names the machine and the exact missing piece", () => {
    expect(messages({ missingFiles: [".env.local"] })).toEqual([
      "Tower H: no .env.local. Send it with studio_file_transfer, or tick it in Sync",
    ]);
    expect(messages({ provider: { ...ready.provider!, authStatus: "unauthenticated" } })).toEqual([
      "Tower H: Claude not signed in",
    ]);
    expect(messages({ provider: { ...ready.provider!, installed: false } })).toEqual([
      "Tower H: Claude not installed",
    ]);
    expect(messages({ provider: null })).toEqual(["Tower H: claudeAgent is not set up"]);
    expect(
      messages({ provider: { ...ready.provider!, models: [{ slug: "claude-haiku" }] } }),
    ).toEqual(["Tower H: model claude-opus-5-5 not available on Claude"]);
  });

  it("refuses a project that is only named the same", () => {
    const [notLinked] = messages({ project: null });
    expect(notLinked).toMatch(/^Tower H: this project is not linked here\. /u);
    // It names both remedies: Link… and adding the project to that machine.
    expect(notLinked).toContain("Link…");
    expect(notLinked).toContain("studio_project_add_to_machine");
    expect(messages({ project: { title: "SpecWeave", inGrant: false } })).toEqual([
      "Tower H: no work grant for SpecWeave",
    ]);
  });

  it("requires the newest checkpoint and a free lease", () => {
    expect(messages({ checkpointSequence: null })).toEqual([
      "Tower H: no checkpoint for this thread",
    ]);
    expect(messages({ checkpointSequence: 3 })).toEqual(["Tower H: no checkpoint for this thread"]);
    expect(messages({ otherHolder: "Kiosk D" })).toEqual([
      "Tower H: another machine (Kiosk D) runs this thread",
    ]);
  });

  it("lists every failure, not only the first", () => {
    expect(
      messages({
        missingFiles: [".env.local", ".env"],
        provider: { ...ready.provider!, authStatus: "unauthenticated" },
      }),
    ).toEqual([
      "Tower H: no .env.local. Send it with studio_file_transfer, or tick it in Sync",
      "Tower H: no .env. Send it with studio_file_transfer, or tick it in Sync",
      "Tower H: Claude not signed in",
    ]);
  });
});

describe("shouldResume", () => {
  it("resumes only running runs and runs a handoff, sleep or usage limit interrupted", () => {
    const resumed: Array<HandoffRunEnding> = ["active", "handoff", "sleep", "usage-limit"];
    const final: Array<HandoffRunEnding> = [
      "user-stop",
      "completed",
      "cancelled",
      "failed",
      "service-update",
      "none",
    ];
    for (const ending of resumed) expect(shouldResume(ending), ending).toBe(true);
    for (const ending of final) expect(shouldResume(ending), ending).toBe(false);
  });
});

describe("handoffSeed", () => {
  const checkpoint = {
    note: {
      done: "Wrote the receiver.",
      next: "Wire the route.",
      openQuestions: "",
      createdAt: "2026-10-20T14:00:00.000Z",
    },
    branch: "feat/handoff",
    commit: "a".repeat(40),
    sideEffects: [
      {
        turnKey: "thread-1/run-1",
        kind: "pr-create" as const,
        target: "branch:feat/handoff",
        epoch: 1,
        environmentId: EnvironmentId.make("env-laptopE"),
        at: "2026-10-20T14:00:00.000Z",
        result: "github.com/o/r#7",
      },
    ],
    runEnding: "usage-limit" as const,
    skipped: [],
  };

  it("starts a fresh session from the checkpoint and lists side effects not to repeat", () => {
    const seed = handoffSeed({
      sourceLabel: "Laptop E",
      reason: "handoff",
      checkpoint,
      lastMessages: [{ role: "user", text: "Finish the PR." }],
    });
    expect(seed.startsWith(HANDOFF_CONTINUE_TEXT)).toBe(true);
    expect(seed).toContain("handed off from Laptop E after its usage limit was reached");
    expect(seed).toContain("branch feat/handoff");
    expect(seed).toContain("Do not repeat these");
    expect(seed).toContain("pr-create branch:feat/handoff (github.com/o/r#7)");
    expect(seed).toContain("User: Finish the PR.");
  });

  it("stays under its size cap however long the transcript is", () => {
    const seed = handoffSeed({
      sourceLabel: "Laptop E",
      reason: "sleep",
      checkpoint,
      lastMessages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: "x".repeat(1500),
      })),
    });
    expect(seed.length).toBeLessThanOrEqual(HANDOFF_SEED_MAX_CHARS);
  });
});

describe("turnRefusal", () => {
  const laptopE = EnvironmentId.make("env-laptopE");
  const towerH = EnvironmentId.make("env-towerH");
  const threadId = ThreadId.make("thread-1");
  const projectId = ProjectId.make("project-1");
  const withRecord = (
    record: Partial<HandoffDocument["threads"][string]>,
    document: Partial<HandoffDocument> = {},
  ): HandoffDocument => ({
    ...EMPTY_HANDOFF_DOCUMENT,
    ...document,
    threads: { [threadId]: { ...emptyThreadRecord(projectId), mode: "on", ...record } },
  });
  const lease = (holder: EnvironmentId, state: "active" | "handing-off" | "fenced") => ({
    holderEnvironmentId: holder,
    holderLabel: holder === laptopE ? "Laptop E" : "Tower H",
    holderThreadId: threadId,
    epoch: 2,
    renewedAt: "2026-10-20T14:00:00.000Z",
    state,
  });

  it("allows a thread handoff mode does not track", () => {
    expect(turnRefusal(EMPTY_HANDOFF_DOCUMENT, threadId, laptopE)).toBeNull();
  });

  it("allows the lease holder", () => {
    expect(
      turnRefusal(withRecord({ lease: lease(laptopE, "active") }), threadId, laptopE),
    ).toBeNull();
  });

  it("refuses a fenced copy, another holder and a handoff in flight", () => {
    expect(
      turnRefusal(
        withRecord({
          continuedOn: {
            environmentId: towerH,
            machineLabel: "Tower H",
            threadId: ThreadId.make("thread-9"),
            at: "2026-10-20T14:00:00.000Z",
          },
        }),
        threadId,
        laptopE,
      ),
    ).toContain("continues on Tower H");
    expect(
      turnRefusal(withRecord({ lease: lease(towerH, "active") }), threadId, laptopE),
    ).toContain("Another machine (Tower H)");
    expect(
      turnRefusal(withRecord({ lease: lease(laptopE, "fenced") }), threadId, laptopE),
    ).toContain("read-only");
    expect(
      turnRefusal(withRecord({ lease: lease(laptopE, "handing-off") }), threadId, laptopE),
    ).toContain("being handed off");
  });

  it("pauses a machine that lost its network with replicated leases until it is back", () => {
    const document = withRecord(
      {
        lease: lease(laptopE, "active"),
        replicas: [
          {
            environmentId: towerH,
            machineLabel: "Tower H",
            state: "current",
            sequence: 2,
            detail: null,
            updatedAt: "2026-10-20T14:00:00.000Z",
          },
        ],
      },
      { pausedSince: "2026-10-20T14:05:00.000Z" },
    );
    const refusal = turnRefusal(document, threadId, laptopE);
    expect(refusal).toContain("lost its network");
    expect(refusal).toContain("Resume this machine");
    expect(refusal).not.toContain("woke");
    // Without a pause the same thread starts turns.
    expect(turnRefusal({ ...document, pausedSince: null }, threadId, laptopE)).toBeNull();
  });
});

describe("checkFailures: the check before anything is copied (1390)", () => {
  const {
    checkpointSequence: _sequence,
    requiredSequence: _required,
    missingFiles: _files,
    ...base
  } = ready;

  it("passes a thread the destination holds no copy of", () => {
    expect(checkFailures(base)).toEqual([]);
    // The preflight of the Hold step still needs the copy.
    expect(messages({ checkpointSequence: null })).toEqual([
      "Tower H: no checkpoint for this thread",
    ]);
  });

  it("names the link, the grant, the provider, the model and the lease", () => {
    const checks = (facts: Partial<typeof base>) =>
      checkFailures({ ...base, ...facts }).map((failure) => failure.check);
    expect(checks({ project: null })).toEqual(["project-link"]);
    expect(checks({ project: { title: "SpecWeave", inGrant: false } })).toEqual(["grant"]);
    expect(checks({ provider: null })).toEqual(["provider"]);
    expect(checks({ provider: { ...base.provider!, authStatus: "unauthenticated" } })).toEqual([
      "provider",
    ]);
    expect(checks({ modelSelection: { ...claude, model: "claude-fable-5-2" } })).toEqual(["model"]);
    expect(checks({ otherHolder: "M3" })).toEqual(["lease"]);
    expect(
      checkFailures({ ...base, project: null, provider: null, otherHolder: "M3" }).map(
        (failure) => failure.message,
      ),
    ).toEqual([
      expect.stringContaining("Tower H: this project is not linked here"),
      "Tower H: claudeAgent is not set up",
      "Tower H: another machine (M3) runs this thread",
    ]);
  });
});

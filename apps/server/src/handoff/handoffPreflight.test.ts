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
  machineLabel: "Minis",
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
    expect(messages({ missingFiles: [".env.local"] })).toEqual(["Minis: no .env.local"]);
    expect(messages({ provider: { ...ready.provider!, authStatus: "unauthenticated" } })).toEqual([
      "Minis: Claude not signed in",
    ]);
    expect(messages({ provider: { ...ready.provider!, installed: false } })).toEqual([
      "Minis: Claude not installed",
    ]);
    expect(messages({ provider: null })).toEqual(["Minis: claudeAgent is not set up"]);
    expect(
      messages({ provider: { ...ready.provider!, models: [{ slug: "claude-haiku" }] } }),
    ).toEqual(["Minis: model claude-opus-5-5 not available on Claude"]);
  });

  it("refuses a project that is only named the same", () => {
    expect(messages({ project: null })).toEqual(["Minis: this project is not linked here"]);
    expect(messages({ project: { title: "SpecWeave", inGrant: false } })).toEqual([
      "Minis: no work grant for SpecWeave",
    ]);
  });

  it("requires the newest checkpoint and a free lease", () => {
    expect(messages({ checkpointSequence: null })).toEqual([
      "Minis: no checkpoint for this thread",
    ]);
    expect(messages({ checkpointSequence: 3 })).toEqual(["Minis: no checkpoint for this thread"]);
    expect(messages({ otherHolder: "M3" })).toEqual([
      "Minis: another machine (M3) runs this thread",
    ]);
  });

  it("lists every failure, not only the first", () => {
    expect(
      messages({
        missingFiles: [".env.local", ".env"],
        provider: { ...ready.provider!, authStatus: "unauthenticated" },
      }),
    ).toEqual(["Minis: no .env.local", "Minis: no .env", "Minis: Claude not signed in"]);
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
        environmentId: EnvironmentId.make("env-m4"),
        at: "2026-10-20T14:00:00.000Z",
        result: "github.com/o/r#7",
      },
    ],
    runEnding: "usage-limit" as const,
    skipped: [],
  };

  it("starts a fresh session from the checkpoint and lists side effects not to repeat", () => {
    const seed = handoffSeed({
      sourceLabel: "M4",
      reason: "handoff",
      checkpoint,
      lastMessages: [{ role: "user", text: "Finish the PR." }],
    });
    expect(seed.startsWith(HANDOFF_CONTINUE_TEXT)).toBe(true);
    expect(seed).toContain("handed off from M4 after its usage limit was reached");
    expect(seed).toContain("branch feat/handoff");
    expect(seed).toContain("Do not repeat these");
    expect(seed).toContain("pr-create branch:feat/handoff (github.com/o/r#7)");
    expect(seed).toContain("User: Finish the PR.");
  });

  it("stays under its size cap however long the transcript is", () => {
    const seed = handoffSeed({
      sourceLabel: "M4",
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
  const m4 = EnvironmentId.make("env-m4");
  const minis = EnvironmentId.make("env-minis");
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
    holderLabel: holder === m4 ? "M4" : "Minis",
    holderThreadId: threadId,
    epoch: 2,
    renewedAt: "2026-10-20T14:00:00.000Z",
    state,
  });

  it("allows a thread handoff mode does not track", () => {
    expect(turnRefusal(EMPTY_HANDOFF_DOCUMENT, threadId, m4)).toBeNull();
  });

  it("allows the lease holder", () => {
    expect(turnRefusal(withRecord({ lease: lease(m4, "active") }), threadId, m4)).toBeNull();
  });

  it("refuses a fenced copy, another holder and a handoff in flight", () => {
    expect(
      turnRefusal(
        withRecord({
          continuedOn: {
            environmentId: minis,
            machineLabel: "Minis",
            threadId: ThreadId.make("thread-9"),
            at: "2026-10-20T14:00:00.000Z",
          },
        }),
        threadId,
        m4,
      ),
    ).toContain("continues on Minis");
    expect(turnRefusal(withRecord({ lease: lease(minis, "active") }), threadId, m4)).toContain(
      "Another machine (Minis)",
    );
    expect(turnRefusal(withRecord({ lease: lease(m4, "fenced") }), threadId, m4)).toContain(
      "read-only",
    );
    expect(turnRefusal(withRecord({ lease: lease(m4, "handing-off") }), threadId, m4)).toContain(
      "being handed off",
    );
  });

  it("pauses a machine that woke with replicated leases until a peer answers", () => {
    const document = withRecord(
      {
        lease: lease(m4, "active"),
        replicas: [
          {
            environmentId: minis,
            machineLabel: "Minis",
            state: "current",
            sequence: 2,
            detail: null,
            updatedAt: "2026-10-20T14:00:00.000Z",
          },
        ],
      },
      { pausedSince: "2026-10-20T14:05:00.000Z" },
    );
    expect(turnRefusal(document, threadId, m4)).toContain("Resume this Mac");
  });
});

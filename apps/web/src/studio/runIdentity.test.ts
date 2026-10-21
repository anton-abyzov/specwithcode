import { describe, expect, it } from "vite-plus/test";
import {
  limitFallbackPairing,
  limitContinuationKind,
  limitContinuationNote,
  restartContinuationNote,
} from "./runIdentity";
import { modelLabel } from "./shellModel";

const describeRun = (selection: { instanceId: string; model: string }) =>
  modelLabel(null, selection.instanceId, selection.model);
const runs = [
  { id: "run-1", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
  { id: "run-2", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } },
];

describe("usage-limit continuations", () => {
  it("knows the rule's messages by id and nothing else", () => {
    expect(limitContinuationKind("limit-fallback:project-coordinator:p:run-1")).toBe("fallback");
    expect(limitContinuationKind("limit-api:t:run-1")).toBe("api");
    expect(limitContinuationKind("limit-fallback:t:hop-1:run-1")).toBe("fallback");
    expect(limitContinuationKind("provider-fallback:t:run-1")).toBe("provider-fallback");
    expect(limitContinuationKind("limit-return:t:run-2")).toBe("return");
    expect(limitContinuationKind("message-1")).toBeNull();
  });
  it("names the provider that stopped and the one that took over", () => {
    expect(
      limitContinuationNote(
        { id: "limit-fallback:project-coordinator:p:run-1", runId: "run-2" },
        runs,
        describeRun,
      ),
    ).toBe("Claude Code limit reached · continued on Codex · GPT-6.1 Sol");
  });
  it("still reads when the new run has not started", () => {
    expect(limitContinuationNote({ id: "limit-fallback:t:run-1" }, runs, describeRun)).toBe(
      "Claude Code limit reached · continuing on another provider",
    );
    expect(limitContinuationNote({ id: "limit-reset:t:gone" }, [], describeRun)).toBe(
      "Usage limit reset · continued",
    );
  });
  describe("with run ids that hold colons", () => {
    const colonRuns = [
      {
        id: "run:t:ordinal:1",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      },
      {
        id: "run:t:ordinal:2",
        modelSelection: { instanceId: "acpRegistry_copilot", model: "claude-opus-5-5" },
      },
      { id: "run:t:ordinal:3", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } },
    ];
    const copilotLabel = (selection: { instanceId: string; model: string }) =>
      selection.instanceId === "acpRegistry_copilot"
        ? { ...describeRun(selection), provider: "Copilot" }
        : describeRun(selection);

    it("names the stopped run behind a later hop", () => {
      expect(
        limitContinuationNote(
          { id: "limit-fallback:t:hop-1:run:t:ordinal:1", runId: "run:t:ordinal:3" },
          colonRuns,
          copilotLabel,
        ),
      ).toBe("Claude Code limit reached · continued on Codex · GPT-6.1 Sol");
    });

    it("says a provider could not start, never that it hit a limit", () => {
      expect(
        limitContinuationNote(
          { id: "provider-fallback:t:run:t:ordinal:2", runId: "run:t:ordinal:3" },
          colonRuns,
          copilotLabel,
        ),
      ).toBe("Copilot could not start · continued on Codex · GPT-6.1 Sol");
      expect(
        limitContinuationNote(
          { id: "provider-fallback:t:hop-1:run:t:ordinal:2" },
          colonRuns,
          copilotLabel,
        ),
      ).toBe("Copilot could not start · continuing on another provider");
    });
  });

  it("leaves the user's own messages alone", () => {
    expect(limitContinuationNote({ id: "m-1", runId: "run-2" }, runs, describeRun)).toBeNull();
  });
});

describe("restart continuations", () => {
  it("names an update and any other restart, and nothing else", () => {
    expect(restartContinuationNote({ id: "message:update-continuation:run-1" })).toBe(
      "Resumed after update",
    );
    expect(restartContinuationNote({ id: "message:restart-continuation:run-1" })).toBe(
      "Resumed after restart",
    );
    expect(restartContinuationNote({ id: "message:update-requeue:run-1" })).toBeNull();
    expect(restartContinuationNote({ id: "message-1" })).toBeNull();
  });
});

describe("limit fallback pairing", () => {
  const claude = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const astra = { instanceId: "codex", model: "gpt-6-astra" };
  const sol = { instanceId: "codex", model: "gpt-6.1-sol" };
  const runs = [
    { id: "r1", modelSelection: claude },
    { id: "r2", modelSelection: astra },
  ];
  const continued = [
    { id: "m1", runId: "r1" },
    { id: "limit-fallback:t1:r1", runId: "r2" },
  ];

  it("pairs a thread continued on a fallback with the model that stopped", () => {
    expect(limitFallbackPairing(continued, runs, astra)).toEqual({
      original: claude,
      stoppedRunId: "r1",
    });
    expect(limitFallbackPairing(continued, runs, sol)?.original).toEqual(claude);
  });

  it("drops the pairing once the thread is set back or a run returns", () => {
    expect(limitFallbackPairing(continued, runs, claude)).toBeNull();
    const back = [
      ...runs,
      { id: "r3", modelSelection: claude },
      { id: "r4", modelSelection: astra },
    ];
    expect(limitFallbackPairing(continued, back, astra)).toBeNull();
  });

  it("pairs through a later hop whose run ids hold colons", () => {
    const hopRuns = [
      { id: "run:t1:ordinal:1", modelSelection: claude },
      {
        id: "run:t1:ordinal:2",
        modelSelection: { instanceId: "acpRegistry_copilot", model: "opus" },
      },
      { id: "run:t1:ordinal:3", modelSelection: astra },
    ];
    const hopped = [
      { id: "m1", runId: "run:t1:ordinal:1" },
      { id: "limit-fallback:t1:run:t1:ordinal:1", runId: "run:t1:ordinal:2" },
      { id: "limit-fallback:t1:hop-1:run:t1:ordinal:1", runId: "run:t1:ordinal:3" },
    ];
    expect(limitFallbackPairing(hopped, hopRuns, astra)).toEqual({
      original: claude,
      stoppedRunId: "run:t1:ordinal:1",
    });
  });

  it("offers no way back from a provider that could not start", () => {
    const copilot = { instanceId: "acpRegistry_copilot", model: "opus" };
    const moved = [
      { id: "run:t1:ordinal:1", modelSelection: copilot },
      { id: "run:t1:ordinal:2", modelSelection: astra },
    ];
    expect(
      limitFallbackPairing(
        [
          { id: "m1", runId: "run:t1:ordinal:1" },
          { id: "provider-fallback:t1:run:t1:ordinal:1", runId: "run:t1:ordinal:2" },
        ],
        moved,
        astra,
      ),
    ).toBeNull();
    // A later move off a provider that could not start ends an earlier pairing.
    expect(
      limitFallbackPairing(
        [...continued, { id: "provider-fallback:t1:r3", runId: "r4" }],
        [...runs, { id: "r3", modelSelection: copilot }, { id: "r4", modelSelection: astra }],
        astra,
      ),
    ).toBeNull();
  });

  it("ignores threads with no fallback continuation", () => {
    expect(
      limitFallbackPairing([{ id: "limit-reset:t1:r1", runId: "r2" }], runs, astra),
    ).toBeNull();
    expect(limitFallbackPairing([{ id: "m1", runId: "r1" }], runs, astra)).toBeNull();
  });
});

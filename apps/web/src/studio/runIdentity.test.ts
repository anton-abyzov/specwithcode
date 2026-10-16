import { describe, expect, it } from "vite-plus/test";
import {
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

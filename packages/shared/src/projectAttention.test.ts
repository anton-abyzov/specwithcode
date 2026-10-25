import { describe, expect, it } from "vite-plus/test";
import {
  classifyProjectActions,
  projectActionIsCurrent,
  type AttentionObservation,
} from "./projectAttention.js";
const base: AttentionObservation = {
  environmentId: "a",
  projectId: "p",
  threadId: "t",
  generation: "r1",
  revision: "v1",
  freshness: "live",
  excluded: false,
  settled: false,
  settledAt: null,
  active: false,
  requests: [{ id: "q1", reason: "input", createdAt: 10 }],
};
describe("current user actions", () => {
  it("invalidates answered, dismissed, archived, deleted, superseded and disconnected actions", () => {
    const action = classifyProjectActions(base)[0]!;
    for (const next of [
      { ...base, requests: [] },
      { ...base, excluded: true },
      { ...base, generation: "r2" },
      { ...base, freshness: "cached" as const },
      { ...base, settled: true, settledAt: 20 },
    ])
      expect(projectActionIsCurrent(action, next)).toBe(false);
    expect(projectActionIsCurrent(action, base)).toBe(true);
  });
  it("reopens only for a newer authoritative request", () => {
    expect(classifyProjectActions({ ...base, settled: true, settledAt: 5 })).toHaveLength(1);
    expect(
      classifyProjectActions({
        ...base,
        settled: true,
        settledAt: 5,
        requests: [{ id: "legacy", reason: "input", createdAt: null }],
      }),
    ).toHaveLength(0);
  });
  it("held messages need explicit resume or discard and never count during a run", () => {
    const held = {
      ...base,
      settled: true,
      requests: [{ id: "held", reason: "held" as const, createdAt: null }],
    };
    expect(classifyProjectActions(held)).toHaveLength(1);
    expect(classifyProjectActions({ ...held, active: true })).toHaveLength(0);
  });
  it("does not infer actions from operational state", () =>
    expect(classifyProjectActions({ ...base, requests: [] })).toEqual([]));
});

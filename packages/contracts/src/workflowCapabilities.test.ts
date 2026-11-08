import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  evaluateWorkflow,
  WorkflowRequirements,
  type RuntimeToolInventory,
  type WorkflowCapabilityScope,
} from "./workflowCapabilities.ts";
const scope: WorkflowCapabilityScope = {
  environmentId: "machine-a",
  instanceId: "codex-personal",
  workspaceRoot: "/repo",
  sessionId: "session-a",
  providerThreadId: "native-a",
  nativeThreadId: "native-id-a",
  threadId: "thread-a",
};
const now = Date.parse("2026-10-28T04:00:00Z");
const inventory: RuntimeToolInventory = {
  scope,
  observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  complete: false,
  state: "available",
  source: "native",
  tools: ["mcp__mail__read"],
  servers: [],
};
const check = (overrides: Partial<Parameters<typeof evaluateWorkflow>[0]> = {}) =>
  evaluateWorkflow({
    scope,
    declaration: { state: "declared", requires: { tools: ["mcp__mail__read"] } },
    enabled: true,
    discoveredAt: inventory.observedAt,
    now,
    platform: "linux",
    binaries: new Map(),
    inventory,
    ...overrides,
  });
describe("workflow capability evidence", () => {
  it("keeps discovery, registration and service authorization separate", () => {
    const result = check();
    expect(result.status).toBe("ready");
    expect(result.discovered.reason).toContain("may not have loaded");
    expect(result.registered.reason).toContain("authentication is not checked");
  });
  for (const [key, value] of Object.entries({
    environmentId: "machine-b",
    instanceId: "codex-work",
    workspaceRoot: "/repo-other",
    sessionId: "session-b",
    providerThreadId: "native-b",
    nativeThreadId: "native-id-b",
    threadId: "thread-b",
  })) {
    it(`rejects ${key} from another scope`, () => {
      expect(check({ inventory: { ...inventory, scope: { ...scope, [key]: value } } }).status).toBe(
        "unknown",
      );
    });
  }
  it("does not turn partial, unsupported or unavailable inventories into missing tools", () => {
    expect(check({ inventory: { ...inventory, tools: [] } }).checks[0]?.state).toBe("unknown");
    expect(check({ inventory: { ...inventory, tools: [], state: "unsupported" } }).status).toBe(
      "unknown",
    );
    expect(check({ inventory: undefined }).status).toBe("unknown");
    expect(check({ inventory: { ...inventory, tools: [], complete: true } }).status).toBe(
      "blocked",
    );
  });
  it("never accepts expired or future observations", () => {
    for (const offset of [-60_000, 1])
      expect(
        check({ inventory: { ...inventory, observedAt: DateTime.formatIso(DateTime.makeUnsafe(now + offset)) } })
          .checks[0]?.state,
      ).toBe("stale");
  });
  it("blocks native denial without borrowing a similarly named server", () => {
    expect(
      check({
        inventory: { ...inventory, tools: [], servers: [{ name: "mail", state: "denied" }] },
      }).checks[0]?.state,
    ).toBe("denied");
    expect(
      check({ inventory: { ...inventory, tools: [], servers: [{ name: "mai", state: "denied" }] } })
        .status,
    ).toBe("unknown");
  });
  it("blocks unsupported platform and missing executable, preserves undeclared legacy workflows", () => {
    expect(
      check({
        declaration: {
          state: "declared",
          requires: { platforms: ["darwin"], binaries: ["ffmpeg"] },
        },
        binaries: new Map([["ffmpeg", "missing"]]),
      }).status,
    ).toBe("blocked");
    expect(check({ declaration: { state: "undeclared" } }).status).toBe("unknown");
    expect(check({ declaration: { state: "invalid", reason: "bad" } }).status).toBe("blocked");
  });
  it("rejects executable paths, shell syntax, oversized lists and unsupported platforms", () => {
    const decode = Schema.decodeUnknownSync(WorkflowRequirements);
    for (const binaries of [["../ffmpeg"], ["sh -c"], ["$(touch-marker)"], Array(33).fill("git")])
      expect(() => decode({ binaries })).toThrow();
    expect(() => decode({ platforms: ["mac"] })).toThrow();
  });
});

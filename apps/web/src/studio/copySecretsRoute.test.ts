import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({ access: "denied" as "granted" | "denied" | "unknown" }));
vi.mock("../state/session", () => ({
  readEnvironmentScopeAccess: () => state.access,
}));

import {
  askSealedRoute,
  refreshSealedRoute,
  resetSealedRoutes,
  sealedRouteNow,
  secretsBlocked,
  secretsBlockedText,
  secretsSealed,
  type SecretsRouteCommand,
} from "./copySecretsRoute";
import { approveInput } from "./copySecretsPolicy";

const M4 = "m4" as EnvironmentId;
const M3 = "m3" as EnvironmentId;
const answers =
  (value: unknown, calls: Array<unknown> = []): SecretsRouteCommand =>
  async (request) => {
    calls.push(request);
    if (value instanceof Error) return { _tag: "Failure", error: value } as never;
    return { _tag: "Success", value } as never;
  };

beforeEach(() => {
  state.access = "denied";
  resetSealedRoutes();
});

describe("the sealed way for a window without access:write", () => {
  it("is blocked until the source says it can seal to that machine", async () => {
    expect(sealedRouteNow(M4, M3)).toBeNull();
    expect(secretsBlocked(M4, M3)).toBe(true);
    expect(secretsSealed(M4, M3)).toBe(false);
    const calls: Array<unknown> = [];
    await askSealedRoute(M4, M3, answers({ sealed: true }, calls));
    expect(calls).toEqual([{ environmentId: "m4", input: { destinationEnvironmentId: "m3" } }]);
    expect(secretsBlocked(M4, M3)).toBe(false);
    expect(secretsSealed(M4, M3)).toBe(true);
    // The answer is for that pair only.
    expect(secretsBlocked(M4, "m1")).toBe(true);
    expect(secretsBlocked(M4, null)).toBe(true);
  });

  it("stays blocked when the source cannot be asked or says no", async () => {
    await askSealedRoute(M4, M3, answers(new Error("Unknown method")));
    expect(sealedRouteNow(M4, M3)).toEqual({ sealed: false });
    expect(secretsBlocked(M4, M3)).toBe(true);
    await askSealedRoute(M4, M3, async () => {
      throw new Error("socket closed");
    });
    expect(secretsBlocked(M4, M3)).toBe(true);
    await askSealedRoute(M4, M3, answers({ sealed: false, reason: "not_allowed" }));
    expect(secretsBlocked(M4, M3)).toBe(true);
  });

  it("replaces an earlier yes with a later no", async () => {
    await askSealedRoute(M4, M3, answers({ sealed: true }));
    await refreshSealedRoute(M4, M3, answers({ sealed: false, reason: "unreachable" }));
    expect(secretsSealed(M4, M3)).toBe(false);
    expect(secretsBlocked(M4, M3)).toBe(true);
  });

  it("never asks, and is neither blocked nor sealed, in a window holding access:write", async () => {
    state.access = "granted";
    const calls: Array<unknown> = [];
    await refreshSealedRoute(M4, M3, answers({ sealed: true }, calls));
    expect(calls).toEqual([]);
    expect(secretsBlocked(M4, M3)).toBe(false);
    expect(secretsSealed(M4, M3)).toBe(false);
  });

  it("approves with the files sent sealed, and without secrets where there is no way", async () => {
    expect(approveInput("op", M4, true, [".env"], M3)).toEqual({
      operationId: "op",
      withoutSecrets: true,
    });
    await askSealedRoute(M4, M3, answers({ sealed: true }));
    expect(approveInput("op", M4, true, [".env"], M3)).toEqual({
      operationId: "op",
      expectedSecrets: [".env"],
    });
    expect(approveInput("op", M4, false, [], M3)).toEqual({
      operationId: "op",
      withoutSecrets: true,
    });
    // A caller that names no destination keeps the old rule: denied means none.
    expect(approveInput("op", M4, true, [".env"])).toEqual({
      operationId: "op",
      withoutSecrets: true,
    });
  });

  it("names what would send them for each reason", () => {
    expect(secretsBlockedText("M4", "M3", null)).toBe(
      "Only SpecWithCode on M4 can send secrets. To include them, start this copy in the SpecWithCode window on M4.",
    );
    expect(secretsBlockedText("M4", "M3", { sealed: false, reason: "update_needed" })).toBe(
      "This window can send secrets once SpecWithCode is updated on M3. Update it there, or start this copy in the SpecWithCode window on M4.",
    );
    expect(secretsBlockedText("M4", "M3", { sealed: false, reason: "unreachable" })).toBe(
      "M4 can't reach M3 right now, so this window can't send secrets. To include them, start this copy in the SpecWithCode window on M4.",
    );
  });
});

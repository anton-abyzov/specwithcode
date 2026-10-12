import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  canOperate: false,
  request: vi.fn(),
  observation: { schemaVersion: 1, available: false, error: "switch-unavailable" },
}));

// Exercise the real query's grant/connection gates with a deterministic atom reader.
// Only HTTP transport and the reactive scheduler are replaced; no provider is invoked.
vi.mock("@effect/atom-react", async () => {
  const Effect = await import("effect/Effect");
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtomValue: (atom: { evaluate: (get: (key: string) => unknown) => Effect.Effect<unknown> }) =>
      AsyncResult.success(Effect.runSync(atom.evaluate((key) => state.values[key]))),
  };
});
vi.mock("../connection/runtime", () => ({
  connectionAtomRuntime: {
    atom: (evaluate: unknown) => ({
      evaluate,
      pipe() {
        return this;
      },
    }),
  },
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { presentationAtom: () => "presentation" },
}));
vi.mock("../state/session", async () => {
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      sessionStateAtom: () => "session",
      preparedConnectionValueAtom: () => "prepared",
    },
    readEnvironmentScope: () => state.canOperate,
    readPreparedConnection: () => Option.getOrNull(state.values.prepared as Option.Option<unknown>),
  };
});
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: (key: string) => state.values[key] },
}));
vi.mock("./capacityRequest", async () => {
  const Effect = await import("effect/Effect");
  return {
    requestCapacity: (prepared: unknown, operation: unknown) => {
      state.request(prepared, operation);
      return Effect.succeed(state.observation);
    },
  };
});

import { canOperateStudioCapacity, useStudioCapacity } from "./capacity";
const environmentId = EnvironmentId.make("test-host");
beforeEach(() => {
  state.request.mockClear();
  state.canOperate = false;
  state.values = {
    presentation: { connection: { phase: "connected" } },
    session: AsyncResult.success({ authenticated: true, permissions: ["orchestration:read"] }),
    prepared: Option.some({ environmentId, httpBaseUrl: "https://private.example.test" }),
  };
});

describe("Studio capacity read and operating scopes", () => {
  it("reads observations with orchestration:read without diagnostic or operating permission", () => {
    expect(useStudioCapacity(environmentId).snapshot).toEqual(state.observation);
    expect(state.request).toHaveBeenCalledWith(
      Option.getOrNull(state.values.prepared as Option.Option<unknown>),
      { kind: "read" },
    );
    expect(canOperateStudioCapacity(environmentId)).toBe(false);
  });
  it("does not read with diagnostic-only, empty, or unauthenticated grants", () => {
    for (const grant of [
      { authenticated: true, permissions: ["diagnostics:read"] },
      { authenticated: true, scopes: ["orchestration:read"], permissions: [] },
      { authenticated: false, permissions: ["orchestration:read"] },
    ]) {
      state.values.session = AsyncResult.success(grant);
      expect(useStudioCapacity(environmentId).snapshot).toBeNull();
    }
    expect(state.request).not.toHaveBeenCalled();
  });
  it("does not read cached grants when the session failed or the connection is absent", () => {
    state.values.session = AsyncResult.failure(Cause.fail(new Error("Denied")));
    expect(useStudioCapacity(environmentId).snapshot).toBeNull();
    state.values.session = AsyncResult.success({
      authenticated: true,
      permissions: ["orchestration:read"],
    });
    state.values.presentation = { connection: { phase: "offline" } };
    expect(useStudioCapacity(environmentId).snapshot).toBeNull();
    state.values.presentation = { connection: { phase: "connected" } };
    state.values.prepared = Option.none();
    expect(useStudioCapacity(environmentId).snapshot).toBeNull();
    expect(state.request).not.toHaveBeenCalled();
  });
  it("rechecks both current operating scope and connection for an explicit action", () => {
    state.canOperate = true;
    expect(canOperateStudioCapacity(environmentId)).toBe(true);
    state.values.presentation = { connection: { phase: "offline" } };
    expect(canOperateStudioCapacity(environmentId)).toBe(false);
    state.values.presentation = { connection: { phase: "connected" } };
    state.values.prepared = Option.none();
    expect(canOperateStudioCapacity(environmentId)).toBe(false);
    expect(state.request).not.toHaveBeenCalled();
  });
});

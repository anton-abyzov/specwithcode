import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";

vi.mock("../state/presentation", () => ({ environmentPresentations: {} }));

const { remoteWorkersLoaded } = await import("./fleet");

const runsWorkers = { machines: [{ workers: [] }] } as unknown as StudioFleetSnapshot;
const noWorkers = { machines: [{}] } as unknown as StudioFleetSnapshot;

describe("remote workers loaded", () => {
  it("waits while the request only answered that its connection is not ready", () => {
    expect(remoteWorkersLoaded(AsyncResult.success(null), AsyncResult.initial())).toBe(false);
    expect(remoteWorkersLoaded(AsyncResult.success(null), AsyncResult.success(runsWorkers))).toBe(
      false,
    );
  });

  it("knows once the server sent a list, the fleet runs no workers, or a read failed", () => {
    expect(remoteWorkersLoaded(AsyncResult.success({ workers: [] }), AsyncResult.initial())).toBe(
      true,
    );
    expect(remoteWorkersLoaded(AsyncResult.success(null), AsyncResult.success(noWorkers))).toBe(
      true,
    );
    expect(
      remoteWorkersLoaded(AsyncResult.failure(new Error("x") as never), AsyncResult.initial()),
    ).toBe(true);
  });
});

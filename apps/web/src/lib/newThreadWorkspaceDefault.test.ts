import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, WS_METHODS } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { EnvironmentRegistry } from "@specweave-studio/client-runtime/connection";
import * as Stream from "effect/Stream";
const fixture = vi.hoisted(() => ({ query: vi.fn(), follow: vi.fn(), subscribe: vi.fn() }));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  executeAtomQuery: fixture.query,
  followStreamInEnvironment: fixture.follow,
}));
vi.mock("@specweave-studio/client-runtime/rpc", () => ({ subscribe: fixture.subscribe }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../connection/runtime", () => ({
  connectionAtomRuntime: { atom: (effect: unknown) => effect },
}));
import {
  observeNewThreadIsRepo,
  readNewThreadWorkspaceDefault,
  resolveNewThreadWorkspaceDefault,
} from "./newThreadWorkspaceDefault";

// The mocked transport stream has no EnvironmentRegistry service requirement.
const worker = EnvironmentId.make("worker");
describe("Git-aware new web thread defaults", () => {
  it.each([true, false, undefined])(
    "uses observed repo state %s only for unconfigured drafts",
    async (isRepo) => {
      expect(
        await resolveNewThreadWorkspaceDefault({
          configuredMode: null,
          readIsRepo: async () => isRepo,
        }),
      ).toBe(isRepo === true ? "worktree" : "local");
    },
  );
  it.each(["local", "worktree"] as const)(
    "preserves explicit %s without making any Git query",
    async (mode) => {
      const readIsRepo = vi.fn();
      expect(await resolveNewThreadWorkspaceDefault({ configuredMode: mode, readIsRepo })).toBe(
        mode,
      );
      expect(readIsRepo).not.toHaveBeenCalled();
    },
  );
  it("keeps a Git folder holding separate clones, such as an umbrella, in its checkout", async () => {
    expect(
      await resolveNewThreadWorkspaceDefault({
        configuredMode: null,
        readIsRepo: async () => true,
        readHoldsSeparateClones: async () => true,
      }),
    ).toBe("local");
    expect(
      await resolveNewThreadWorkspaceDefault({
        configuredMode: null,
        readIsRepo: async () => true,
        readHoldsSeparateClones: async () => false,
      }),
    ).toBe("worktree");
  });
  it("keeps the Git default when the layout cannot be read", async () => {
    for (const read of [async () => undefined, async () => Promise.reject(new Error("offline"))]) {
      expect(
        await resolveNewThreadWorkspaceDefault({
          configuredMode: null,
          readIsRepo: async () => true,
          readHoldsSeparateClones: read,
        }),
      ).toBe("worktree");
    }
  });
  it("reads the layout only for a Git folder without a configured mode", async () => {
    const readHoldsSeparateClones = vi.fn(async () => true);
    await resolveNewThreadWorkspaceDefault({
      configuredMode: null,
      readIsRepo: async () => false,
      readHoldsSeparateClones,
    });
    await resolveNewThreadWorkspaceDefault({
      configuredMode: "worktree",
      readIsRepo: async () => true,
      readHoldsSeparateClones,
    });
    expect(readHoldsSeparateClones).not.toHaveBeenCalled();
  });
  it("gives up on a slow layout read and keeps the Git default", async () => {
    vi.useFakeTimers();
    try {
      fixture.follow.mockReturnValue(Stream.empty);
      fixture.query.mockResolvedValueOnce({ _tag: "Success", value: true });
      const result = readNewThreadWorkspaceDefault({
        configuredMode: null,
        environmentId: worker,
        workspaceRoot: "/worker/umbrella",
        readHoldsSeparateClones: () => new Promise<boolean>(() => undefined),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toBe("worktree");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps an unavailable environment usable locally", async () => {
    expect(
      await resolveNewThreadWorkspaceDefault({
        configuredMode: null,
        readIsRepo: async () => {
          throw new Error("offline");
        },
      }),
    ).toBe("local");
  });
  it("reads Git from the requested host and checkout, never the primary environment", async () => {
    fixture.follow.mockReturnValue(Stream.empty);
    fixture.query.mockResolvedValueOnce({ _tag: "Success", value: true });
    expect(
      await readNewThreadWorkspaceDefault({
        configuredMode: null,
        environmentId: worker,
        workspaceRoot: "/worker/project",
      }),
    ).toBe("worktree");
    expect(fixture.subscribe).toHaveBeenLastCalledWith(WS_METHODS.subscribeVcsStatus, {
      cwd: "/worker/project",
    });
    expect(fixture.follow.mock.lastCall?.[0]).toBe(worker);
    expect(fixture.query.mock.lastCall?.[2]).toEqual({ reportDefect: false, reportFailure: false });
  });
  it("falls back for a failed query or missing project", async () => {
    fixture.follow.mockReturnValue(Stream.empty);
    fixture.query.mockResolvedValueOnce({ _tag: "Failure" });
    expect(
      await readNewThreadWorkspaceDefault({
        configuredMode: null,
        environmentId: worker,
        workspaceRoot: "/worker/project",
      }),
    ).toBe("local");
    fixture.query.mockClear();
    expect(
      await readNewThreadWorkspaceDefault({ configuredMode: null, environmentId: worker }),
    ).toBe("local");
    expect(fixture.query).not.toHaveBeenCalled();
  });
  it("finishes on the first local snapshot without waiting for the live stream to close", async () => {
    const finalized = vi.fn();
    fixture.follow.mockReturnValue(
      Stream.make(
        { _tag: "remoteUpdated", remote: null },
        { _tag: "snapshot", local: { isRepo: true } },
      ).pipe(Stream.concat(Stream.never), Stream.ensuring(Effect.sync(finalized))),
    );
    expect(
      await Effect.runPromise(
        observeNewThreadIsRepo(worker, "/worker/project").pipe(
          Effect.provideService(
            EnvironmentRegistry.EnvironmentRegistry,
            new Proxy({} as EnvironmentRegistry.EnvironmentRegistry["Service"], {
              get() {
                throw new Error("Mocked observation must not access the real registry");
              },
            }),
          ),
        ),
      ),
    ).toBe(true);
    expect(finalized).toHaveBeenCalledOnce();
  });
  it("bounds a silent/offline stream and releases its observation", async () => {
    vi.useFakeTimers();
    try {
      const finalized = vi.fn();
      fixture.follow.mockReturnValue(Stream.never.pipe(Stream.ensuring(Effect.sync(finalized))));
      const result = Effect.runPromiseExit(
        observeNewThreadIsRepo(worker, "/worker/project").pipe(
          Effect.provideService(
            EnvironmentRegistry.EnvironmentRegistry,
            new Proxy({} as EnvironmentRegistry.EnvironmentRegistry["Service"], {
              get() {
                throw new Error("Mocked observation must not access the real registry");
              },
            }),
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await result)._tag).toBe("Failure");
      expect(finalized).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

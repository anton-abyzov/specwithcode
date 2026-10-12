import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, WS_METHODS } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
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
        observeNewThreadIsRepo(worker, "/worker/project") as Effect.Effect<
          boolean | undefined,
          unknown
        >,
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
        observeNewThreadIsRepo(worker, "/worker/project") as Effect.Effect<
          boolean | undefined,
          unknown
        >,
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await result)._tag).toBe("Failure");
      expect(finalized).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

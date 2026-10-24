// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native disk reads independently verify atomic persistence, permissions, and corruption handling.
import * as NodeFS from "node:fs";
import { nodePath as NodePath } from "../nodePath.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";

const layer = RemoteWorkerStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "studio-remote-workers-" })),
  Layer.provideMerge(NodeServices.layer),
);

const row = (
  overrides: Partial<RemoteWorkerStore.RemoteWorkerRecord> = {},
): RemoteWorkerStore.RemoteWorkerRecord => ({
  id: "rwt:command-1",
  callerThreadId: "thread-coordinator",
  projectId: "project-1",
  machineId: "m1",
  environmentId: "env-m1",
  remoteProjectId: "remote-project",
  remoteThreadId: null,
  title: "Fix the flaky test",
  launchStartedAt: "2026-10-12T00:00:00.000Z",
  followedRunId: null,
  reportBack: true,
  state: "launching",
  lastStatus: null,
  deliveredRunIds: [],
  lostContactNotified: false,
  lastError: null,
  updatedAt: "2026-10-12T00:00:00.000Z",
  ...overrides,
});

describe("RemoteWorkerStore", () => {
  it.effect("starts empty and persists rows privately and atomically", () =>
    Effect.gen(function* () {
      const store = yield* RemoteWorkerStore.RemoteWorkerStore;
      expect(yield* store.list).toEqual([]);
      yield* store.modify("rwt:command-1", () => row());
      yield* store.modify("rwt:command-1", (current) =>
        current ? { ...current, state: "following", remoteThreadId: "remote-thread" } : undefined,
      );
      const config = yield* ServerConfig.ServerConfig;
      const file = NodePath.join(config.stateDir, "remote-workers.json");
      // Windows has no POSIX mode bits to check.
      if (process.platform !== "win32") expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
      expect(NodeFS.readdirSync(config.stateDir).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );
      const saved = JSON.parse(NodeFS.readFileSync(file, "utf8"));
      expect(saved.version).toBe(1);
      expect(saved.workers).toHaveLength(1);
      expect(saved.workers[0].state).toBe("following");
      expect((yield* store.list)[0]?.remoteThreadId).toBe("remote-thread");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves the file alone when a change returns nothing", () =>
    Effect.gen(function* () {
      const store = yield* RemoteWorkerStore.RemoteWorkerStore;
      const result = yield* store.modify("missing", () => undefined);
      expect(result).toBeUndefined();
      const config = yield* ServerConfig.ServerConfig;
      expect(NodeFS.readdirSync(config.stateDir)).not.toContain("remote-workers.json");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("serializes concurrent changes without losing rows", () =>
    Effect.gen(function* () {
      const store = yield* RemoteWorkerStore.RemoteWorkerStore;
      yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => index),
        (index) => store.modify(`rwt:command-${index}`, () => row({ id: `rwt:command-${index}` })),
        { concurrency: "unbounded", discard: true },
      );
      expect((yield* store.list).map((worker) => worker.id).toSorted()).toHaveLength(12);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("prunes settled rows after 30 days and keeps live ones", () =>
    Effect.gen(function* () {
      const store = yield* RemoteWorkerStore.RemoteWorkerStore;
      const old = "2026-09-01T00:00:00.000Z";
      yield* store.modify("rwt:idle-old", () =>
        row({ id: "rwt:idle-old", state: "idle", updatedAt: old }),
      );
      yield* store.modify("rwt:following-old", () =>
        row({ id: "rwt:following-old", state: "following", updatedAt: old }),
      );
      yield* store.modify("rwt:idle-new", () =>
        row({ id: "rwt:idle-new", state: "idle", updatedAt: "2026-10-11T00:00:00.000Z" }),
      );
      const removed = yield* store.prune(Date.parse("2026-10-12T00:00:00.000Z"));
      expect(removed).toBe(1);
      expect((yield* store.list).map((worker) => worker.id).toSorted()).toEqual([
        "rwt:following-old",
        "rwt:idle-new",
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports an unreadable file instead of overwriting it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const store = yield* RemoteWorkerStore.RemoteWorkerStore;
      yield* store.list;
      NodeFS.writeFileSync(NodePath.join(config.stateDir, "remote-workers.json"), "{not json");
      const error = yield* store.modify("rwt:x", () => row({ id: "rwt:x" })).pipe(Effect.flip);
      expect(error._tag).toBe("RemoteWorkerStoreError");
      expect(
        NodeFS.readFileSync(NodePath.join(config.stateDir, "remote-workers.json"), "utf8"),
      ).toBe("{not json");
    }).pipe(Effect.provide(layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - Exercises the runtime-state file on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { processStartedAtMs } from "./processIdentity.ts";

import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  DATABASE_OWNER_FILE,
  layerServiceDatabaseOwner,
  LiveDatabaseOwnedError,
  refuseWhileServiceRuns,
} from "./liveServiceOwner.ts";

const home = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-live-owner-test-"));
  return {
    dbPath: NodePath.join(dir, "statev2.sqlite"),
    serverRuntimeStatePath: NodePath.join(dir, "server-runtime.json"),
  };
};

const record = (path: string, overrides: { readonly pid?: number; readonly startedAt?: string }) =>
  Effect.gen(function* () {
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 8_319,
    });
    yield* persistServerRuntimeState({
      path,
      state: { ...state, startedAt: DateTime.formatIso(DateTime.nowUnsafe()), ...overrides },
    });
  });

describe("refuseWhileServiceRuns", () => {
  it.effect("refuses while the recorded service process runs, naming the in-app way", () =>
    Effect.gen(function* () {
      const paths = home();
      yield* record(paths.serverRuntimeStatePath, {});
      const error = yield* refuseWhileServiceRuns(paths).pipe(Effect.flip);
      assert.instanceOf(error, LiveDatabaseOwnedError);
      assert.include(error.message, `pid ${String(process.pid)}`);
      assert.include(error.message, "Do this in the SpecWithCode app instead");
      assert.isFalse(NodeFS.existsSync(paths.dbPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the command when no service runs, or the record is stale", () =>
    Effect.gen(function* () {
      const none = home();
      yield* refuseWhileServiceRuns(none);

      const dead = home();
      // 2**22 + 1 exceeds any default Linux or macOS pid.
      yield* record(dead.serverRuntimeStatePath, { pid: 4_194_305 });
      yield* refuseWhileServiceRuns(dead);

      // A live pid that started after the record was written did not write it.
      // Where start times cannot be read (Windows), a live pid still counts.
      const reused = home();
      yield* record(reused.serverRuntimeStatePath, { startedAt: "2000-01-01T00:00:00.000Z" });
      if ((yield* processStartedAtMs(process.pid)) !== null) {
        yield* refuseWhileServiceRuns(reused);
      } else {
        const refused = yield* refuseWhileServiceRuns(reused).pipe(Effect.flip);
        assert.instanceOf(refused, LiveDatabaseOwnedError);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const serviceHome = () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-db-owner-test-"));
    const layerConfig = ServerConfig.layerTest(process.cwd(), baseDir);
    const config = yield* Effect.gen(function* () {
      return yield* ServerConfig.ServerConfig;
    }).pipe(Effect.provide(layerConfig));
    NodeFS.mkdirSync(NodePath.dirname(config.serverRuntimeStatePath), { recursive: true });
    return {
      layerConfig,
      dbPath: config.dbPath,
      serverRuntimeStatePath: config.serverRuntimeStatePath,
      ownerPath: NodePath.join(
        NodePath.dirname(config.serverRuntimeStatePath),
        DATABASE_OWNER_FILE,
      ),
    };
  });

const writeOwner = (ownerPath: string, pid: number) =>
  NodeFS.writeFileSync(
    ownerPath,
    `${JSON.stringify({ version: 1, pid, startedAt: DateTime.formatIso(DateTime.nowUnsafe()) })}\n`,
  );

describe("layerServiceDatabaseOwner", () => {
  // Live clock: the record's start time must be real for the process check.
  it.live(
    "records the service from before the database opens until after it closes, refusing outside opens meanwhile",
    () =>
      Effect.gen(function* () {
        const home = yield* serviceHome();
        const scope = yield* Scope.make();
        yield* Layer.buildWithScope(
          layerServiceDatabaseOwner.pipe(Layer.provide(home.layerConfig)),
          scope,
        );
        // No runtime file yet (migrations still running): the owner record alone refuses.
        assert.isFalse(NodeFS.existsSync(home.serverRuntimeStatePath));
        assert.isTrue(NodeFS.existsSync(home.ownerPath));
        const error = yield* refuseWhileServiceRuns(home).pipe(Effect.flip);
        assert.instanceOf(error, LiveDatabaseOwnedError);
        assert.include(error.message, "starting or stopping");

        yield* Scope.close(scope, Exit.void);
        assert.isFalse(NodeFS.existsSync(home.ownerPath));
        yield* refuseWhileServiceRuns(home);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a second service before it opens the database", () =>
    Effect.gen(function* () {
      // Where start times cannot be read (Windows), a record never blocks a start.
      if ((yield* processStartedAtMs(process.ppid)) === null) {
        const home = yield* serviceHome();
        writeOwner(home.ownerPath, process.ppid);
        yield* Effect.scoped(
          Layer.build(layerServiceDatabaseOwner.pipe(Layer.provide(home.layerConfig))),
        );
        return;
      }
      // The parent process is alive and started before this record was written.
      const byOwner = yield* serviceHome();
      writeOwner(byOwner.ownerPath, process.ppid);
      const owned = yield* Effect.scoped(
        Layer.build(
          SqlitePersistence.layerConfigForService.pipe(Layer.provide(byOwner.layerConfig)),
        ),
      ).pipe(Effect.flip);
      assert.instanceOf(owned, LiveDatabaseOwnedError);
      assert.include(owned.message, `pid ${String(process.ppid)}`);
      assert.isFalse(NodeFS.existsSync(byOwner.dbPath));

      const byRuntime = yield* serviceHome();
      yield* record(byRuntime.serverRuntimeStatePath, { pid: process.ppid });
      const running = yield* Effect.scoped(
        Layer.build(
          SqlitePersistence.layerConfigForService.pipe(Layer.provide(byRuntime.layerConfig)),
        ),
      ).pipe(Effect.flip);
      assert.instanceOf(running, LiveDatabaseOwnedError);
      assert.isFalse(NodeFS.existsSync(byRuntime.dbPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("starts over a record a dead process left behind", () =>
    Effect.gen(function* () {
      const home = yield* serviceHome();
      writeOwner(home.ownerPath, 4_194_305);
      yield* Effect.scoped(
        Layer.build(layerServiceDatabaseOwner.pipe(Layer.provide(home.layerConfig))),
      );
      assert.isFalse(NodeFS.existsSync(home.ownerPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

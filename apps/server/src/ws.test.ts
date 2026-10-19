import { assert, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@specweave-studio/contracts";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
  withLateEditorConfig,
} from "./ws.ts";

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

// Only the fields the late-editor fold reads or rewrites.
const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        // Holds the late snapshot until the settings change has gone out.
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

const storage = (level: "ok" | "low" | "critical", freeBytes: number) => ({
  level,
  freeBytes,
  totalBytes: 994_000_000_000,
  checkedAt: "2026-10-18T12:00:00.000Z",
});
const noEditorChange = {
  resolveAvailableEditors: () => Effect.succeed([]),
  resolveFileManagerRevealKind: () => Effect.succeed(undefined),
};

it.effect("resends the snapshot only when the storage status reads differently", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ storage: storage("ok", 80_000_000_000) }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      noEditorChange,
      // Waits for the settings change, so the resent snapshot must carry it.
      Stream.fromEffect(Deferred.await(settingsSent)).pipe(
        Stream.flatMap(() =>
          Stream.make(
            // The current status, as the monitor replays it on subscribe.
            storage("ok", 80_000_000_000),
            storage("ok", 70_000_000_000),
            storage("low", 3_210_000_000),
            storage("low", 3_240_000_000),
            storage("low", 2_900_000_000),
            storage("critical", 600_000_000),
          ),
        ),
      ),
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const snapshots = Array.from(events).flatMap((event) =>
      event.type === "snapshot" ? [event.config] : [],
    );
    assert.deepEqual(
      snapshots.map((config) => [config.storage?.level, config.storage?.freeBytes]),
      [
        ["low", 3_210_000_000],
        ["low", 2_900_000_000],
        ["critical", 600_000_000],
      ],
    );
    for (const config of snapshots) {
      assert.deepEqual(config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("sends the first storage status a snapshot went out without", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({}),
      Stream.empty,
      noEditorChange,
      Stream.make(storage("ok", 80_000_000_000)),
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.deepEqual(late.config.storage, storage("ok", 80_000_000_000));
    }
  }),
);

it.effect("sends no late snapshot when the scan matches the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["vscode"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["vscode"]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
    ).pipe(Stream.runCollect);

    assert.equal(events.length, 0);
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

// The real launcher on Windows over a filesystem whose probes park until
// released, like a host too busy to finish discovery inside the snapshot timeout.
const makeParkedWindowsLauncher = Effect.gen(function* () {
  const parkedProbes = yield* Queue.unbounded<void>();
  const release = yield* Deferred.make<void>();
  const launcher = yield* ExternalLauncher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Queue.offer(parkedProbes, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ type: "File" } as FileSystem.File.Info),
            ),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
        ),
      ),
    ),
  );
  const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\studio-late-editors-test", PATHEXT: ".EXE" },
          }),
        ),
      ),
    );
  return {
    editors: {
      resolveAvailableEditors: () => onWindows(launcher.resolveAvailableEditors()),
      resolveFileManagerRevealKind: () => onWindows(launcher.resolveFileManagerRevealKind()),
    },
    probeParked: Queue.take(parkedProbes),
    releaseProbes: Deferred.succeed(release, undefined),
  };
});

it.effect("recovers editors after a real scan outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const snapshotFiber = yield* resolveAvailableEditorsForConfig(
      editors.resolveAvailableEditors(),
    ).pipe(Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(5));
    const snapshotEditors = yield* Fiber.join(snapshotFiber);
    assert.deepEqual(snapshotEditors, []);

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: snapshotEditors }),
      Stream.empty,
      editors,
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.availableEditors.includes("vscode"), true);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovers a reveal kind whose real probe outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    // The snapshot's bounded probe timed out: file manager, but no reveal kind.
    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: editors.resolveFileManagerRevealKind,
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(6));
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

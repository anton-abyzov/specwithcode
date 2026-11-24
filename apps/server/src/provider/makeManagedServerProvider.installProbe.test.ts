// @effect-diagnostics-next-line nodeBuiltinImport:off -- a shell read and a folder watch are real work; the test clock cannot wait for them.
import { setTimeout as wait } from "node:timers/promises";

import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { LoginShellPath } from "../serverPath.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeManagedServerProvider, withCli } from "./makeManagedServerProvider.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const ready: ServerProvider = {
  instanceId: ProviderInstanceId.make("agent"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const notInstalled: ServerProvider = {
  ...ready,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  message: "The agent is not installed on this machine.",
};

function layerBackgroundPolicy(windowInFront: () => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: true,
      updatedAt: TEST_EPOCH,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.sync(windowInFront),
    shouldRunScopeWork: () => Effect.sync(windowInFront),
    shouldRunOpportunisticWork: Effect.sync(windowInFront),
    notificationTarget: () => Effect.succeed(null),
    notificationDecision: () => Effect.succeed({ notificationTarget: null, ownerInUse: false }),
  });
}

interface Entry {
  readonly type: "File" | "Directory";
  readonly stamp: number;
}

/**
 * A machine in memory: files that can only be looked at (`stat`), folders
 * that can be watched, a login shell, and an agent whose check answers
 * `account`. Nothing else of the file system answers.
 */
const machine = (options?: {
  readonly windowInFront?: () => boolean;
  readonly interval?: string;
  readonly beside?: ReadonlyArray<string>;
  readonly onCheck?: (disk: Map<string, Entry>) => void;
  /** Holds each check open until it resolves, as a real agent takes seconds to answer. */
  readonly checkTakes?: () => Promise<void>;
}) =>
  Effect.gen(function* () {
    const disk = new Map<string, Entry>([
      ["/tools", { type: "Directory", stamp: 1 }],
      ["/home/dev", { type: "Directory", stamp: 1 }],
    ]);
    const state = {
      account: notInstalled,
      checks: 0,
      stats: 0,
      watching: [] as string[],
    };
    // The agent runs with the server's own environment, as a driver's does.
    const environment = yield* HostProcessEnvironment;
    const folderEvents = yield* PubSub.unbounded<string>();
    const fileSystem = FileSystem.makeNoop({
      stat: (path) =>
        Effect.suspend(() => {
          state.stats += 1;
          const entry = disk.get(path);
          if (!entry) {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "stat",
                pathOrDescriptor: path,
              }),
            );
          }
          return Effect.succeed({
            type: entry.type,
            mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(entry.stamp))),
            ino: Option.some(1),
            mode: 0o755,
            size: ByteSize.bytes(entry.stamp),
          } as unknown as FileSystem.File.Info);
        }),
      watch: (folder) =>
        Stream.suspend(() => {
          state.watching.push(folder);
          return Stream.fromPubSub(folderEvents).pipe(
            Stream.filter((changed) => changed === folder),
            Stream.map((path) => ({ _tag: "Update", path }) as const),
            Stream.ensuring(
              Effect.sync(() => {
                state.watching = state.watching.filter((watched) => watched !== folder);
              }),
            ),
          );
        }),
    });
    const provider = yield* makeManagedServerProvider<{ readonly enabled: boolean }>({
      resolveMaintenance: () => Effect.die("not used"),
      getSettings: Effect.succeed({ enabled: true }),
      streamSettings: Stream.empty,
      haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
      initialSnapshot: () => Effect.succeed({ ...notInstalled, message: "Checking..." }),
      checkProvider: Effect.gen(function* () {
        state.checks += 1;
        options?.onCheck?.(disk);
        const takes = options?.checkTakes;
        if (takes) yield* Effect.promise(takes);
        return state.account;
      }),
      refreshInterval: 0,
      installProbe: {
        command: "agent",
        environment,
        ...(options?.beside ? { beside: options.beside } : {}),
        ...(options?.interval ? { interval: options.interval as "3 seconds" } : {}),
      },
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provide(
        Layer.merge(
          layerBackgroundPolicy(options?.windowInFront ?? (() => true)),
          ServerSettings.layerTest(),
        ),
      ),
    );
    yield* Stream.take(provider.streamChanges, 1).pipe(Stream.runDrain);
    return {
      provider,
      state,
      disk,
      install: (path: string, stamp = 2) => disk.set(path, { type: "File", stamp }),
      folderChanged: (folder: string) => PubSub.publish(folderEvents, folder),
    };
  });

/** Lets work already under way land: forked fibers, and a shell read, which is a promise. */
const settle = Effect.promise(() => wait(10));
/** Waits for something that is on its way, for at most two seconds. */
const until = (reached: () => boolean) =>
  Effect.gen(function* () {
    for (let waited = 0; waited < 200 && !reached(); waited += 1) yield* settle;
  });
/** One look of the probe. */
const look = TestClock.adjust("3 seconds").pipe(Effect.andThen(settle));

/** A Linux server with `/tools` on PATH, and a login shell that answers `shell`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Scope.Scope>,
  shell: () => Promise<string | undefined> = async () => undefined,
) =>
  Effect.scoped(effect).pipe(
    Effect.provideService(HostProcessEnvironment, { PATH: "/tools", HOME: "/home/dev" }),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(LoginShellPath, shell),
    Effect.provide(TestClock.layer()),
  );

describe("withCli", () => {
  it("says the command is missing, or where the one that does not start is", () => {
    assert.deepStrictEqual(withCli(notInstalled, "agent", undefined).cli, {
      state: "missing",
      command: "agent",
    });
    assert.deepStrictEqual(withCli(notInstalled, "agent", "/tools/agent").cli, {
      state: "broken",
      command: "agent",
      path: "/tools/agent",
    });
  });

  it("says nothing for an agent that runs or is off, and drops an old note", () => {
    const noted = withCli(notInstalled, "agent", undefined);
    assert.isUndefined(withCli({ ...noted, ...ready }, "agent", "/tools/agent").cli);
    assert.isFalse("cli" in withCli({ ...noted, enabled: false }, "agent", undefined));
  });
});

describe("an agent that is not installed", () => {
  it.effect("is picked up once its command lands, with no click", () =>
    run(
      Effect.gen(function* () {
        const { provider, state, install } = yield* machine();
        assert.strictEqual(state.checks, 1);
        assert.deepStrictEqual((yield* provider.getSnapshot).cli, {
          state: "missing",
          command: "agent",
        });
        // Nothing on disk moved: the mark is read, the agent is not run.
        yield* look;
        yield* look;
        assert.strictEqual(state.checks, 1);

        install("/tools/agent");
        state.account = ready;
        yield* look;
        yield* until(() => state.checks === 2);
        assert.strictEqual(state.checks, 2);
        const snapshot = yield* provider.getSnapshot;
        assert.isTrue(snapshot.installed);
        assert.isFalse("cli" in snapshot);

        // It runs: nothing is looked for any more.
        const stats = state.stats;
        yield* look;
        yield* look;
        yield* until(() => state.checks === 2);
        assert.strictEqual(state.checks, 2);
        assert.strictEqual(state.stats, stats);
      }),
    ),
  );

  it.effect("is not watched once installed, even while it fails for another reason", () =>
    run(
      Effect.gen(function* () {
        const { provider, state, install, folderChanged } = yield* machine();
        install("/tools/agent");
        // Installed and signed out: nothing that lands in a folder ends that.
        state.account = { ...ready, status: "error", auth: { status: "unauthenticated" } };
        yield* look;
        yield* until(() => state.checks === 2);
        assert.isTrue((yield* provider.getSnapshot).installed);

        const stats = state.stats;
        install("/tools/agent", 3);
        yield* folderChanged("/tools");
        yield* look;
        yield* look;
        assert.strictEqual(state.checks, 2);
        assert.strictEqual(state.stats, stats);
      }),
    ),
  );

  it.effect("is found in an installer folder the shell's PATH never named", () =>
    run(
      Effect.gen(function* () {
        const { provider, state, install } = yield* machine();
        install("/home/dev/.local/bin/agent");
        state.account = ready;
        yield* look;
        yield* until(() => state.checks === 2);
        assert.strictEqual(state.checks, 2);
        assert.isTrue((yield* provider.getSnapshot).installed);
      }),
    ),
  );

  it.effect("is left alone while no window is in front", () => {
    let front = false;
    return run(
      Effect.gen(function* () {
        const { state, install } = yield* machine({ windowInFront: () => front });
        install("/tools/agent");
        state.account = ready;
        yield* settle;
        const stats = state.stats;
        yield* look;
        yield* look;
        assert.strictEqual(state.checks, 1);
        assert.strictEqual(state.stats, stats);
        // The window comes back: the next look sees it.
        front = true;
        yield* look;
        yield* until(() => state.checks === 2);
        assert.strictEqual(state.checks, 2);
      }),
    );
  });

  it.effect("is not checked over and over when its own launcher writes while it is checked", () =>
    run(
      Effect.gen(function* () {
        let writes = 0;
        const { provider, state, install } = yield* machine({
          // A launcher that cannot find its program rewrites itself and gives up.
          onCheck: (disk) => {
            writes += 1;
            disk.set("/tools/agent", { type: "File", stamp: 100 + writes });
          },
        });
        assert.deepStrictEqual((yield* provider.getSnapshot).cli, {
          state: "broken",
          command: "agent",
          path: "/tools/agent",
        });
        yield* look;
        yield* look;
        yield* look;
        assert.strictEqual(state.checks, 1);
        // The program itself landing still counts.
        install("/tools/agent", 7);
        yield* look;
        yield* until(() => state.checks === 2);
        assert.strictEqual(state.checks, 2);
      }),
    ),
  );

  it.effect("does not count what a check still under way has written as a change", () =>
    run(
      Effect.gen(function* () {
        let finish = () => {};
        let slow = false;
        const { state, disk } = yield* machine({
          onCheck: (files) => files.set("/tools/agent", { type: "File", stamp: 50 + files.size }),
          checkTakes: () =>
            slow
              ? new Promise<void>((resolve) => {
                  finish = resolve;
                })
              : Promise.resolve(),
        });
        // Something real changes, and the check it leads to takes a while.
        slow = true;
        disk.set("/tools/agent", { type: "File", stamp: 9 });
        yield* look;
        yield* until(() => state.checks === 2);
        // The probe looks again while that check is still running and has already written.
        yield* look;
        yield* look;
        finish();
        yield* settle;
        yield* look;
        assert.strictEqual(state.checks, 2);
      }),
    ),
  );

  it.effect("is checked again when a file its launcher depends on lands beside it", () =>
    run(
      Effect.gen(function* () {
        const { state, disk, install } = yield* machine({ beside: [".agent-version"] });
        install("/tools/agent");
        yield* look;
        yield* until(() => state.checks === 2);
        assert.strictEqual(state.checks, 2);
        yield* look;
        yield* until(() => state.checks === 2);
        assert.strictEqual(state.checks, 2);
        disk.set("/tools/.agent-version", { type: "File", stamp: 5 });
        state.account = ready;
        yield* look;
        yield* until(() => state.checks === 3);
        assert.strictEqual(state.checks, 3);
      }),
    ),
  );

  it.effect("is checked again as soon as its folder changes, and the watch ends once it runs", () =>
    run(
      Effect.gen(function* () {
        const { provider, state, install, folderChanged } = yield* machine({ interval: "1 hour" });
        yield* until(() => state.watching.length === 1);
        assert.deepStrictEqual(state.watching, ["/tools"]);

        // Something else changed in the folder: the mark says it does not matter.
        yield* folderChanged("/tools");
        yield* TestClock.adjust("1 second");
        assert.strictEqual(state.checks, 1);

        install("/tools/agent");
        state.account = ready;
        yield* folderChanged("/tools");
        yield* TestClock.adjust("1 second");
        yield* until(() => state.checks === 2 && state.watching.length === 0);
        assert.strictEqual(state.checks, 2);
        assert.isTrue((yield* provider.getSnapshot).installed);
        assert.deepStrictEqual(state.watching, []);
      }),
    ),
  );

  it.effect("watches a folder an installer made after the server started", () =>
    run(
      Effect.gen(function* () {
        const { state, disk } = yield* machine({ interval: "1 hour" });
        yield* until(() => state.watching.length === 1);
        assert.deepStrictEqual(state.watching, ["/tools"]);
        disk.set("/home/dev/.local/bin", { type: "Directory", stamp: 1 });
        yield* TestClock.adjust("30 seconds");
        yield* until(() => state.watching.length === 2);
        assert.sameMembers(state.watching, ["/home/dev/.local/bin", "/tools"]);
      }),
    ),
  );
});

describe("an agent whose folder an installer added to the shell's startup files", () => {
  it.effect("is found once that file changed, without a restart", () => {
    let shellReads = 0;
    let shellPath = "/tools";
    return run(
      Effect.gen(function* () {
        const { provider, state, disk, install } = yield* machine();
        disk.set("/home/dev/.zshrc", { type: "File", stamp: 1 });
        // The first look takes the startup files as they are.
        yield* look;
        assert.strictEqual(shellReads, 0);

        install("/opt/agent/bin/agent");
        disk.set("/home/dev/.zshrc", { type: "File", stamp: 2 });
        shellPath = "/opt/agent/bin:/tools";
        state.account = ready;
        yield* look;
        assert.strictEqual(shellReads, 1);
        assert.strictEqual(state.checks, 2);
        assert.isTrue((yield* provider.getSnapshot).installed);
      }),
      async () => {
        shellReads += 1;
        return shellPath;
      },
    );
  });
});

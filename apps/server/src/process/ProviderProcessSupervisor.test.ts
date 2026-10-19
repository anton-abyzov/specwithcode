// @effect-diagnostics nodeBuiltinImport:off - reads the real nice value of a process it started.
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe } from "vite-plus/test";
import * as TestClock from "effect/testing/TestClock";

import {
  PROVIDER_NICE,
  ProviderProcessSupervisor,
  type ProviderProcessHost,
  type ProviderProcessSupervisorShape,
  make,
  makeHost,
} from "./ProviderProcessSupervisor.ts";
import type { ProcessRow, ReapTarget } from "./providerDescendants.ts";

const row = (pid: number, ppid: number, pgid: number, nice = 0): ProcessRow => ({
  pid,
  ppid,
  pgid,
  nice,
  startedAt: `t${pid}`,
});

const host = [row(1, 0, 1), row(90, 1, 90), row(100, 90, 90), row(400, 1, 400)];

// A fake process table: SIGTERM ends every target except the ones named stubborn.
const makeFakeHost = (platform: NodeJS.Platform = "darwin") => {
  const state = {
    table: [...host] as Array<ProcessRow>,
    readable: true,
    stubborn: new Set<number>(),
    signals: [] as Array<[string, NodeJS.Signals]>,
    niced: [] as Array<[number, number]>,
  };
  const name = (target: ReapTarget) =>
    target.kind === "group" ? `group ${target.pgid}` : `pid ${target.pid}`;
  const fake: ProviderProcessHost = {
    platform,
    serverPid: 100,
    readTable: Effect.sync(() => (state.readable ? [...state.table] : undefined)),
    signal: (target, signal) => {
      state.signals.push([name(target), signal]);
      state.table = state.table.filter((process) => {
        const hit =
          target.kind === "group" ? process.pgid === target.pgid : process.pid === target.pid;
        return !hit || (signal === "SIGTERM" && state.stubborn.has(process.pid));
      });
    },
    setNice: (pid, nice) => {
      state.niced.push([pid, nice]);
    },
  };
  return { state, fake };
};

const startRuntime = Effect.fnUntraced(function* (
  supervisor: ProviderProcessSupervisorShape,
  pid: number,
) {
  const runtimeScope = yield* Scope.make();
  const supervise = yield* supervisor.reserve.pipe(
    Effect.provideService(Scope.Scope, runtimeScope),
  );
  yield* supervise(pid);
  return runtimeScope;
});

const closeRuntime = Effect.fnUntraced(function* (runtimeScope: Scope.Closeable) {
  const closing = yield* Scope.close(runtimeScope, Exit.void).pipe(Effect.forkChild);
  yield* TestClock.adjust("2 seconds");
  yield* Fiber.join(closing);
});

it.effect("lowers the provider and reaps the tool groups it left on teardown", () =>
  Effect.gen(function* () {
    const { state, fake } = makeFakeHost();
    const supervisor = yield* make(fake, { sampleInterval: "1 second", grace: "2 seconds" });
    // Copilot 200 (own group) runs shell tool 300 in a fresh group, which backgrounds python 301.
    state.table.push(
      row(200, 100, 200),
      row(201, 200, 200),
      row(300, 201, 300),
      row(301, 300, 300),
    );
    const runtimeScope = yield* startRuntime(supervisor, 200);
    assert.deepEqual(state.niced, [[200, PROVIDER_NICE]]);

    yield* TestClock.adjust("1 second");
    // Forked before the provider was lowered: lowered when first seen.
    assert.deepEqual(
      state.niced.map(([pid]) => pid),
      [200, 201, 300, 301],
    );

    // The provider's own teardown ended it; the shell exited and python escaped to launchd.
    state.table = [...host, row(301, 1, 300), row(302, 301, 300)];
    state.stubborn.add(302);
    yield* closeRuntime(runtimeScope);
    assert.deepEqual(state.signals, [
      ["group 300", "SIGTERM"],
      ["group 300", "SIGKILL"],
    ]);
    assert.deepEqual(state.table, host);
  }).pipe(Effect.scoped),
);

it.effect("signals nothing when the provider started nothing that is still running", () =>
  Effect.gen(function* () {
    const { state, fake } = makeFakeHost();
    const supervisor = yield* make(fake, { sampleInterval: "1 second" });
    state.table.push(row(200, 100, 200));
    const runtimeScope = yield* startRuntime(supervisor, 200);
    yield* TestClock.adjust("1 second");
    state.table = [...host];
    yield* closeRuntime(runtimeScope);
    assert.deepEqual(state.signals, []);
  }).pipe(Effect.scoped),
);

it.effect("does nothing when the process table cannot be read or the host is unsupported", () =>
  Effect.gen(function* () {
    const unreadable = makeFakeHost();
    const supervisor = yield* make(unreadable.fake, { sampleInterval: "1 second" });
    unreadable.state.table.push(row(200, 100, 200), row(300, 200, 300));
    const runtimeScope = yield* startRuntime(supervisor, 200);
    yield* TestClock.adjust("1 second");
    unreadable.state.readable = false;
    yield* closeRuntime(runtimeScope);
    assert.deepEqual(unreadable.state.signals, []);

    const windows = makeFakeHost("win32");
    const unsupported = yield* make(windows.fake);
    windows.state.table.push(row(200, 100, 200), row(300, 200, 300));
    yield* closeRuntime(yield* startRuntime(unsupported, 200));
    assert.deepEqual(windows.state.signals, []);
    assert.deepEqual(windows.state.niced, []);
  }).pipe(Effect.scoped),
);

it.effect("never supervises this server, pid 1 or a missing pid", () =>
  Effect.gen(function* () {
    const { state, fake } = makeFakeHost();
    const supervisor = yield* make(fake);
    for (const pid of [100, 1, 0]) yield* closeRuntime(yield* startRuntime(supervisor, pid));
    const runtimeScope = yield* Scope.make();
    const supervise = yield* supervisor.reserve.pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
    );
    yield* supervise(undefined);
    yield* closeRuntime(runtimeScope);
    assert.deepEqual(state.niced, []);
    assert.deepEqual(state.signals, []);
  }).pipe(Effect.scoped),
);

it.effect("is a no-op unless the server provides the live layer", () =>
  Effect.gen(function* () {
    const supervisor = yield* ProviderProcessSupervisor;
    const supervise = yield* supervisor.reserve;
    yield* supervise(200);
  }).pipe(Effect.scoped),
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A provider that starts a tool in a process group of its own, then dies: the tool is
// reparented to launchd (init) and only the ledger still ties it to the provider.
const PROVIDER_WITH_ESCAPING_TOOL = [
  "const { spawn } = require('node:child_process');",
  "const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });",
  "tool.unref();",
  "process.stdout.write(String(tool.pid) + '\\n');",
  "setInterval(() => {}, 1000);",
].join("\n");

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("on this host", () => {
  it.live("reaps a real tool group that outlived its provider, and only that", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const supervisor = yield* make(host, { sampleInterval: "100 millis", grace: "500 millis" });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtimeScope = yield* Scope.make();
      const supervise = yield* supervisor.reserve.pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
      );
      const provider = yield* spawner
        .spawn(ChildProcess.make(process.execPath, ["-e", PROVIDER_WITH_ESCAPING_TOOL]))
        .pipe(Effect.provideService(Scope.Scope, runtimeScope));
      const providerPid = Number(provider.pid);
      yield* supervise(providerPid);
      const toolPid = Number(
        yield* provider.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        ),
      );
      try {
        // A few samples while the provider is alive record the tool and its group.
        yield* Effect.sleep("600 millis");
        assert.isTrue(isAlive(toolPid));
        assert.equal(NodeOS.getPriority(providerPid), PROVIDER_NICE);
        process.kill(providerPid, "SIGKILL");
        yield* Effect.sleep("200 millis");
        assert.isTrue(isAlive(toolPid));

        yield* Scope.close(runtimeScope, Exit.void);
        for (let attempt = 0; attempt < 30 && isAlive(toolPid); attempt += 1) {
          yield* Effect.sleep("100 millis");
        }
        assert.isFalse(isAlive(toolPid));
        assert.isTrue(isAlive(process.pid));
      } finally {
        if (isAlive(toolPid)) process.kill(toolPid, "SIGKILL");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

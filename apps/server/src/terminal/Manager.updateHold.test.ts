import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_TERMINAL_ID, type TerminalOpenInput } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as ServiceUpdateHold from "../serviceUpdate/ServiceUpdateHold.ts";
import { makeGatedHold } from "../serviceUpdate/UpdateInstallGate.testkit.ts";
import * as TerminalManager from "./Manager.ts";
import type * as PtyAdapter from "./PtyAdapter.ts";

class FakePty implements PtyAdapter.PtyProcess {
  readonly pid: number;
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  constructor(pid: number) {
    this.pid = pid;
  }
  write(): void {}
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class FakePtyAdapter {
  readonly processes: Array<FakePty> = [];
  spawn(): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const process = new FakePty(7_000 + this.processes.length);
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

const openInput = (threadId: string): TerminalOpenInput => ({
  threadId,
  terminalId: DEFAULT_TERMINAL_ID,
  cwd: process.cwd(),
  cols: 100,
  rows: 24,
});

const makeManager = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-terminal-update-" });
  const logsDir = join(baseDir, "logs");
  const ptyAdapter = new FakePtyAdapter();
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir,
    ptyAdapter,
    processKillGraceMs: 1,
  });
  return { manager, ptyAdapter, logsDir, join };
});

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager during a service update", (it) => {
  it.effect("closes every running terminal and keeps its history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { manager, ptyAdapter, logsDir, join } = yield* makeManager;
      yield* manager.open(openInput("thread-1"));
      yield* manager.open(openInput("thread-2"));
      ptyAdapter.processes[0]!.emitData("build finished\n");
      assert.equal(yield* manager.countOpen, 2);

      assert.equal(yield* manager.closeAll, 2);
      assert.equal(yield* manager.countOpen, 0);
      assert.isTrue(ptyAdapter.processes.every((process) => process.killed));
      const history = yield* fs.readFileString(
        join(logsDir, `terminal_${Base64Url.encode("thread-1")}.log`),
      );
      assert.include(history, "build finished");
      // Nothing left to close.
      assert.equal(yield* manager.closeAll, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("waits to start a terminal until the update hold ends", () =>
    Effect.gen(function* () {
      const hold = yield* ServiceUpdateHold.makeWithOptions({
        agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
      });
      const { manager, ptyAdapter } = yield* makeManager.pipe(
        Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold),
      );
      yield* hold.acquire();
      const opening = yield* Effect.forkChild(manager.open(openInput("thread-1")));
      yield* Effect.sleep(Duration.millis(50));
      assert.equal(ptyAdapter.processes.length, 0);
      yield* hold.release("cancelled");
      yield* Fiber.join(opening);
      assert.equal(ptyAdapter.processes.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a restart outside admission while held and leaves its running shell alone", () =>
    Effect.gen(function* () {
      const hold = yield* ServiceUpdateHold.makeWithOptions({
        agentStatePath: "/nonexistent/specweave-studio-test/updates/state.json",
      });
      const { manager, ptyAdapter } = yield* makeManager.pipe(
        Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, hold),
      );
      yield* manager.open(openInput("thread-1"));
      yield* hold.acquire();
      const restarting = yield* manager
        .restart({ ...openInput("thread-1"), cols: 100, rows: 24 })
        .pipe(Effect.forkScoped);
      yield* Effect.sleep(Duration.millis(50));
      // Waiting on the hold cannot itself keep the admission fence waiting.
      yield* hold.awaitAdmissions;
      assert.equal(ptyAdapter.processes.length, 1);
      assert.isFalse(ptyAdapter.processes[0]!.killed);
      yield* hold.release("cancelled");
      yield* Fiber.join(restarting);
      assert.equal(ptyAdapter.processes.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("waits to start a terminal until an update install's gate is cleared", () =>
    Effect.gen(function* () {
      const gated = yield* makeGatedHold();
      const { manager, ptyAdapter } = yield* makeManager.pipe(
        Effect.provideService(ServiceUpdateHold.ServiceUpdateHold, gated.hold),
      );
      const opening = yield* Effect.forkChild(manager.open(openInput("thread-1")));
      yield* Effect.sleep(Duration.millis(50));
      assert.equal(ptyAdapter.processes.length, 0);
      yield* gated.clear;
      yield* Fiber.join(opening);
      assert.equal(ptyAdapter.processes.length, 1);
    }).pipe(Effect.scoped),
  );
});

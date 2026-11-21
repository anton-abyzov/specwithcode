import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalSessionLookupError,
  TerminalStopError,
} from "@specweave-studio/contracts";
import { HostProcessPlatform, HostProcessArchitecture } from "@specweave-studio/shared/hostProcess";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as NodeOS from "node:os";
import { expect } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "./Manager.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import { prepareElevatedRunHandle } from "./elevatedRun.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

class WaitForConditionError extends Data.TaggedError("WaitForConditionError")<{
  readonly message: string;
}> {}

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly killSignals: Array<string | undefined> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  resizeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  killed = false;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;
  onKill: ((signal?: string) => void) | undefined;

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) {
      throw this.writeFailure;
    }
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.resizeFailure !== undefined) {
      throw this.resizeFailure;
    }
    this.resizeCalls.push({ cols, rows });
  }

  kill(signal?: string): void {
    this.killed = true;
    this.killSignals.push(signal);
    this.onKill?.(signal);
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitOnSubscribe) callback(this.exitOnSubscribe);
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  get exitListenerCount(): number {
    return this.exitListeners.size;
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  readonly spawnFailures: Error[] = [];
  private readonly mode: "sync" | "async";
  private nextPid = 9000;
  exitOnSubscribe: PtyAdapter.PtyExitEvent | undefined;
  beforeSpawn: ((input: PtyAdapter.PtySpawnInput) => Effect.Effect<void>) | undefined;
  onSpawnedProcess: ((process: FakePtyProcess) => void) | undefined;

  constructor(mode: "sync" | "async" = "sync") {
    this.mode = mode;
  }

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    const runSpawn = (): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> => {
      this.spawnInputs.push(input);
      const failure = this.spawnFailures.shift();
      if (failure) {
        return Effect.fail(
          new PtyAdapter.PtySpawnError({
            adapter: "fake",
            shell: input.shell,
            cause: failure,
          }),
        );
      }
      const process = new FakePtyProcess(this.nextPid++);
      process.exitOnSubscribe = this.exitOnSubscribe;
      this.onSpawnedProcess?.(process);
      this.processes.push(process);
      if (this.mode === "async") {
        return Effect.tryPromise({
          try: async () => process,
          catch: (cause) =>
            new PtyAdapter.PtySpawnError({
              adapter: "fake",
              shell: input.shell,
              cause,
            }),
        });
      }
      return Effect.succeed(process);
    };
    return this.beforeSpawn ? Effect.flatMap(this.beforeSpawn(input), runSpawn) : runSpawn();
  }
}

const waitFor = <E, R>(
  predicate: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = 800,
): Effect.Effect<void, WaitForConditionError | E, R> =>
  predicate.pipe(
    Effect.filterOrFail(
      (done) => done,
      () => new WaitForConditionError({ message: "Condition not met" }),
    ),
    Effect.retry(Schedule.spaced("15 millis")),
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(new WaitForConditionError({ message: "Timed out waiting for condition" })),
        onSome: () => Effect.void,
      }),
    ),
  );

function openInput(overrides: Partial<TerminalOpenInput> = {}): TerminalOpenInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

function restartInput(overrides: Partial<TerminalRestartInput> = {}): TerminalRestartInput {
  return {
    threadId: "thread-1",
    terminalId: DEFAULT_TERMINAL_ID,
    cwd: process.cwd(),
    cols: 100,
    rows: 24,
    ...overrides,
  };
}

const historyLogPath = (logsDir: string, threadId = "thread-1") =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => join(logsDir, `terminal_${Base64Url.encode(threadId)}.log`)),
  );

const multiTerminalHistoryLogPath = (
  logsDir: string,
  threadId = "thread-1",
  terminalId = DEFAULT_TERMINAL_ID,
) =>
  Effect.service(Path.Path).pipe(
    Effect.map(({ join }) => {
      const threadPart = `terminal_${Base64Url.encode(threadId)}`;
      return join(
        logsDir,
        terminalId === DEFAULT_TERMINAL_ID
          ? `${threadPart}.log`
          : `${threadPart}_${Base64Url.encode(terminalId)}.log`,
      );
    }),
  );

interface CreateManagerOptions {
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: (terminalPid: number) => Effect.Effect<{
    readonly hasRunningSubprocess: boolean;
    readonly childCommand: string | null;
    readonly processIds: ReadonlyArray<number>;
  }>;
  processTable?: Effect.Effect<
    ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }>,
    never
  >;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  elevatedCleanupTimeoutMs?: number;
  maxRetainedInactiveSessions?: number;
  historyByteLimit?: number;
  ptyAdapter?: FakePtyAdapter;
  resolveProviderInstanceEnvironment?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["resolveProviderInstanceEnvironment"];
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
  elevatedRunsDir?: string;
  prepareElevatedRun?: typeof prepareElevatedRunHandle;
  launchctlGetenvSshAuthSock?: Effect.Effect<string | undefined>;
  registerTerminalProcesses?: Parameters<
    typeof TerminalManager.makeWithOptions
  >[0]["registerTerminalProcesses"];
  unregisterTerminal?: Parameters<typeof TerminalManager.makeWithOptions>[0]["unregisterTerminal"];
}

interface ManagerFixture {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly ptyAdapter: FakePtyAdapter;
  readonly manager: TerminalManager.TerminalManager["Service"];
  readonly getEvents: Effect.Effect<ReadonlyArray<TerminalEvent>>;
}

const createManager = (
  historyLineLimit = 5,
  options: CreateManagerOptions = {},
): Effect.Effect<
  ManagerFixture,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ProcessRunner.ProcessRunner
> =>
  Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
    Effect.gen(function* () {
      const { join } = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-terminal-" });
      const logsDir = join(baseDir, "userdata", "logs", "terminals");
      const ptyAdapter = options.ptyAdapter ?? new FakePtyAdapter();

      const manager = yield* TerminalManager.makeWithOptions({
        logsDir,
        historyLineLimit,
        ptyAdapter,
        ...(options.historyByteLimit !== undefined
          ? { historyByteLimit: options.historyByteLimit }
          : {}),
        ...(options.shellResolver !== undefined ? { shellResolver: options.shellResolver } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        // Never the real launchctl: it would hand tests this Mac's agent socket.
        launchctlGetenvSshAuthSock: options.launchctlGetenvSshAuthSock ?? Effect.succeed(undefined),
        ...(options.subprocessInspector !== undefined
          ? { subprocessInspector: options.subprocessInspector }
          : {}),
        ...(options.processTable !== undefined ? { processTable: options.processTable } : {}),
        ...(options.subprocessPollIntervalMs !== undefined
          ? { subprocessPollIntervalMs: options.subprocessPollIntervalMs }
          : {}),
        processKillGraceMs: options.processKillGraceMs ?? 1,
        ...(options.elevatedCleanupTimeoutMs !== undefined
          ? { elevatedCleanupTimeoutMs: options.elevatedCleanupTimeoutMs }
          : {}),
        ...(options.maxRetainedInactiveSessions !== undefined
          ? { maxRetainedInactiveSessions: options.maxRetainedInactiveSessions }
          : {}),
        ...(options.registerTerminalProcesses !== undefined
          ? { registerTerminalProcesses: options.registerTerminalProcesses }
          : {}),
        ...(options.unregisterTerminal !== undefined
          ? { unregisterTerminal: options.unregisterTerminal }
          : {}),
        ...(options.resolveProviderInstanceEnvironment !== undefined
          ? { resolveProviderInstanceEnvironment: options.resolveProviderInstanceEnvironment }
          : {}),
        ...(options.managedBinaryCacheDir === undefined
          ? {}
          : {
              managedBinaryCacheDir: options.managedBinaryCacheDir,
              managedBinaryToolsDir: options.managedBinaryToolsDir,
            }),
        ...(options.elevatedRunsDir !== undefined
          ? { elevatedRunsDir: options.elevatedRunsDir }
          : {}),
        ...(options.prepareElevatedRun !== undefined
          ? { prepareElevatedRun: options.prepareElevatedRun }
          : {}),
      });
      const eventsRef = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(eventsRef, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      return {
        baseDir,
        logsDir,
        join,
        ptyAdapter,
        manager,
        getEvents: Ref.get(eventsRef),
      };
    }),
  );

const layerWithHostPlatform = (platform: NodeJS.Platform) =>
  Layer.succeed(HostProcessPlatform, platform);

// Apply the existing line policy, then find the longest code-point-aligned byte tail.
function retainedHistory(text: string, maxLines: number, maxBytes = Infinity): string {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const retained = lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
  const capped = terminated ? `${retained}\n` : retained;
  if (Buffer.byteLength(capped) <= maxBytes) return capped;
  const points = Array.from(capped);
  let start = points.length;
  let bytes = 0;
  while (start > 0) {
    const next = Buffer.byteLength(points[start - 1]!);
    if (bytes + next > maxBytes) break;
    bytes += next;
    start -= 1;
  }
  return points.slice(start).join("");
}

it("preserves line and byte limits across arbitrary chunks, Unicode, ANSI sequences, and clear", () => {
  let randomSeed = 0x20260904;
  const fragments = [
    "",
    "a",
    "\n",
    "\n\n",
    "\r",
    "\r\n",
    "café",
    "名",
    "🚀",
    "\u001b[31m",
    "\u001b[0m",
    "\u001b]8;;url\u0007",
    "\ud83d",
    "\ude80",
  ];
  const nextFragment = () => {
    randomSeed = (Math.imul(randomSeed, 1_664_525) + 1_013_904_223) >>> 0;
    return fragments[randomSeed % fragments.length]!;
  };

  for (const maxBytes of [0, 3, 8, 64, Infinity]) {
    for (const maxLines of [0, 1, 3, 5, 5_000]) {
      let expected = retainedHistory("before\ninitial\n", maxLines, maxBytes);
      const history = new TerminalManager.BoundedTerminalHistory(
        maxLines,
        "before\ninitial\n",
        maxBytes,
      );
      expect(history.value()).toBe(expected);

      for (let step = 0; step < 300; step += 1) {
        if (step % 73 === 0) {
          history.clear();
          expected = "";
          expect(history.value()).toBe(expected);
        }
        const chunk = nextFragment() + nextFragment();
        history.append(chunk);
        expected = retainedHistory(expected + chunk, maxLines, maxBytes);
        expect(history.value()).toBe(expected);
      }
    }
  }
});

it("bounds long partial lines and joins surrogate pairs across chunk boundaries", () => {
  const maxBytes = 65_539;
  let expected = "";
  const history = new TerminalManager.BoundedTerminalHistory(5_000, "", maxBytes);
  const writes = [
    "a".repeat(16_383) + "😀" + "b".repeat(70_000),
    "\r" + "c".repeat(70_000) + "\ud83d",
    "\ude80" + "d".repeat(100),
    "\uFEFF" + "名".repeat(30_000),
  ];
  for (const text of writes) {
    history.append(text);
    expected = retainedHistory(expected + text, 5_000, maxBytes);
    expect(history.value()).toBe(expected);
    expect(Buffer.byteLength(history.value())).toBeLessThanOrEqual(maxBytes);
  }
});

it("preserves retained lines as older storage is compacted", () => {
  for (const maxLines of [3, 5_000]) {
    let expected = "";
    const history = new TerminalManager.BoundedTerminalHistory(maxLines, expected);
    for (let batch = 0; batch < 40; batch += 1) {
      const chunk = Array.from({ length: 300 }, (_, line) => `${batch}:${line}\n`).join("");
      history.append(chunk);
      expected = retainedHistory(expected + chunk, maxLines);
      expect(history.value()).toBe(expected);
    }
  }
});

it.layer(
  Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("holds terminal open, attach-spawn and restart behind a lifecycle decision", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      for (const mode of ["open", "attach", "restart"] as const) {
        const input = { ...openInput({ threadId: `lifecycle-${mode}` }), cols: 80, rows: 24 };
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const attempted = yield* Deferred.make<void>();
        const before = ptyAdapter.spawnInputs.length;
        const decision = yield* manager
          .withThreadLifecycleLock(
            input.threadId,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const action =
          mode === "open"
            ? manager.open(input).pipe(Effect.asVoid)
            : mode === "attach"
              ? manager
                  .attachStream(input, () => Effect.void)
                  .pipe(
                    Effect.tap((unsubscribe) => Effect.sync(unsubscribe)),
                    Effect.asVoid,
                  )
              : manager.restart(input).pipe(Effect.asVoid);
        const request = yield* Deferred.succeed(attempted, undefined).pipe(
          Effect.andThen(action),
          Effect.forkChild,
        );
        yield* Deferred.await(attempted);
        yield* Effect.yieldNow;
        expect(ptyAdapter.spawnInputs).toHaveLength(before);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(decision);
        yield* Fiber.join(request);
        expect(ptyAdapter.spawnInputs).toHaveLength(before + 1);
      }
    }),
  );

  it.effect("spawns lazily and reuses running terminal per thread", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const [first, second] = yield* Effect.all(
        [manager.open(openInput()), manager.open(openInput())],
        { concurrency: "unbounded" },
      );
      const third = yield* manager.open(openInput());

      assert.equal(first.threadId, "thread-1");
      assert.equal(first.terminalId, DEFAULT_TERMINAL_ID);
      assert.equal(second.threadId, "thread-1");
      assert.equal(third.threadId, "thread-1");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("attaches to running sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();

      yield* manager.open(openInput());
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 100,
          rows: 40,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.threadId, "thread-1");
      assert.equal(snapshot.snapshot.terminalId, DEFAULT_TERMINAL_ID);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("sends at most the stated history budget to attach and observe streams", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(10_000);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      // Two-byte characters make an odd budget land inside a code point.
      const output = Array.from({ length: 400 }, (_, line) => `line ${line} \u00e9\u00e9\n`).join(
        "",
      );
      process.emitData(output);
      yield* waitFor(
        manager.open(openInput()).pipe(Effect.map((snapshot) => snapshot.history === output)),
      );

      const historyFrom = (
        stream: typeof manager.attachStream,
        maxHistoryBytes: number | undefined,
      ) =>
        Effect.gen(function* () {
          const events = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
          const unsubscribe = yield* stream(
            {
              threadId: "thread-1",
              terminalId: DEFAULT_TERMINAL_ID,
              ...(maxHistoryBytes === undefined ? {} : { maxHistoryBytes }),
            },
            (event) => Ref.update(events, (current) => [...current, event]),
          );
          unsubscribe();
          const first = (yield* Ref.get(events))[0];
          return first?.type === "snapshot" ? first.snapshot.history : null;
        });

      const budget = 1_001;
      const fullBytes = Buffer.byteLength(output);
      expect(fullBytes).toBeGreaterThan(budget * 4);
      for (const stream of [manager.attachStream, manager.observeStream]) {
        assert.equal(yield* historyFrom(stream, undefined), output);
        const bounded = yield* historyFrom(stream, budget);
        expect(bounded).not.toBeNull();
        if (bounded === null) return;
        expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(budget);
        expect(Buffer.byteLength(bounded)).toBeGreaterThanOrEqual(budget - 3);
        expect(output.endsWith(bounded)).toBe(true);
        expect(bounded.includes("\ufffd")).toBe(false);
        assert.equal(yield* historyFrom(stream, 0), "");
      }
    }),
  );

  it.effect("keeps attach streams live when a terminal id is closed and reopened", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.open(openInput());

      const events = yield* Ref.get(attachEvents);
      expect(events.map((event) => event.type)).toEqual(["snapshot", "closed", "snapshot"]);
      expect(
        events.filter((event) => event.type === "snapshot").map((event) => event.snapshot.status),
      ).toEqual(["running", "running"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("runs one command through the shell and reruns it after it exits", () =>
    Effect.gen(function* () {
      // A POSIX shell on every host; shellCandidateArgs covers the Windows flags.
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        shellResolver: () => "/bin/sh",
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      const input = openInput({ terminalId: "run-abc-4", command: "ls -la" });
      const runFlag = "-c";

      yield* manager.open(input);
      expect(ptyAdapter.spawnInputs[0]?.args?.slice(-2)).toEqual([runFlag, "ls -la"]);
      const process = ptyAdapter.processes[0];
      if (!process) return expect(process).toBeDefined();

      process.emitExit({ exitCode: 3, signal: 0 });
      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );
      const exited = (yield* getEvents).find((event) => event.type === "exited");
      expect(exited).toEqual(expect.objectContaining({ exitCode: 3 }));

      const rerun = yield* manager.open(input);
      expect(rerun.status).toBe("running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.args?.slice(-2)).toEqual([runFlag, "ls -la"]);

      // The same terminal id with a different command starts that command instead.
      yield* manager.open({ ...input, command: "pwd" });
      expect(ptyAdapter.spawnInputs).toHaveLength(3);
      expect(ptyAdapter.spawnInputs[2]?.args?.slice(-2)).toEqual([runFlag, "pwd"]);
    }),
  );

  it.effect("builds one-command arguments for each shell", () =>
    Effect.sync(() => {
      const shellCandidateArgs = TerminalManager.shellCandidateArgs;
      expect(shellCandidateArgs({ shell: "/bin/zsh", args: ["-l"] }, null, "darwin")).toEqual([
        "-l",
      ]);
      expect(
        shellCandidateArgs(
          { shell: "/bin/zsh", args: ["-l", "-o", "nopromptsp"] },
          "pwd",
          "darwin",
        ),
      ).toEqual(["-l", "-o", "nopromptsp", "-c", "pwd"]);
      expect(shellCandidateArgs({ shell: "bash" }, "pwd", "linux")).toEqual(["-c", "pwd"]);
      expect(shellCandidateArgs({ shell: "pwsh.exe", args: ["-NoLogo"] }, "dir", "win32")).toEqual([
        "-NoLogo",
        "-Command",
        "dir",
      ]);
      expect(
        shellCandidateArgs({ shell: "C:\\Windows\\System32\\cmd.exe" }, "dir", "win32"),
      ).toEqual(["/d", "/s", "/c", "dir"]);
    }),
  );

  it.effect("attaches to exited sessions without restarting them", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        openInput({
          env: {
            STUDIO_WORKTREE_PATH: "/tmp/should-not-restart",
          },
          worktreePath: "/tmp/should-not-restart",
        }),
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "exited");
      assert.equal(snapshot.snapshot.worktreePath, null);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("restarts inactive sessions from attach only when requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager();

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
        "1200 millis",
      );

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          ...openInput({
            env: {
              STUDIO_WORKTREE_PATH: "/tmp/restart-requested",
            },
            worktreePath: "/tmp/restart-requested",
          }),
          restartIfNotRunning: true,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      assert.equal(snapshot.snapshot.status, "running");
      assert.equal(snapshot.snapshot.worktreePath, "/tmp/restart-requested");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  const makeDirectory = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.makeDirectory(filePath, { recursive: true }),
    );

  const chmod = (filePath: string, mode: number) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.chmod(filePath, mode));

  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );

  it.effect("reports a missing cwd without an artificial cause", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "missing-cwd");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotFoundError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("reports a cwd that is not a directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const cwd = path.join(baseDir, "cwd-file");
      yield* writeFileString(cwd, "not a directory");
      const error = yield* Effect.flip(manager.open(openInput({ cwd })));

      expect(error).toMatchObject({
        _tag: "TerminalCwdNotDirectoryError",
        cwd,
      });
      expect("cause" in error).toBe(false);
    }),
  );

  it.effect("preserves non-notFound cwd stat failures", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;

      const path = yield* Path.Path;

      const { manager, baseDir } = yield* createManager();
      const blockedRoot = path.join(baseDir, "blocked-root");
      const blockedCwd = path.join(blockedRoot, "cwd");
      yield* makeDirectory(blockedCwd);
      yield* chmod(blockedRoot, 0o000);

      const error = yield* Effect.flip(manager.open(openInput({ cwd: blockedCwd }))).pipe(
        Effect.ensuring(chmod(blockedRoot, 0o755).pipe(Effect.ignore)),
      );

      expect(error).toMatchObject({
        _tag: "TerminalCwdStatError",
        cwd: blockedCwd,
        cause: {
          _tag: "PlatformError",
        },
      });
    }),
  );

  it.effect("handles an exit replayed during subscription after publishing startup", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      ptyAdapter.exitOnSubscribe = { exitCode: 7, signal: null };
      const { manager, getEvents } = yield* createManager(5, { ptyAdapter });
      const exited = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* manager.open(openInput());
      yield* Deferred.await(exited);
      const events = yield* getEvents;
      expect(events.map((event) => event.type)).toEqual(["started", "exited"]);
      expect(events[1]).toMatchObject({ exitCode: 7 });
      const attached: TerminalAttachStreamEvent[] = [];
      const stopAttach = yield* manager.attachStream(openInput(), (event) =>
        Effect.sync(() => {
          attached.push(event);
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(stopAttach));
      expect(attached.find((event) => event.type === "snapshot")).toMatchObject({
        snapshot: { status: "exited", exitCode: 7 },
      });
    }),
  );

  it.effect("supports asynchronous PTY spawn effects", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes).toHaveLength(1);
    }),
  );

  it.effect("forwards write and resize to active pty process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "ls\n",
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.writes).toEqual(["ls\n"]);
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("preserves structured context and causes for PTY I/O failures", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const writeCause = new Error("PTY input handle is unavailable");
      process.writeFailure = writeCause;
      const writeError = yield* Effect.flip(
        manager.write({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          data: "secret input that must not be attached to the error",
        }),
      );

      expect(writeError).toMatchObject({
        _tag: "TerminalWriteError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
      });
      expect(writeError.cause).toBe(writeCause);
      expect(writeError).not.toHaveProperty("data");

      const resizeCause = new Error("PTY resize handle is unavailable");
      process.resizeFailure = resizeCause;
      const resizeError = yield* Effect.flip(
        manager.resize({
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
          cols: 132,
          rows: 40,
        }),
      );

      expect(resizeError).toMatchObject({
        _tag: "TerminalResizeError",
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        terminalPid: process.pid,
        cols: 132,
        rows: 40,
      });
      expect(resizeError.cause).toBe(resizeCause);

      process.resizeFailure = undefined;
      yield* manager.open(openInput({ cols: 132, rows: 40 }));
      expect(process.resizeCalls).toEqual([{ cols: 132, rows: 40 }]);
    }),
  );

  it.effect("ignores delayed resize requests after a terminal closes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      yield* manager.close({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        deleteHistory: true,
      });
      yield* manager.resize({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cols: 120,
        rows: 30,
      });

      expect(process.resizeCalls).toEqual([]);
    }),
  );

  it.effect("resizes running terminal on open when a different size is requested", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ cols: 100, rows: 24 }));
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const reopened = yield* manager.open(openInput({ cols: 120, rows: 30 }));

      assert.equal(reopened.status, "running");
      expect(process.resizeCalls).toEqual([{ cols: 120, rows: 30 }]);
    }),
  );

  it.effect("supports multiple terminals per thread independently", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "term-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      yield* manager.write({ threadId: "thread-1", terminalId: "default", data: "pwd\n" });
      yield* manager.write({ threadId: "thread-1", terminalId: "term-2", data: "ls\n" });

      expect(first.writes).toEqual(["pwd\n"]);
      expect(second.writes).toEqual(["ls\n"]);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
    }),
  );

  it.effect("clears transcript and emits cleared event", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* manager.clear({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID });
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );

      const events = yield* getEvents;
      expect(events.some((event) => event.type === "cleared")).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "cleared" &&
            event.threadId === "thread-1" &&
            event.terminalId === DEFAULT_TERMINAL_ID,
        ),
      ).toBe(true);
    }),
  );

  it.effect("restarts terminal with empty transcript and respawns pty", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;
      firstProcess.emitData("before restart\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      const snapshot = yield* manager.restart(restartInput());
      assert.equal(snapshot.history, "");
      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
          Effect.map((text) => text === ""),
        ),
      );
    }),
  );

  it.effect("restarts a running session when open is called with a different cwd", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const originalCwd = path.join(baseDir, "original");
      const differentCwd = path.join(baseDir, "different");
      yield* makeDirectory(originalCwd);
      yield* makeDirectory(differentCwd);

      yield* manager.open(openInput({ cwd: originalCwd }));
      const firstProcess = ptyAdapter.processes[0];
      expect(firstProcess).toBeDefined();
      if (!firstProcess) return;

      firstProcess.emitData("before reopen\n");
      const logPath = yield* historyLogPath(logsDir);
      yield* waitFor(pathExists(logPath));

      const reopened = yield* manager.open(openInput({ cwd: differentCwd }));

      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      assert.equal(firstProcess.killed, true);
      assert.equal(reopened.cwd, differentCwd);
      assert.equal(reopened.history, "");
      yield* waitFor(Effect.map(readFileString(logPath), (text) => text === ""));
    }),
  );

  it.effect("propagates explicit worktree metadata through snapshots and lifecycle events", () =>
    Effect.gen(function* () {
      const { manager, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const firstWorktreePath = path.join(baseDir, "worktrees", "feature-a");
      const secondWorktreePath = path.join(baseDir, "worktrees", "feature-b");
      yield* makeDirectory(firstWorktreePath);
      yield* makeDirectory(secondWorktreePath);
      const startedSnapshot = yield* manager.open(
        openInput({
          cwd: firstWorktreePath,
          worktreePath: firstWorktreePath,
        }),
      );
      const restartedSnapshot = yield* manager.restart(
        restartInput({
          cwd: secondWorktreePath,
          worktreePath: secondWorktreePath,
        }),
      );

      assert.equal(startedSnapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedSnapshot.worktreePath, secondWorktreePath);

      const events = yield* getEvents;
      const startedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
      );
      const restartedEvent = events.find(
        (event): event is Extract<TerminalEvent, { type: "restarted" }> =>
          event.type === "restarted",
      );

      assert.equal(startedEvent?.snapshot.worktreePath, firstWorktreePath);
      assert.equal(restartedEvent?.snapshot.worktreePath, secondWorktreePath);
    }),
  );

  it.effect("preserves worktree metadata when reopening an exited session", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const worktreePath = path.join(baseDir, "worktrees", "feature-a");
      yield* makeDirectory(worktreePath);

      yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );

      const reopenedSnapshot = yield* manager.open(
        openInput({
          cwd: worktreePath,
          worktreePath,
        }),
      );

      assert.equal(reopenedSnapshot.worktreePath, worktreePath);

      const events = yield* getEvents;
      const reopenedEvent = events
        .toReversed()
        .find(
          (event): event is Extract<TerminalEvent, { type: "started" }> => event.type === "started",
        );

      assert.equal(reopenedEvent?.snapshot.worktreePath, worktreePath);
    }),
  );

  it.effect("emits exited event and reopens with clean transcript after exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager();
      const path = yield* Path.Path;
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("old data\n");
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => events.some((event) => event.type === "exited")),
      );
      const reopened = yield* manager.open(openInput());

      assert.equal(reopened.history, "");
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(readFileString),
        ),
      ).toBe("");
    }),
  );

  it.effect("ignores trailing writes after terminal exit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitExit({ exitCode: 0, signal: 0 });

      yield* manager.write({
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        data: "\r",
      });
      expect(process.writes).toEqual([]);
    }),
  );

  it.effect("emits subprocess activity events when child-process state changes", () =>
    Effect.gen(function* () {
      let inspect: {
        readonly hasRunningSubprocess: boolean;
        readonly childCommand: string | null;
        readonly processIds: ReadonlyArray<number>;
      } = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      const { manager, getEvents } = yield* createManager(5, {
        subprocessInspector: () => Effect.succeed(inspect),
        subprocessPollIntervalMs: 20,
      });

      yield* manager.open(openInput());
      expect((yield* getEvents).some((event) => event.type === "activity")).toBe(false);

      inspect = { hasRunningSubprocess: true, childCommand: "vim", processIds: [100, 101] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      inspect = { hasRunningSubprocess: false, childCommand: null, processIds: [] };
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === false &&
              event.label === "Terminal 1",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("does not invoke subprocess polling until a terminal session is running", () =>
    Effect.gen(function* () {
      let checks = 0;
      const { manager } = yield* createManager(5, {
        subprocessInspector: () => {
          checks += 1;
          return Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          });
        },
        subprocessPollIntervalMs: 20,
      });

      yield* Effect.sleep("80 millis");
      assert.equal(checks, 0);

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.sync(() => checks > 0),
        "1200 millis",
      );
    }),
  );

  it.effect("derives subprocess activity for every terminal from one shared process snapshot", () =>
    Effect.gen(function* () {
      const runCalls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
      // FakePtyAdapter assigns pids starting at 9000, so the two terminals
      // opened below run as pids 9000 and 9001.
      const psStdout = ["  100  9000 vim", "  101   100 git", "  200  9001 /usr/bin/python3"].join(
        "\n",
      );
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) =>
          Effect.sync(() => {
            runCalls.push({ command: input.command, args: input.args });
            return {
              stdout: psStdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* manager.open(openInput({ threadId: "thread-2" }));

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) =>
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "vim",
            ) &&
            events.some(
              (event) =>
                event.type === "activity" &&
                event.hasRunningSubprocess === true &&
                event.label === "python3",
            ),
        ),
        "1200 millis",
      );
      yield* waitFor(
        Effect.sync(() => runCalls.length >= 3),
        "1200 millis",
      );

      // Every spawn is the shared table snapshot — no per-terminal `pgrep`
      // or per-child `ps -p` invocations.
      expect(runCalls.every((call) => call.args.join(" ") === "-eo pid=,ppid=,comm=")).toBe(true);
    }),
  );

  it.effect("keeps last known subprocess state when the process snapshot fails", () =>
    Effect.gen(function* () {
      let failSnapshots = false;
      let failedCalls = 0;
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Effect.sync(() => {
            if (failSnapshots) failedCalls += 1;
            return {
              stdout: failSnapshots ? "" : "  100  9000 vim",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(failSnapshots ? 1 : 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      failSnapshots = true;
      yield* waitFor(
        Effect.sync(() => failedCalls >= 3),
        "1200 millis",
      );

      // A failed snapshot is not authoritative: no terminal flips to idle.
      const activityEvents = (yield* getEvents).filter((event) => event.type === "activity");
      expect(activityEvents.length).toBeGreaterThan(0);
      expect(activityEvents.every((event) => event.hasRunningSubprocess === true)).toBe(true);
    }),
  );

  it("calculates snapshot failure backoff and success reset delays", () => {
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 0), 1_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 1), 2_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 2), 4_000);
    assert.equal(TerminalManager.subprocessSnapshotPollDelayMs(1_000, 30), 60_000);
  });

  it.effect("uses process snapshots from the resource monitor", () =>
    Effect.gen(function* () {
      let snapshotCalls = 0;
      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.sync(() => {
          snapshotCalls += 1;
          return [{ pid: 100, ppid: 9000, name: "ping.exe" }];
        }),
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));

      yield* manager.open(openInput());
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" && event.hasRunningSubprocess && event.label === "ping",
          ),
        ),
        "1200 millis",
      );
      expect(snapshotCalls).toBeGreaterThan(0);
    }),
  );

  it.effect("closes only a thread's idle shells, ignoring a helper forked from the shell", () =>
    Effect.gen(function* () {
      // FakePtyAdapter assigns pids from 9000 in open order.
      const { manager, ptyAdapter } = yield* createManager(5, {
        processTable: Effect.succeed([
          { pid: 9000, ppid: 1, name: "zsh" },
          // An async prompt worker: a copy of the shell with no children.
          { pid: 100, ppid: 9000, name: "zsh" },
          { pid: 9001, ppid: 1, name: "zsh" },
          { pid: 200, ppid: 9001, name: "node" },
          { pid: 9002, ppid: 1, name: "zsh" },
          // A subshell with a child is real work.
          { pid: 300, ppid: 9002, name: "zsh" },
          { pid: 301, ppid: 300, name: "sleep" },
          { pid: 9003, ppid: 1, name: "zsh" },
        ]),
      }).pipe(Effect.provide(layerWithHostPlatform("linux")));
      yield* manager.open(openInput({ terminalId: "idle" }));
      yield* manager.open(openInput({ terminalId: "dev-server" }));
      yield* manager.open(openInput({ terminalId: "subshell" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const closed = yield* manager.closeIdle({ threadId: "thread-1" });

      expect(closed).toEqual(["idle"]);
      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([
        true,
        false,
        false,
        false,
      ]);
    }),
  );

  it.effect("keeps terminals that get input or output while closeIdle checks them", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      // The typed command's process misses the snapshot, but its input or echo lands.
      let duringCheck: (pid: number) => Effect.Effect<void> = () => Effect.void;
      const { manager, getEvents } = yield* createManager(5, {
        ptyAdapter,
        subprocessPollIntervalMs: 60_000,
        subprocessInspector: (pid) =>
          duringCheck(pid).pipe(
            Effect.as({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
          ),
      });
      yield* manager.open(openInput({ terminalId: "typed" }));
      yield* manager.open(openInput({ terminalId: "echoed" }));
      const [typed, echoed] = ptyAdapter.processes;
      duringCheck = (pid) =>
        pid === typed!.pid
          ? manager
              .write({ threadId: "thread-1", terminalId: "typed", data: "make build\r" })
              .pipe(Effect.orDie)
          : Effect.gen(function* () {
              echoed!.emitData("make build\r\n");
              yield* waitFor(
                Effect.map(getEvents, (events) => events.some((event) => event.type === "output")),
              );
            }).pipe(Effect.orDie);

      const closed = yield* manager.closeIdle({ threadId: "thread-1" });

      expect(closed).toEqual([]);
      expect(ptyAdapter.processes.map((process) => process.killed)).toEqual([false, false]);
    }),
  );

  it.effect("backs off the spawned fallback when the resource monitor snapshot fails", () =>
    Effect.gen(function* () {
      const fallbackCalls: Array<number> = [];
      const processRunner: ProcessRunner.ProcessRunner["Service"] = {
        run: () =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              fallbackCalls.push(now);
              return {
                stdout: "  100  9000 vim",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrInvalidUtf8: false,
                stdoutInvalidUtf8: false,
                stderrTruncated: false,
              };
            }),
          ),
      };

      const { manager, getEvents } = yield* createManager(5, {
        subprocessPollIntervalMs: 20,
        processTable: Effect.fail("sidecar unavailable").pipe(
          Effect.mapError((cause) => cause as never),
        ),
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provide(layerWithHostPlatform("linux")),
      );

      yield* manager.open(openInput());
      // The fallback data is still applied while the sidecar is down.
      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some(
            (event) =>
              event.type === "activity" &&
              event.hasRunningSubprocess === true &&
              event.label === "vim",
          ),
        ),
        "1200 millis",
      );

      yield* waitFor(
        Effect.sync(() => fallbackCalls.length >= 4),
        "2000 millis",
      );
      // Four snapshots at the 20 ms base cadence would span ~60 ms. Backoff
      // (40 + 80 + 160 ms) stretches the same four snapshots past 150 ms, so
      // a stalled sidecar no longer hot-loops the spawned fallback.
      const spanMs = fallbackCalls[3]! - fallbackCalls[0]!;
      expect(spanMs).toBeGreaterThan(150);
    }),
  );

  it.effect("caps persisted history to configured line limit", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\nline2\nline3\nline4\n");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      const nonEmptyLines = reopened.history.split("\n").filter((line) => line.length > 0);
      expect(nonEmptyLines).toEqual(["line2", "line3", "line4"]);
    }),
  );

  it.effect("caps incrementally appended history without losing partial or empty lines", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(3);
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("line1\n");
      process.emitData("\n");
      process.emitData("line3");
      process.emitData("-continued\nline4");
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history).toBe("\nline3-continued\nline4");
    }),
  );

  it.effect("bounds persisted and attached history without truncating live output", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager(5, { historyByteLimit: 10 });
      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const writes = ["a".repeat(32), "😀\rEND"];
      const process = ptyAdapter.processes[0]!;
      for (const text of writes) process.emitData(text);
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(yield* historyLogPath(logsDir))).toBe("aa😀\rEND");

      const reopened = yield* manager.open(openInput());
      const events = yield* Ref.get(attachEvents);
      expect(events.filter((event) => event.type === "output").map((event) => event.data)).toEqual(
        writes,
      );
      const snapshot = events.filter((event) => event.type === "snapshot").at(-1)?.snapshot;
      expect(snapshot?.history).toBe("aa😀\rEND");
      expect(snapshot?.sequence).toBe(reopened.sequence);
    }),
  );

  it.effect.each(["current", "legacy"] as const)(
    "reads only a Unicode-safe tail from oversized %s history",
    (source) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        let sourcePath: string | undefined;
        let closedReads = 0;
        const readRequests: number[] = [];
        const trackedFileSystem = FileSystem.FileSystem.of({
          ...fs,
          readFileString: (candidate, encoding) =>
            candidate === sourcePath
              ? Effect.die("History restoration must not read the whole file")
              : fs.readFileString(candidate, encoding),
          open: (candidate, options) =>
            Effect.gen(function* () {
              if (candidate !== sourcePath) return yield* fs.open(candidate, options);
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closedReads += 1;
                }),
              );
              const file = yield* fs.open(candidate, options);
              return new Proxy(file, {
                get(target, key) {
                  if (key === "read") {
                    return (buffer: Uint8Array) => {
                      readRequests.push(buffer.byteLength);
                      return target.read(buffer.subarray(0, 5));
                    };
                  }
                  return Reflect.get(target, key, target);
                },
              });
            }),
        });
        const { manager, logsDir } = yield* createManager(5, { historyByteLimit: 15 }).pipe(
          Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
        );
        const nextPath = yield* historyLogPath(logsDir);
        sourcePath = source === "current" ? nextPath : path.join(logsDir, "thread-1.log");
        yield* fs.writeFileString(sourcePath, "old".repeat(32_768) + "😀\uFEFFnewest\ré");

        const snapshot = yield* manager.open(openInput());
        expect(snapshot.history).toBe("\uFEFFnewest\ré");
        expect(readRequests).toEqual([15, 10, 5]);
        expect(closedReads).toBe(1);
        expect(Buffer.from(yield* fs.readFile(nextPath)).toString()).toBe("\uFEFFnewest\ré");
        if (source === "legacy") expect(yield* fs.exists(sourcePath)).toBe(false);
        yield* manager.close({ threadId: "thread-1" });
        expect((yield* manager.open(openInput())).history).toBe("\uFEFFnewest\ré");
      }),
  );

  it.effect("strips replay-unsafe terminal query and reply sequences from persisted history", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      process.emitData("\u001b[32mok\u001b[0m ");
      process.emitData("\u001b]11;rgb:ffff/ffff/ffff\u0007");
      process.emitData("\u001b[1;1R");
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "prompt \u001b[32mok\u001b[0m done\n");
    }),
  );

  it.effect("strips replayable CSI and DCS traffic while preserving setters", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("prompt ");
      // DECRQM/DECRPM, XTVERSION, and kitty-keyboard CSI query/reply traffic.
      process.emitData("\u001b[?2026$p\u001b[?2026;2$y\u001b[>q\u001b[?u\u001b[?31u");
      // DECRQSS and XTGETTCAP query/reply traffic in 7-bit DCS form.
      process.emitData("\u001bP$q m\u001b\\\u001bP1$r0m\u001b\\");
      process.emitData("\u001bP+q544e\u001b\\\u001bP1+r544e=1b\u001b\\");
      // The same DCS traffic in 8-bit form.
      process.emitData("\u0090$q m\u009c\u00901$r0m\u009c");
      process.emitData("\u0090+q544e\u009c\u00901+r544e=1b\u009c");
      // Setters and cursor movement share final bytes with query families but
      // have visible terminal-state value and must survive replay.
      process.emitData('\u001b[!p\u001b["p\u001b[4 q\u001b[u');
      process.emitData("done\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, 'prompt \u001b[!p\u001b["p\u001b[4 q\u001b[udone\n');
    }),
  );

  it.effect.each([
    { name: "OSC", sequence: "\u001b]0;unfinished" },
    { name: "DCS", sequence: "\u001bPunfinished" },
    { name: "PM", sequence: "\u001b^unfinished" },
    { name: "APC", sequence: "\u001b_unfinished" },
    { name: "CSI", sequence: "\u001b[5" },
    { name: "C1 OSC", sequence: "\u009d0;unfinished" },
    { name: "C1 DCS", sequence: "\u0090unfinished" },
    { name: "C1 PM", sequence: "\u009eunfinished" },
    { name: "C1 APC", sequence: "\u009funfinished" },
    { name: "C1 CSI", sequence: "\u009b5" },
  ])("keeps output after a cancelled $name sequence in history", ({ sequence }) =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      for (const cancel of ["\u0018", "\u001a"]) {
        process.emitData(sequence);
        process.emitData(cancel);
        process.emitData("next line\n");
        process.emitData(`${sequence}${cancel}next line\n`);
      }
      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      expect(reopened.history.match(/next line/g)).toHaveLength(4);
    }),
  );

  it.effect("handles CSI and DCS query sequences split across output chunks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b[?2026$");
      process.emitData("pafter ");
      process.emitData("\u001bP$q ");
      process.emitData("m\u001b");
      process.emitData("\\after ");
      process.emitData("\u009b?3");
      process.emitData("1uafter ");
      process.emitData("\u0090+q544e");
      process.emitData("\u009cafter\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before after after after after\n");
    }),
  );

  it.effect(
    "preserves clear and style control sequences while dropping chunk-split query traffic",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before clear\n");
        process.emitData("\u001b[H\u001b[2J");
        process.emitData("prompt ");
        process.emitData("\u001b]11;");
        process.emitData("rgb:ffff/ffff/ffff\u0007\u001b[1;1");
        process.emitData("R\u001b[36mdone\u001b[0m\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(
          reopened.history,
          "before clear\n\u001b[H\u001b[2Jprompt \u001b[36mdone\u001b[0m\n",
        );
      }),
  );

  it.effect("does not leak final bytes from ESC sequences with intermediate bytes", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("before ");
      process.emitData("\u001b(B");
      process.emitData("after\n");

      yield* manager.close({ threadId: "thread-1" });

      const reopened = yield* manager.open(openInput());
      assert.equal(reopened.history, "before \u001b(Bafter\n");
    }),
  );

  it.effect(
    "preserves chunk-split ESC sequences with intermediate bytes without leaking final bytes",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager();
        yield* manager.open(openInput());
        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        process.emitData("before ");
        process.emitData("\u001b(");
        process.emitData("Bafter\n");

        yield* manager.close({ threadId: "thread-1" });

        const reopened = yield* manager.open(openInput());
        assert.equal(reopened.history, "before \u001b(Bafter\n");
      }),
  );

  it.effect("deletes history file when close(deleteHistory=true)", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;
      process.emitData("bye\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });
      expect(
        yield* historyLogPath(logsDir).pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("closes all terminals for a thread when close omits terminalId", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));
      const defaultProcess = ptyAdapter.processes[0];
      const sidecarProcess = ptyAdapter.processes[1];
      expect(defaultProcess).toBeDefined();
      expect(sidecarProcess).toBeDefined();
      if (!defaultProcess || !sidecarProcess) return;

      defaultProcess.emitData("default\n");
      sidecarProcess.emitData("sidecar\n");
      const path = yield* Path.Path;
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      yield* waitFor(
        multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );

      yield* manager.close({ threadId: "thread-1", deleteHistory: true });

      assert.equal(defaultProcess.killed, true);
      assert.equal(sidecarProcess.killed, true);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "default").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
      expect(
        yield* multiTerminalHistoryLogPath(logsDir, "thread-1", "sidecar").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      ).toBe(false);
    }),
  );

  it.effect("escalates terminal shutdown to SIGKILL when process does not exit in time", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeFiber = yield* manager.close({ threadId: "thread-1" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeFiber);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("skips SIGKILL when the process exits during the grace period", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { processKillGraceMs: 10_000 });
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      if (!process) return expect(process).toBeDefined();
      const sigterm = yield* Deferred.make<void>();
      process.onKill = (signal) => {
        if (signal === "SIGTERM") Deferred.doneUnsafe(sigterm, Effect.void);
      };

      yield* manager.close({ threadId: "thread-1" });
      yield* Deferred.await(sigterm);
      process.emitExit({ exitCode: 0, signal: 15 });
      yield* TestClock.adjust("10 seconds");

      assert.deepEqual(process.killSignals, ["SIGTERM"]);
      assert.equal(process.exitListenerCount, 0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases the exit listener when kill escalation is interrupted", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10_000,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      if (!process) return expect(process).toBeDefined();
      const sigterm = yield* Deferred.make<void>();
      process.onKill = (signal) => {
        if (signal === "SIGTERM") Deferred.doneUnsafe(sigterm, Effect.void);
      };

      yield* manager.close({ threadId: "thread-1" });
      yield* Deferred.await(sigterm);
      assert.isAbove(process.exitListenerCount, 0);

      yield* Scope.close(scope, Exit.void);

      assert.equal(process.exitListenerCount, 0);
      assert.deepEqual(process.killSignals, ["SIGTERM"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("publishes closed events when terminals are explicitly closed", () =>
    Effect.gen(function* () {
      const { manager, getEvents } = yield* createManager();
      yield* manager.open(openInput({ terminalId: "default" }));
      yield* manager.open(openInput({ terminalId: "sidecar" }));

      yield* manager.close({ threadId: "thread-1" });

      const closedEvents = (yield* getEvents).filter(
        (event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
      );
      expect(closedEvents.map((event) => event.terminalId).sort()).toEqual(["default", "sidecar"]);
    }),
  );

  it.effect("evicts oldest inactive terminal sessions when retention limit is exceeded", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, logsDir, getEvents } = yield* createManager(5, {
        maxRetainedInactiveSessions: 1,
      });

      yield* manager.open(openInput({ threadId: "thread-1" }));
      yield* manager.open(openInput({ threadId: "thread-2" }));

      const first = ptyAdapter.processes[0];
      const second = ptyAdapter.processes[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) return;

      first.emitData("first-history\n");
      second.emitData("second-history\n");
      const path = yield* Path.Path;
      yield* waitFor(
        historyLogPath(logsDir, "thread-1").pipe(
          Effect.provideService(Path.Path, path),
          Effect.flatMap(pathExists),
        ),
      );
      first.emitExit({ exitCode: 0, signal: 0 });
      yield* Effect.sleep(Duration.millis(5));
      second.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(
          getEvents,
          (events) => events.filter((event) => event.type === "exited").length === 2,
        ),
      );

      const reopenedSecond = yield* manager.open(openInput({ threadId: "thread-2" }));
      const reopenedFirst = yield* manager.open(openInput({ threadId: "thread-1" }));

      assert.equal(reopenedFirst.history, "first-history\n");
      assert.equal(reopenedSecond.history, "");
    }),
  );

  it.effect("migrates legacy transcript filenames to terminal-scoped history path on open", () =>
    Effect.gen(function* () {
      const { manager, logsDir } = yield* createManager();
      const path = yield* Path.Path;
      const legacyPath = path.join(logsDir, "thread-1.log");
      const nextPath = yield* historyLogPath(logsDir);
      yield* writeFileString(legacyPath, "legacy-line\n");

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.history, "legacy-line\n");
      expect(yield* pathExists(nextPath)).toBe(true);
      expect(yield* readFileString(nextPath)).toBe("legacy-line\n");
      expect(yield* pathExists(legacyPath)).toBe(false);
    }),
  );

  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );

  it.effect("prefers PowerShell over ComSpec for Windows terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs[0]).toEqual(
        expect.objectContaining({
          shell: "pwsh.exe",
          args: ["-NoLogo"],
        }),
      );
    }),
  );

  it.effect("preserves Windows Path casing when appending managed ACP binaries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "studio-terminal-acp-path-",
      });
      const installBin = path.join(
        cacheDir,
        "tools",
        "example-agent",
        "1.2.3",
        "windows-x86_64",
        "bin",
      );
      yield* fileSystem.makeDirectory(installBin, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(cacheDir, "acp-registry"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cacheDir, "acp-registry", "registry.json"),
        encodeUnknownJson({
          version: "1.0.0",
          agents: [
            {
              id: "example-agent",
              name: "Example Agent",
              version: "1.2.3",
              description: "ACP Registry test agent",
              distribution: {
                binary: {
                  "windows-x86_64": {
                    archive: "https://registry.test/example-agent.zip",
                    cmd: "bin/example-agent.exe",
                  },
                },
              },
            },
          ],
        }),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        managedBinaryCacheDir: cacheDir,
        managedBinaryToolsDir: path.join(cacheDir, "tools"),
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          Path: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerWithHostPlatform("win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
          ),
        ),
      );

      yield* manager.open(openInput());

      const spawnEnv = ptyAdapter.spawnInputs[0]?.env;
      expect(spawnEnv?.PATH).toBeUndefined();
      expect(spawnEnv?.Path).toBe(`C:\\Windows\\System32;${installBin}`);
    }),
  );

  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );

  it.effect.each(["linux", "darwin", "win32"] as const)(
    "advertises truecolor before the PTY backend on %s without replacing explicit values",
    (platform) =>
      Effect.gen(function* () {
        for (const [parentColor, runtimeColor, expected] of [
          [undefined, undefined, "truecolor"],
          ["", undefined, "truecolor"],
          ["24bit", undefined, "24bit"],
          ["24bit", "", ""],
          [undefined, "", ""],
          ["24bit", "custom", "custom"],
        ] as const) {
          const env = Object.freeze({ COLORTERM: parentColor });
          const { manager, ptyAdapter } = yield* createManager(5, {
            shellResolver: () => "/bin/sh",
            env,
          }).pipe(Effect.provide(layerWithHostPlatform(platform)));
          yield* manager.open(
            openInput({ env: runtimeColor === undefined ? {} : { COLORTERM: runtimeColor } }),
          );
          expect(ptyAdapter.spawnInputs[0]?.env.COLORTERM).toBe(expected);
          expect(env.COLORTERM).toBe(parentColor);
        }
      }),
  );

  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          STUDIO_PORT: "8319",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.STUDIO_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      // Arbitrary host env vars must pass through — terminals inherit the
      // user's environment apart from the explicit blocklist.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("expands provider home paths passed to setup terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5);

      yield* manager.open({
        ...openInput(),
        env: {
          CODEX_HOME: "~/.codex-work",
          CLAUDE_CONFIG_DIR: "~/.claude-work",
          CUSTOM_ACCOUNT: "~/leave-this-value-alone",
        },
      });

      const environment = ptyAdapter.spawnInputs[0]?.env;
      expect(environment?.CODEX_HOME).toMatch(/[\\/][.]codex-work$/);
      expect(environment?.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-work$/);
      expect(environment?.CUSTOM_ACCOUNT).toBe("~/leave-this-value-alone");
    }),
  );

  it.effect("starts a terminal opened at ~ in this machine's home folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-home-" });
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
      });
      yield* manager.open(openInput({ terminalId: "machine", cwd: "~" }));
      expect(ptyAdapter.spawnInputs.at(-1)?.cwd).toBe(home);
      // A missing folder whose fallback is "~" also lands in home.
      yield* manager.open(
        openInput({ terminalId: "machine-2", cwd: `${home}/missing`, fallbackCwd: "~" }),
      );
      expect(ptyAdapter.spawnInputs.at(-1)?.cwd).toBe(home);
    }),
  );

  it.effect("gives macOS terminals the launchd ssh-agent socket when the server has none", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const socketDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-ssh-agent-" });
      const agentSocket = `${socketDir}/Listeners`;
      yield* fs.writeFileString(agentSocket, "");
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
        launchctlGetenvSshAuthSock: Effect.succeed(agentSocket),
      });
      // The lookup runs in the background; each poll opens a new terminal.
      let attempt = 0;
      yield* waitFor(
        Effect.gen(function* () {
          attempt += 1;
          yield* manager.open(openInput({ terminalId: `agent-${attempt}` }));
          return ptyAdapter.spawnInputs.at(-1)?.env.SSH_AUTH_SOCK === agentSocket;
        }),
        "2 seconds",
      );
      // An explicit runtime value still wins.
      yield* manager.open(
        openInput({ terminalId: "agent-explicit", env: { SSH_AUTH_SOCK: "/tmp/explicit.sock" } }),
      );
      expect(ptyAdapter.spawnInputs.at(-1)?.env.SSH_AUTH_SOCK).toBe("/tmp/explicit.sock");
    }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_SpecWeaveStudioabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/Studio-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/Studio-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      // AppImage runtime markers must never reach the PTY — tools inside the
      // terminal otherwise resolve against the AppImage mount (e.g. PHP_BINARY
      // reporting the AppImage path instead of the real binary).
      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      // PATH/LD_LIBRARY_PATH keep the user's real entries but drop the AppImage
      // mount segments that the runtime prepended.
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      // XDG_DATA_DIRS keeps the host entries but drops the AppImage share dir.
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      // GSETTINGS_SCHEMA_DIR pointed only at the mount, so it is removed and
      // gsettings falls back to the host schema location.
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
      // Unrelated host vars still pass through untouched.
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );

  it.effect("leaves the environment untouched when not launched from an AppImage", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LD_LIBRARY_PATH: "/home/user/.local/lib",
          // Without APPIMAGE/APPDIR set, OWD is an ordinary variable and must
          // not be stripped — only an AppImage launch gives it special meaning.
          OWD: "/home/user/keep-this",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.OWD).toBe("/home/user/keep-this");
    }),
  );

  it.effect("injects runtime env overrides into spawned terminals", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, { env: { FORCE_COLOR: "3" } });
      yield* manager.open(
        openInput({
          env: {
            STUDIO_PROJECT_ROOT: "/repo",
            STUDIO_WORKTREE_PATH: "/repo/worktree-a",
            CUSTOM_FLAG: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        }),
      );
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      assert.equal(spawnInput.env.STUDIO_PROJECT_ROOT, "/repo");
      assert.equal(spawnInput.env.STUDIO_WORKTREE_PATH, "/repo/worktree-a");
      assert.equal(spawnInput.env.CUSTOM_FLAG, "1");
      assert.equal(spawnInput.env.NO_COLOR, "1");
      assert.equal(spawnInput.env.FORCE_COLOR, "0");
    }),
  );

  it.effect("resolves a provider instance environment before spawning", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { STUDIO_SECRET: "server-only" },
        resolveProviderInstanceEnvironment: (requestedId, env) =>
          Effect.succeed({
            ...env,
            PROVIDER_SECRET: requestedId === providerInstanceId ? "secret-value" : "wrong",
            CODEX_HOME: "/accounts/codex-work",
          }),
      });

      const snapshot = yield* manager.open(
        openInput({ providerInstanceId, env: { CLIENT_FLAG: "1" } }),
      );

      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("secret-value");
      expect(ptyAdapter.spawnInputs[0]?.env.CODEX_HOME).toBe("/accounts/codex-work");
      expect(ptyAdapter.spawnInputs[0]?.env.CLIENT_FLAG).toBe("1");
      expect(ptyAdapter.spawnInputs[0]?.env.STUDIO_SECRET).toBeUndefined();
      expect(snapshot).not.toHaveProperty("env");
      expect(snapshot).not.toHaveProperty("providerInstanceId");
    }),
  );

  it.effect("fails closed when a provider instance is missing", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager.open(openInput({ providerInstanceId })).pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("preserves the settings failure when provider environment resolution fails", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const settingsCause = new Error("secret store read failed");
      const settingsError = new ServerSettingsError({
        settingsPath: "/test/settings.json",
        operation: "read-secret",
        providerInstanceId,
        environmentVariable: "OPENROUTER_API_KEY",
        cause: settingsCause,
      });
      const serverSettings = ServerSettings.ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.fail(settingsError),
        updateSettings: () => Effect.fail(settingsError),
        updateProviderInstance: () => Effect.fail(settingsError),
        withSettingsSnapshot: () => Effect.fail(settingsError),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      });

      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: providerInstanceId,
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderEnvironmentError",
        providerInstanceId,
      });
      expect(error.cause).toBe(settingsError);
      expect(error.message).not.toContain(settingsError.message);
      expect(error.message).not.toContain("OPENROUTER_API_KEY");
    }),
  );

  it.effect.each([
    {
      name: "Codex home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex" },
      expectedHome: "/configured/codex",
    },
    {
      name: "Codex shadow home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex", shadowHomePath: "/configured/codex-shadow" },
      expectedHome: "/configured/codex-shadow",
    },
    {
      name: "Claude home",
      driver: "claudeAgent",
      variable: "CLAUDE_CONFIG_DIR",
      config: { homePath: "/configured/claude" },
      expectedHome: "/configured/claude",
    },
  ])("prefers $name over the instance environment", ({ driver, variable, config, expectedHome }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "configured_home",
        env: undefined,
      });

      expect(environment[variable]).toBe(path.resolve(expectedHome));
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("configured_home")]: {
              driver: ProviderDriverKind.make(driver),
              environment: [{ name: variable, value: "~/.environment-account", sensitive: false }],
              config,
            },
          },
        }),
      ),
    ),
  );

  it.effect("resolves the legacy Codex default instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-legacy$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {},
          providers: { codex: { homePath: "~/.codex-legacy" } },
        }),
      ),
    ),
  );

  it.effect("resolves the legacy Claude default instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "claudeAgent",
        env: undefined,
      });

      expect(environment.CLAUDE_CONFIG_DIR).toMatch(/[\\/][.]claude-legacy$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providerInstances: {},
          providers: { claudeAgent: { homePath: "~/.claude-legacy" } },
        }),
      ),
    ),
  );

  it.effect("prefers an explicit default instance over legacy provider settings", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex",
        env: undefined,
      });

      expect(environment.CODEX_HOME).toMatch(/[\\/][.]codex-explicit$/);
    }).pipe(
      Effect.provide(
        ServerSettings.ServerSettingsService.layerTest({
          providers: { codex: { homePath: "~/.codex-legacy" } },
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: "codex",
              config: { homePath: "~/.codex-explicit" },
            },
          },
        }),
      ),
    ),
  );

  it.effect("keeps unknown provider instance ids unavailable after legacy hydration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const error = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "codex_unknown",
        env: undefined,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "TerminalProviderInstanceNotFoundError",
        providerInstanceId: "codex_unknown",
      });
    }).pipe(Effect.provide(ServerSettings.ServerSettingsService.layerTest())),
  );

  it.effect("restarts a running terminal when the resolved provider environment changes", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerSecret = "first-secret";
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: () =>
          Effect.succeed({ PROVIDER_SECRET: providerSecret }),
      });

      yield* manager.open(openInput({ providerInstanceId }));
      providerSecret = "second-secret";
      yield* manager.open(openInput({ providerInstanceId }));

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env.PROVIDER_SECRET).toBe("second-secret");
    }),
  );

  it.effect("restarts with current provider secrets and clears bounded history", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const path = yield* Path.Path;
      const providerInstanceId = ProviderInstanceId.make("codex_restart");
      const { manager, ptyAdapter, logsDir } = yield* createManager(2, {
        historyByteLimit: 8,
        resolveProviderInstanceEnvironment: (rawProviderInstanceId, env) =>
          TerminalManager.resolveProviderInstanceTerminalEnvironment({
            serverSettings,
            path,
            rawProviderInstanceId,
            env,
          }),
      });
      const homePath = path.join(logsDir, "codex");
      const updateSecret = (value: string) =>
        serverSettings.updateSettings({
          providerInstances: {
            [providerInstanceId]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath },
              environment: [{ name: "PROVIDER_SECRET", value, sensitive: true }],
            },
          },
        });
      const input = {
        providerInstanceId,
        env: { CLIENT_FLAG: "1", PROVIDER_SECRET: "client-value" },
      };
      const outputProcessed = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(outputProcessed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* updateSecret("first-secret");
      yield* manager.restart(restartInput(input));
      const firstProcess = ptyAdapter.processes[0]!;
      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("first-secret");
      firstProcess.emitData("discarded\nold-one\nold-two\n");
      yield* Deferred.await(outputProcessed);
      expect((yield* manager.open(openInput(input))).history).toBe("old-two\n");

      yield* updateSecret("second-secret");
      const restarted = yield* manager.restart(restartInput(input));

      expect(firstProcess.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env).toMatchObject({
        PROVIDER_SECRET: "second-secret",
        CODEX_HOME: homePath,
        CLIENT_FLAG: "1",
      });
      expect(restarted.history).toBe("");
      expect(restarted.status).toBe("running");
      expect(restarted).not.toHaveProperty("env");
      expect(restarted).not.toHaveProperty("providerInstanceId");
      const logPath = yield* historyLogPath(logsDir);
      expect(yield* readFileString(logPath)).toBe("");

      ptyAdapter.processes[1]!.emitData("discarded again\nnew-one\nnew-two\n");
      yield* manager.close({ threadId: "thread-1" });
      expect(yield* readFileString(logPath)).toBe("new-two\n");
    }).pipe(
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "studio-terminal-provider-restart-" }),
          ),
        ),
      ),
    ),
  );

  it.effect("attaches to a running provider terminal without resolving the provider again", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerAvailable = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          providerAvailable
            ? Effect.succeed({ PROVIDER_SECRET: "secret-value" })
            : Effect.fail(
                new TerminalProviderInstanceNotFoundError({
                  providerInstanceId: ProviderInstanceId.make(requestedId),
                }),
              ),
      });
      yield* manager.open(openInput({ providerInstanceId }));
      providerAvailable = false;
      const events: TerminalAttachStreamEvent[] = [];

      const unsubscribe = yield* manager.attachStream(
        { ...openInput({ providerInstanceId }), restartIfNotRunning: true },
        (event) => Effect.sync(() => events.push(event)),
      );
      unsubscribe();

      expect(events[0]?.type).toBe("snapshot");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]?.killed).toBe(false);
    }),
  );

  it.effect("fails closed when attaching would create a missing provider terminal", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager
        .attachStream(openInput({ providerInstanceId }), () => Effect.void)
        .pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );

  it.effect("starts zsh with prompt spacer disabled to avoid `%` end markers", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) === "win32") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => "/bin/zsh",
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.args).toEqual(
        (yield* HostProcessPlatform) === "darwin"
          ? ["-l", "-o", "nopromptsp"]
          : ["-o", "nopromptsp"],
      );
    }),
  );

  it.effect("opens the account's login shell when the service has no SHELL", () =>
    Effect.gen(function* () {
      if ((yield* HostProcessPlatform) !== "darwin") return;
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      const loginShell = NodeOS.userInfo().shell || "/bin/zsh";
      expect(spawnInput.shell).toBe(loginShell);
      expect(spawnInput.args?.[0]).toBe("-l");
      expect(spawnInput.env.SHELL).toBe(loginShell);
    }),
  );

  it.effect("starts in the fallback folder when the thread's worktree is gone", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, baseDir } = yield* createManager();
      const path = yield* Path.Path;
      const projectRoot = path.join(baseDir, "project");
      const missingWorktree = path.join(baseDir, "worktrees", "removed");
      yield* makeDirectory(projectRoot);
      const input = openInput({
        cwd: missingWorktree,
        fallbackCwd: projectRoot,
        worktreePath: missingWorktree,
      });

      const opened = yield* manager.open(input);
      assert.equal(opened.cwd, projectRoot);
      assert.equal(ptyAdapter.spawnInputs[0]?.cwd, projectRoot);

      // Reopening with the same request keeps the running shell.
      yield* manager.open(input);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
    }),
  );

  it.effect("falls back to home when neither the folder nor the project root exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "studio-terminal-home-" });
      const { manager, ptyAdapter, baseDir } = yield* createManager(5, {
        env: { ...process.env, HOME: home },
      });
      const path = yield* Path.Path;

      const opened = yield* manager.open(
        openInput({
          cwd: path.join(baseDir, "missing-worktree"),
          fallbackCwd: path.join(baseDir, "missing-project"),
        }),
      );
      assert.equal(opened.cwd, home);
      assert.equal(ptyAdapter.spawnInputs[0]?.cwd, home);
    }),
  );

  it.effect("bridges PTY callbacks back into Effect-managed event streaming", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from callback\n");

      yield* waitFor(
        Effect.map(getEvents, (events) =>
          events.some((event) => event.type === "output" && event.data === "hello from callback\n"),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("pushes PTY callbacks to direct event subscribers", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      const subscriberEvents = yield* Ref.make<ReadonlyArray<TerminalEvent>>([]);
      const unsubscribe = yield* manager.subscribe((event) =>
        Ref.update(subscriberEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("hello from subscriber\n");

      yield* waitFor(
        Effect.map(Ref.get(subscriberEvents), (events) =>
          events.some(
            (event) => event.type === "output" && event.data === "hello from subscriber\n",
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("subscribes terminal metadata with an initial snapshot and live deltas", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const metadataEvents = yield* Ref.make<ReadonlyArray<TerminalMetadataStreamEvent>>([]);
      const unsubscribe = yield* manager.subscribeMetadata((event) =>
        Ref.update(metadataEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const initialEvents = yield* Ref.get(metadataEvents);
      expect(initialEvents[0]).toMatchObject({
        type: "snapshot",
        terminals: [
          {
            threadId: "existing-thread",
            terminalId: DEFAULT_TERMINAL_ID,
          },
        ],
      });

      yield* manager.open(openInput({ threadId: "new-thread" }));

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "upsert" &&
              event.terminal.threadId === "new-thread" &&
              event.terminal.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );

      yield* manager.close({ threadId: "new-thread", terminalId: DEFAULT_TERMINAL_ID });

      yield* waitFor(
        Effect.map(Ref.get(metadataEvents), (events) =>
          events.some(
            (event) =>
              event.type === "remove" &&
              event.threadId === "new-thread" &&
              event.terminalId === DEFAULT_TERMINAL_ID,
          ),
        ),
        "1200 millis",
      );
    }),
  );

  it.effect("removes terminal metadata subscriptions when initial delivery fails", () =>
    Effect.gen(function* () {
      const { manager } = yield* createManager();
      yield* manager.open(openInput({ threadId: "existing-thread" }));

      const leakedLiveEvents = yield* Ref.make(0);
      const exit = yield* Effect.exit(
        manager.subscribeMetadata((event) =>
          event.type === "snapshot"
            ? Effect.die("snapshot listener failed")
            : Ref.update(leakedLiveEvents, (count) => count + 1),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);

      yield* manager.open(openInput({ threadId: "new-thread" }));
      expect(yield* Ref.get(leakedLiveEvents)).toBe(0);
    }),
  );

  it.effect(
    "streams attach snapshots followed by live events without duplicate start snapshots",
    () =>
      Effect.gen(function* () {
        const { manager, ptyAdapter } = yield* createManager(5, {
          ptyAdapter: new FakePtyAdapter("async"),
        });
        const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
        const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
          Ref.update(attachEvents, (events) => [...events, event]),
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const process = ptyAdapter.processes[0];
        expect(process).toBeDefined();
        if (!process) return;

        expect(yield* Ref.get(attachEvents)).toMatchObject([
          {
            type: "snapshot",
            snapshot: {
              threadId: "thread-1",
              terminalId: DEFAULT_TERMINAL_ID,
            },
          },
        ]);

        process.emitData("hello from attach\n");

        yield* waitFor(
          Effect.map(Ref.get(attachEvents), (events) =>
            events.some((event) => event.type === "output" && event.data === "hello from attach\n"),
          ),
          "1200 millis",
        );

        const events = yield* Ref.get(attachEvents);
        expect(events.filter((event) => event.type === "snapshot")).toHaveLength(1);
      }),
  );

  it.effect("observes terminal history and live output without changing the process", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const opened = yield* manager.open(openInput({ env: { OBSERVER_TEST: "original" } }));
      const process = ptyAdapter.processes[0]!;
      const historyReceived = yield* Deferred.make<void>();
      const unsubscribeHistory = yield* manager.subscribe((event) =>
        event.type === "output"
          ? Deferred.succeed(historyReceived, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitData("existing history\n");
      yield* Deferred.await(historyReceived);
      unsubscribeHistory();

      const observed = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const liveReceived = yield* Deferred.make<void>();
      const unsubscribe = yield* manager.observeStream(
        { threadId: opened.threadId, terminalId: opened.terminalId },
        (event) =>
          Ref.update(observed, (events) => [...events, event]).pipe(
            Effect.andThen(
              event.type === "output"
                ? Deferred.succeed(liveReceived, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      process.emitData("live output\n");
      yield* Deferred.await(liveReceived);

      expect(yield* Ref.get(observed)).toMatchObject([
        {
          type: "snapshot",
          snapshot: {
            cwd: opened.cwd,
            worktreePath: opened.worktreePath,
            pid: opened.pid,
            history: "existing history\n",
          },
        },
        { type: "output", data: "live output\n" },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.spawnInputs[0]?.env.OBSERVER_TEST).toBe("original");
      expect(process.resizeCalls).toEqual([]);
      expect(process.writes).toEqual([]);
      expect(process.killSignals).toEqual([]);
    }),
  );

  it.effect("observes exited terminals without restarting and rejects missing sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager();
      const missingEvents: TerminalAttachStreamEvent[] = [];
      const missing = yield* manager
        .observeStream({ threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID }, (event) =>
          Effect.sync(() => {
            missingEvents.push(event);
          }),
        )
        .pipe(Effect.flip);
      expect(missing._tag).toBe("TerminalSessionLookupError");
      expect(ptyAdapter.spawnInputs).toEqual([]);

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0]!;
      const exited = yield* Deferred.make<void>();
      const unsubscribeExit = yield* manager.subscribe((event) =>
        event.type === "exited"
          ? Deferred.succeed(exited, undefined).pipe(Effect.asVoid)
          : Effect.void,
      );
      process.emitExit({ exitCode: 7, signal: 0 });
      yield* Deferred.await(exited);
      unsubscribeExit();

      const events: TerminalAttachStreamEvent[] = [];
      const unsubscribe = yield* manager.observeStream(
        { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID },
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      );
      unsubscribe();
      expect(events).toMatchObject([
        { type: "snapshot", snapshot: { status: "exited", exitCode: 7, pid: null } },
      ]);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(process.resizeCalls).toEqual([]);
      expect(process.writes).toEqual([]);
      expect(process.killSignals).toEqual([]);
      expect(missingEvents).toEqual([]);
    }),
  );

  it.effect("buffers attach output delivered during the initial snapshot callback", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });
      yield* manager.open(openInput());

      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(openInput(), (event) =>
        Effect.gen(function* () {
          yield* Ref.update(attachEvents, (events) => [...events, event]);
          if (event.type === "snapshot") {
            yield* Effect.sync(() => process.emitData("during snapshot\n"));
            yield* Effect.yieldNow;
          }
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      yield* waitFor(
        Effect.map(Ref.get(attachEvents), (events) =>
          events.some((event) => event.type === "output" && event.data === "during snapshot\n"),
        ),
        "1200 millis",
      );

      expect(yield* Ref.get(attachEvents)).toMatchObject([
        { type: "snapshot" },
        { type: "output", data: "during snapshot\n" },
      ]);
    }),
  );

  it.effect("preserves queued PTY output ordering through exit callbacks", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, getEvents } = yield* createManager(5, {
        ptyAdapter: new FakePtyAdapter("async"),
      });

      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      process.emitData("first\n");
      process.emitData("second\n");
      process.emitExit({ exitCode: 0, signal: 0 });

      yield* waitFor(
        Effect.map(getEvents, (events) => {
          const relevant = events.filter(
            (event) => event.type === "output" || event.type === "exited",
          );
          return relevant.length >= 3;
        }),
        "1200 millis",
      );

      const relevant = (yield* getEvents).filter(
        (event) => event.type === "output" || event.type === "exited",
      );
      expect(relevant).toEqual([
        expect.objectContaining({ type: "output", data: "first\n", sequence: 2 }),
        expect.objectContaining({ type: "output", data: "second\n", sequence: 3 }),
        expect.objectContaining({ type: "exited", exitCode: 0, exitSignal: 0, sequence: 4 }),
      ]);

      const attachEvents = yield* Ref.make<ReadonlyArray<TerminalAttachStreamEvent>>([]);
      const unsubscribe = yield* manager.attachStream(
        {
          threadId: "thread-1",
          terminalId: DEFAULT_TERMINAL_ID,
        },
        (event) => Ref.update(attachEvents, (events) => [...events, event]),
      );
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

      const snapshot = (yield* Ref.get(attachEvents)).find((event) => event.type === "snapshot");
      expect(snapshot).toBeDefined();
      if (!snapshot || snapshot.type !== "snapshot") return;
      expect(snapshot.snapshot.sequence).toBe(4);
    }),
  );

  it.effect("scoped runtime shutdown stops active terminals cleanly", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      const { manager, ptyAdapter } = yield* createManager(5, {
        processKillGraceMs: 10,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* manager.open(openInput());
      const process = ptyAdapter.processes[0];
      expect(process).toBeDefined();
      if (!process) return;

      const closeScope = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 millis");
      yield* Fiber.join(closeScope);

      assert.equal(process.killSignals[0], "SIGTERM");
      expect(process.killSignals).toContain("SIGKILL");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "does not leak staged elevated-run artifacts when cwd validation fails or PTY spawn fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({ prefix: "elevated-runs-" });
        const missingCwd = path.join(elevatedRunsDir, "does-not-exist");

        let prepareCalls = 0;
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          prepareElevatedRun: async (input) => {
            prepareCalls += 1;
            return prepareElevatedRunHandle(input);
          },
        });

        for (const elevation of [
          { nonce: "nonce-cwd-1" },
          { nonce: "nonce-cwd-2", openIn: "terminal-app" as const },
        ]) {
          const exit = yield* Effect.exit(
            manager.open(
              openInput({
                terminalId: "run-cwd-fail",
                cwd: missingCwd,
                command: "sudo id",
                elevation,
              }),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual([]);
        }
        expect(prepareCalls).toBe(0);

        for (const elevation of [
          { nonce: "nonce-spawn-1" },
          { nonce: "nonce-spawn-2", openIn: "terminal-app" as const },
        ]) {
          ptyAdapter.spawnFailures.push(
            ...Array.from({ length: 10 }, () => new Error("spawn failed")),
          );
          const snapshot = yield* manager.open(
            openInput({
              terminalId: "run-spawn-fail",
              command: "sudo id",
              elevation,
            }),
          );
          expect(snapshot.status).toBe("error");
          expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual([]);
        }
        expect(prepareCalls).toBe(2);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect("cleans up staged elevated-run artifacts when open is interrupted during staging", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "elevated-runs-interrupt-",
      });

      for (const elevation of [
        { nonce: "nonce-interrupt-1" },
        { nonce: "nonce-interrupt-2", openIn: "terminal-app" as const },
      ]) {
        let releaseStaging!: () => void;
        const stagingStarted = yield* Deferred.make<void>();
        const stagingGate = new Promise<void>((resolve) => {
          releaseStaging = resolve;
        });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          prepareElevatedRun: async (input) => {
            const staged = await prepareElevatedRunHandle(input);
            Deferred.doneUnsafe(stagingStarted, Effect.void);
            await stagingGate;
            return staged;
          },
        });

        const fiber = yield* Effect.forkChild(
          manager.open(
            openInput({
              terminalId: "run-interrupt",
              command: "sudo id",
              elevation,
            }),
          ),
        );
        yield* Deferred.await(stagingStarted);
        expect((yield* fs.readDirectory(elevatedRunsDir)).length).toBeGreaterThan(0);

        const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.yieldNow;
        releaseStaging();
        yield* Fiber.join(interruptFiber);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(ptyAdapter.spawnInputs).toHaveLength(0);
        expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual([]);
      }
    }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "preserves staged elevated-run artifacts when open is interrupted after PTY spawn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-post-spawn-interrupt-",
        });

        for (const elevation of [
          { nonce: "nonce-post-spawn-1" },
          { nonce: "nonce-post-spawn-2", openIn: "terminal-app" as const },
        ]) {
          const spawned = yield* Deferred.make<void>();
          const ptyAdapter = new FakePtyAdapter();
          const { manager } = yield* createManager(5, {
            ptyAdapter,
            elevatedRunsDir,
          });
          const unsubscribe = yield* manager.subscribe((event) =>
            event.type === "started"
              ? Effect.gen(function* () {
                  yield* Deferred.succeed(spawned, undefined);
                  return yield* Effect.never;
                })
              : Effect.void,
          );

          try {
            const fiber = yield* Effect.forkChild(
              manager.open(
                openInput({
                  terminalId: "run-post-spawn-interrupt",
                  command: "sudo id",
                  elevation,
                }),
              ),
            );
            yield* Deferred.await(spawned);
            expect(ptyAdapter.spawnInputs).toHaveLength(1);
            const entriesBeforeInterrupt = yield* fs.readDirectory(elevatedRunsDir);
            expect(entriesBeforeInterrupt.length).toBeGreaterThan(0);

            yield* Fiber.interrupt(fiber);
            const exit = yield* Fiber.await(fiber);
            expect(Exit.isFailure(exit)).toBe(true);
            expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual(entriesBeforeInterrupt);
          } finally {
            unsubscribe();
          }
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "tracks a spawned PTY and preserves staged elevated-run artifacts when open is interrupted mid-spawn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-mid-spawn-interrupt-",
        });
        const spawnStarted = yield* Deferred.make<void>();
        let releaseSpawn!: () => void;
        const spawnGate = new Promise<void>((resolve) => {
          releaseSpawn = resolve;
        });

        class DelayedSpawnPtyAdapter extends FakePtyAdapter {
          override spawn(input: PtyAdapter.PtySpawnInput) {
            return Effect.suspend(() => {
              const inner = super.spawn(input);
              return Effect.gen(function* () {
                const proc = yield* inner;
                Deferred.doneUnsafe(spawnStarted, Effect.void);
                yield* Effect.promise(() => spawnGate);
                return proc;
              });
            });
          }
        }

        const ptyAdapter = new DelayedSpawnPtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
        });

        const fiber = yield* Effect.forkChild(
          manager.open(
            openInput({
              terminalId: "run-mid-spawn-interrupt",
              command: "sudo id",
              elevation: { nonce: "nonce-mid-spawn" },
            }),
          ),
        );
        yield* Deferred.await(spawnStarted);
        const entriesBeforeInterrupt = yield* fs.readDirectory(elevatedRunsDir);
        expect(entriesBeforeInterrupt.length).toBeGreaterThan(0);

        const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Effect.yieldNow;
        releaseSpawn();
        yield* Fiber.join(interruptFiber);
        yield* Fiber.await(fiber);

        expect(ptyAdapter.processes).toHaveLength(1);
        expect(ptyAdapter.processes[0]?.killed).toBe(false);
        expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual(entriesBeforeInterrupt);

        // The spawned PTY is registered in the manager and can be closed cleanly.
        const spawnedProc = ptyAdapter.processes[0]!;
        spawnedProc.onKill = () => {
          spawnedProc.emitExit({ exitCode: 0, signal: 15 });
        };
        yield* manager.close({ threadId: "thread-1", terminalId: "run-mid-spawn-interrupt" });
        expect(spawnedProc.killed).toBe(true);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect("never falls back to HOME or a stale worktreePath for elevated opens", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "elevated-runs-cwd-",
      });
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "elevated-runs-home-" });
      const fallbackCwd = yield* fs.makeTempDirectoryScoped({
        prefix: "elevated-runs-fallback-",
      });
      const missingWorktree = path.join(elevatedRunsDir, "removed-worktree");
      const missingFallback = path.join(elevatedRunsDir, "removed-project");

      const stagedCwds: Array<string | undefined> = [];
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        elevatedRunsDir,
        env: { ...process.env, HOME: home },
        prepareElevatedRun: async (input) => {
          stagedCwds.push(input.cwd);
          return prepareElevatedRunHandle(input);
        },
      });

      // Both cwd and fallbackCwd missing: must fail closed before staging, never fall back to HOME.
      for (const elevation of [
        { nonce: "nonce-no-home-1" },
        { nonce: "nonce-no-home-2", openIn: "terminal-app" as const },
      ]) {
        const exit = yield* Effect.exit(
          manager.open(
            openInput({
              terminalId: "run-no-home",
              cwd: missingWorktree,
              fallbackCwd: missingFallback,
              worktreePath: missingWorktree,
              command: "sudo id",
              elevation,
            }),
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(stagedCwds).toEqual([]);
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
      expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual([]);

      // Removed worktree with existing fallbackCwd: must resolve to fallbackCwd and drop stale worktreePath.
      const opened = yield* manager.open(
        openInput({
          terminalId: "run-fallback-cwd",
          cwd: missingWorktree,
          fallbackCwd,
          worktreePath: missingWorktree,
          command: "sudo id",
          elevation: { nonce: "nonce-fallback", openIn: "terminal-app" },
        }),
      );
      expect(opened.cwd).toBe(fallbackCwd);
      expect(opened.worktreePath).toBeNull();
      expect(stagedCwds).toEqual([fallbackCwd]);
      expect(ptyAdapter.spawnInputs[0]?.cwd).toBe(fallbackCwd);
    }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "coalesces same-mode elevated opens while letting prompt switch to Terminal.app and plain runs escalate",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-overlap-",
        });
        let prepareCalls = 0;
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          prepareElevatedRun: async (input) => {
            prepareCalls += 1;
            return prepareElevatedRunHandle(input);
          },
        });

        const first = yield* manager.open(
          openInput({
            terminalId: "run-overlap",
            command: "sudo id",
            elevation: {},
          }),
        );
        const firstProc = ptyAdapter.processes[0]!;
        expect(prepareCalls).toBe(1);

        // Overlapping same-mode (prompt -> prompt) elevated open from another tab/device
        // coalesces without killing the running prompt or staging a second run.
        const second = yield* manager.open(
          openInput({
            terminalId: "run-overlap",
            command: "sudo id",
            elevation: {},
          }),
        );
        expect(second.pid).toBe(first.pid);
        expect(firstProc.killed).toBe(false);
        expect(prepareCalls).toBe(1);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);

        // Switching an active prompt run to Terminal.app must replace the active prompt run.
        firstProc.onKill = () => {
          firstProc.emitExit({ exitCode: 0, signal: 15 });
        };
        const terminalApp = yield* manager.open(
          openInput({
            terminalId: "run-overlap",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        const terminalAppProc = ptyAdapter.processes[1]!;
        expect(firstProc.killed).toBe(true);
        expect(terminalApp.pid).not.toBe(first.pid);
        expect(prepareCalls).toBe(2);
        expect(ptyAdapter.spawnInputs).toHaveLength(2);

        // Overlapping same-mode (terminal-app -> terminal-app) coalesces.
        const terminalAppAgain = yield* manager.open(
          openInput({
            terminalId: "run-overlap",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        expect(terminalAppAgain.pid).toBe(terminalApp.pid);
        expect(terminalAppProc.killed).toBe(false);
        expect(prepareCalls).toBe(2);

        // Escalating an active plain run (e.g. a script that printed Password:) must still work.
        yield* manager.open(
          openInput({
            terminalId: "run-script",
            command: "./install.sh",
          }),
        );
        const plainProc = ptyAdapter.processes[2]!;
        plainProc.onKill = () => {
          plainProc.emitExit({ exitCode: 0, signal: 15 });
        };
        const escalated = yield* manager.open(
          openInput({
            terminalId: "run-script",
            command: "./install.sh",
            elevation: {},
          }),
        );
        expect(plainProc.killed).toBe(true);
        expect(escalated.pid).not.toBe(plainProc.pid);
        expect(prepareCalls).toBe(3);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "spawns elevated runs via /bin/sh with scrubbed rc env, keeps nonces server-only, and filters OSC 7717 server-side",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-server-osc-",
        });
        const serverNonces: Array<string> = [];
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          env: {
            SHELL: "/bin/zsh",
            ENV: "/tmp/poison-env",
            BASH_ENV: "/tmp/poison-bash-env",
            ZDOTDIR: "/tmp/poison-zdotdir",
          },
          prepareElevatedRun: async (input) => {
            if (input.elevation.nonce) {
              serverNonces.push(input.elevation.nonce);
            }
            return prepareElevatedRunHandle(input);
          },
        });
        const events: Array<TerminalEvent> = [];
        const unsubscribe = yield* manager.subscribe((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        );
        try {
          const opened = yield* manager.open(
            openInput({
              terminalId: "run-server-osc",
              command: "sudo id",
              env: {
                ENV: "/tmp/input-env",
                BASH_ENV: "/tmp/input-bash-env",
                ZDOTDIR: "/tmp/input-zdotdir",
              },
              elevation: { nonce: "ClientSuppliedShouldIgnore" },
            }),
          );
          const serverNonce = serverNonces[0]!;
          expect(serverNonce).toMatch(/^[a-f0-9]{32}$/);
          expect(serverNonce).not.toBe("ClientSuppliedShouldIgnore");

          // Wrapper runs directly under /bin/sh with startup rc env vars scrubbed, keeping SHELL.
          const spawnInput = ptyAdapter.spawnInputs[0]!;
          expect(spawnInput.shell).toBe("/bin/sh");
          expect(spawnInput.args?.[0]).toBe("-c");
          expect(spawnInput.env.SHELL).toBe("/bin/zsh");
          expect(spawnInput.env.ENV).toBeUndefined();
          expect(spawnInput.env.BASH_ENV).toBeUndefined();
          expect(spawnInput.env.ZDOTDIR).toBeUndefined();

          // Nonce is never returned in open(), started event, or observe().
          expect(opened.elevationNonce).toBeUndefined();
          expect(opened.elevationState).toBeUndefined();
          const startedEvent = events.find(
            (event): event is Extract<TerminalEvent, { type: "started" }> =>
              event.type === "started" && event.terminalId === "run-server-osc",
          );
          expect(startedEvent?.snapshot.elevationNonce).toBeUndefined();

          const proc = ptyAdapter.processes[0]!;
          // Emit a chunk-split valid waiting marker, a spoofed marker (wrong nonce + 8-bit),
          // a valid started marker, and a late marker carrying the real nonce.
          proc.emitData(`\u001b]7717;elevation=wait`);
          proc.emitData(`ing;${serverNonce}\u0007`);
          proc.emitData(
            `hello \u001b]7717;elevation=cancelled;wrongnonce\u0007\u009d7717;elevation=denied;${serverNonce}\u0007`,
          );
          proc.emitData(`\u001b]7717;elevation=started;${serverNonce}\u0007world`);
          proc.emitData(`\u001b]7717;elevation=cancelled;${serverNonce}\u0007!`);

          const outputText = events
            .filter(
              (event): event is Extract<TerminalEvent, { type: "output" }> =>
                event.type === "output" && event.terminalId === "run-server-osc",
            )
            .map((event) => event.data)
            .join("");

          // Raw nonce never leaks into live output or snapshot history.
          expect(outputText).not.toContain(serverNonce);
          expect(outputText).not.toContain("wrongnonce");
          expect(outputText).not.toContain("\u009d");
          expect(outputText).toBe(
            "\u001b]7717;elevation=waiting\u0007hello \u001b]7717;elevation=started\u0007world!",
          );

          const observedEvents: Array<
            TerminalEvent | { type: "snapshot"; snapshot: TerminalSessionSnapshot }
          > = [];
          const stopObserve = yield* manager.observeStream(
            {
              threadId: "thread-1",
              terminalId: "run-server-osc",
            },
            (event) =>
              Effect.sync(() => {
                if (event.type === "snapshot") {
                  observedEvents.push(event);
                }
              }),
          );
          stopObserve();
          const observed = observedEvents.find(
            (event): event is { type: "snapshot"; snapshot: TerminalSessionSnapshot } =>
              event.type === "snapshot",
          )?.snapshot;
          expect(observed).toBeDefined();
          expect(observed?.elevationNonce).toBeUndefined();
          expect(observed?.elevationState).toBe("started");
          expect(observed?.history).not.toContain(serverNonce);
          expect(observed?.history).toContain("\u001b]7717;elevation=started\u0007");

          // Plain sessions strip all OSC 7717 markers (7-bit and 8-bit) and never set elevationState.
          yield* manager.open(
            openInput({
              terminalId: "run-plain-osc",
              command: "echo plain",
            }),
          );
          const plainProc = ptyAdapter.processes[1]!;
          plainProc.emitData(
            "before\u001b]7717;elevation=cancelled\u0007mid\u009d7717;elevation=started\u0007after",
          );
          const plainObservedSnapshots: Array<TerminalSessionSnapshot> = [];
          const stopPlainObserve = yield* manager.observeStream(
            {
              threadId: "thread-1",
              terminalId: "run-plain-osc",
            },
            (event) =>
              Effect.sync(() => {
                if (event.type === "snapshot") {
                  plainObservedSnapshots.push(event.snapshot);
                }
              }),
          );
          stopPlainObserve();
          const plainObserved = plainObservedSnapshots[0];
          expect(plainObserved).toBeDefined();
          expect(plainObserved?.elevationState).toBeUndefined();
          expect(plainObserved?.history).toBe("beforemidafter");
        } finally {
          unsubscribe();
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "clears a stale liveSession.worktreePath when reopening an elevated run after worktree removal or omitted worktreePath",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-stale-wt-",
        });
        const fallbackCwd = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-stale-wt-root-",
        });
        const worktreeDir = path.join(fallbackCwd, "worktree");
        yield* fs.makeDirectory(worktreeDir, { recursive: true });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
        });

        // Initial run binds liveSession.worktreePath to the existing worktree.
        const initial = yield* manager.open(
          openInput({
            terminalId: "run-stale-wt",
            cwd: worktreeDir,
            fallbackCwd,
            worktreePath: worktreeDir,
            command: "sudo id",
            elevation: {},
          }),
        );
        expect(initial.cwd).toBe(worktreeDir);
        expect(initial.worktreePath).toBe(worktreeDir);

        // Switching back to the project root with omitted worktreePath must not inherit the old worktreePath.
        ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });
        const rootRun = yield* manager.open(
          openInput({
            terminalId: "run-stale-wt",
            cwd: fallbackCwd,
            command: "sudo id",
            elevation: {},
          }),
        );
        expect(rootRun.cwd).toBe(fallbackCwd);
        expect(rootRun.worktreePath).toBeNull();

        // Re-bind to the worktree, then remove it and reopen with omitted worktreePath.
        ptyAdapter.processes[1]!.emitExit({ exitCode: 0, signal: 0 });
        yield* manager.open(
          openInput({
            terminalId: "run-stale-wt",
            cwd: worktreeDir,
            fallbackCwd,
            worktreePath: worktreeDir,
            command: "sudo id",
            elevation: {},
          }),
        );
        ptyAdapter.processes[2]!.emitExit({ exitCode: 0, signal: 0 });
        yield* fs.remove(worktreeDir, { recursive: true });

        // Reopening the same terminalId (even with worktreePath omitted) must fall back to fallbackCwd
        // and clear worktreePath to null.
        const reopened = yield* manager.open(
          openInput({
            terminalId: "run-stale-wt",
            cwd: worktreeDir,
            fallbackCwd,
            command: "sudo id",
            elevation: {},
          }),
        );
        expect(reopened.cwd).toBe(fallbackCwd);
        expect(reopened.worktreePath).toBeNull();
        expect(ptyAdapter.spawnInputs[3]?.cwd).toBe(fallbackCwd);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "preserves split OSC 7717 parsing across clear() so the raw elevation nonce never leaks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-clear-osc-",
        });
        const serverNonces: Array<string> = [];
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          prepareElevatedRun: async (input) => {
            if (input.elevation.nonce) {
              serverNonces.push(input.elevation.nonce);
            }
            return prepareElevatedRunHandle(input);
          },
        });
        const events: Array<TerminalEvent> = [];
        const unsubscribe = yield* manager.subscribe((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        );
        try {
          yield* manager.open(
            openInput({
              terminalId: "run-clear-osc",
              command: "sudo id",
              elevation: {},
            }),
          );
          const serverNonce = serverNonces[0]!;
          const proc = ptyAdapter.processes[0]!;

          // Split an OSC 7717 marker across clear(): the first half buffers the partial control sequence,
          // clear() resets history, and the second half must finish parsing without leaking the nonce.
          proc.emitData(`before\u001b]7717;elevation=wait`);
          yield* manager.clear({ threadId: "thread-1", terminalId: "run-clear-osc" });
          proc.emitData(`ing;${serverNonce}\u0007after`);

          const outputText = events
            .filter(
              (event): event is Extract<TerminalEvent, { type: "output" }> =>
                event.type === "output" && event.terminalId === "run-clear-osc",
            )
            .map((event) => event.data)
            .join("");
          expect(outputText).not.toContain(serverNonce);
          expect(outputText).toContain("\u001b]7717;elevation=waiting\u0007after");

          const observedSnapshots: Array<TerminalSessionSnapshot> = [];
          const stopObserve = yield* manager.observeStream(
            { threadId: "thread-1", terminalId: "run-clear-osc" },
            (event) =>
              Effect.sync(() => {
                if (event.type === "snapshot") {
                  observedSnapshots.push(event.snapshot);
                }
              }),
          );
          stopObserve();
          const observed = observedSnapshots[0];
          expect(observed?.elevationState).toBe("waiting");
          expect(observed?.history).not.toContain(serverNonce);
          expect(observed?.history).toBe("\u001b]7717;elevation=waiting\u0007after");
        } finally {
          unsubscribe();
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "populates SHELL from the resolved shell when starting elevated runs without process.env.SHELL",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-launchd-shell-",
        });
        const stagedShells: Array<string | undefined> = [];
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          env: { PATH: "/usr/bin:/bin" },
          shellResolver: () => "/bin/zsh",
          prepareElevatedRun: async (input) => {
            stagedShells.push(input.shell);
            return prepareElevatedRunHandle(input);
          },
        });

        yield* manager.open(
          openInput({
            terminalId: "run-launchd-prompt",
            command: "sudo id",
            elevation: {},
          }),
        );
        expect(ptyAdapter.spawnInputs[0]?.shell).toBe("/bin/sh");
        expect(ptyAdapter.spawnInputs[0]?.env.SHELL).toBe("/bin/zsh");

        yield* manager.open(
          openInput({
            terminalId: "run-launchd-terminal-app",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        expect(ptyAdapter.spawnInputs[1]?.shell).toBe("/bin/sh");
        expect(ptyAdapter.spawnInputs[1]?.env.SHELL).toBe("/bin/zsh");
        expect(stagedShells).toEqual(["/bin/zsh", "/bin/zsh"]);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "does not coalesce same-mode elevated opens when cwd, worktree, command, or env changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-coalesce-ctx-",
        });
        const rootDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-coalesce-dirs-",
        });
        const dirA = path.join(rootDir, "dir-a");
        const dirB = path.join(rootDir, "dir-b");
        yield* fs.makeDirectory(dirA, { recursive: true });
        yield* fs.makeDirectory(dirB, { recursive: true });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
        });

        const autoExitLatest = () => {
          const proc = ptyAdapter.processes[ptyAdapter.processes.length - 1]!;
          proc.onKill = () => {
            proc.emitExit({ exitCode: 0, signal: 15 });
          };
          return proc;
        };

        const first = yield* manager.open(
          openInput({
            terminalId: "run-coalesce-ctx",
            cwd: dirA,
            command: "sudo id",
            env: { FOO: "1" },
            elevation: {},
          }),
        );
        const firstProc = autoExitLatest();

        // Identical launch context coalesces.
        const coalesced = yield* manager.open(
          openInput({
            terminalId: "run-coalesce-ctx",
            cwd: dirA,
            command: "sudo id",
            env: { FOO: "1" },
            elevation: {},
          }),
        );
        expect(coalesced.pid).toBe(first.pid);
        expect(firstProc.killed).toBe(false);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);

        // Changing command must replace.
        const changedCommand = yield* manager.open(
          openInput({
            terminalId: "run-coalesce-ctx",
            cwd: dirA,
            command: "sudo ls",
            env: { FOO: "1" },
            elevation: {},
          }),
        );
        expect(firstProc.killed).toBe(true);
        expect(changedCommand.pid).not.toBe(first.pid);
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        const secondProc = autoExitLatest();

        // Changing cwd must replace.
        const changedCwd = yield* manager.open(
          openInput({
            terminalId: "run-coalesce-ctx",
            cwd: dirB,
            command: "sudo ls",
            env: { FOO: "1" },
            elevation: {},
          }),
        );
        expect(secondProc.killed).toBe(true);
        expect(changedCwd.cwd).toBe(dirB);
        expect(ptyAdapter.spawnInputs).toHaveLength(3);
        const thirdProc = autoExitLatest();

        // Changing worktreePath must replace.
        const changedWorktree = yield* manager.open(
          openInput({
            terminalId: "run-coalesce-ctx",
            cwd: dirB,
            worktreePath: dirB,
            command: "sudo ls",
            env: { FOO: "1" },
            elevation: {},
          }),
        );
        expect(thirdProc.killed).toBe(true);
        expect(changedWorktree.worktreePath).toBe(dirB);
        expect(ptyAdapter.spawnInputs).toHaveLength(4);
        const fourthProc = autoExitLatest();

        // Changing env must replace.
        const changedEnv = yield* manager.open(
          openInput({
            terminalId: "run-coalesce-ctx",
            cwd: dirB,
            worktreePath: dirB,
            command: "sudo ls",
            env: { FOO: "2" },
            elevation: {},
          }),
        );
        expect(fourthProc.killed).toBe(true);
        expect(changedEnv.pid).not.toBe(changedWorktree.pid);
        expect(ptyAdapter.spawnInputs).toHaveLength(5);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "awaits old process exit before spawning an elevated replacement and fails with TerminalStopError if stop times out",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-stop-order-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          processKillGraceMs: 10,
        });

        // Part A: replacement must not spawn until the prior process actually exits.
        yield* manager.open(
          openInput({
            terminalId: "run-stop-order",
            command: "sudo id",
            elevation: {},
          }),
        );
        const firstProc = ptyAdapter.processes[0]!;
        const firstKillReceived = yield* Deferred.make<void>();
        firstProc.onKill = () => {
          Deferred.doneUnsafe(firstKillReceived, Exit.void);
        };

        const switchFiber = yield* Effect.forkChild(
          manager.open(
            openInput({
              terminalId: "run-stop-order",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          ),
        );
        yield* Deferred.await(firstKillReceived);
        expect(firstProc.killed).toBe(true);
        expect(firstProc.killSignals).toEqual(["SIGTERM"]);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);

        // Once the old process exits, the replacement spawns and open() completes.
        firstProc.emitExit({ exitCode: 0, signal: 15 });
        const switched = yield* Fiber.join(switchFiber);
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect(switched.pid).toBe(ptyAdapter.processes[1]!.pid);

        // Part B: if the old process ignores both SIGTERM and SIGKILL, open() fails with
        // TerminalStopError, does not spawn a replacement, and cleans up the unused staging dir.
        const secondProc = ptyAdapter.processes[1]!;
        const dirsBeforeFailing = yield* fs.readDirectory(elevatedRunsDir);
        const secondSigtermReceived = yield* Deferred.make<void>();
        const secondSigkillReceived = yield* Deferred.make<void>();
        secondProc.onKill = (signal) => {
          if (signal === "SIGTERM") {
            Deferred.doneUnsafe(secondSigtermReceived, Exit.void);
          } else if (signal === "SIGKILL") {
            Deferred.doneUnsafe(secondSigkillReceived, Exit.void);
          }
        };
        const failingFiber = yield* Effect.forkChild(
          Effect.flip(
            manager.open(
              openInput({
                terminalId: "run-stop-order",
                command: "sudo id",
                elevation: {},
              }),
            ),
          ),
        );
        yield* Deferred.await(secondSigtermReceived);
        expect(secondProc.killSignals).toEqual(["SIGTERM"]);
        yield* Deferred.await(secondSigkillReceived);
        expect(secondProc.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        const error = yield* Fiber.join(failingFiber);
        expect(error).toBeInstanceOf(TerminalStopError);
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        // The newly staged replacement directory was cleaned up on failure.
        const remainingDirs = yield* fs.readDirectory(elevatedRunsDir);
        expect(remainingDirs).toEqual(dirsBeforeFailing);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "awaits elevated wrapper cleanup dir removal after PTY exit and fails with TerminalStopError if cleanup stalls",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-cleanup-wait-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          processKillGraceMs: 20,
          elevatedCleanupTimeoutMs: 60,
        });

        // Open an elevated run and mark its runDir as started by the wrapper.
        yield* manager.open(
          openInput({
            terminalId: "run-cleanup-wait",
            command: "sudo id",
            elevation: {},
          }),
        );
        const firstDirs = yield* fs.readDirectory(elevatedRunsDir);
        expect(firstDirs).toHaveLength(1);
        const firstRunDir = path.join(elevatedRunsDir, firstDirs[0]!);
        yield* fs.writeFileString(path.join(firstRunDir, "started"), "1234\n");

        // Even after the PTY exits immediately, restart must fail with TerminalStopError
        // while the started runDir still exists (wrapper/watcher teardown still running).
        const firstProc = ptyAdapter.processes[0]!;
        firstProc.onKill = () => {
          firstProc.emitExit({ exitCode: 0, signal: 15 });
        };
        const restartErr = yield* Effect.flip(
          manager.restart({
            threadId: "thread-1",
            terminalId: "run-cleanup-wait",
            cwd: openInput().cwd,
            cols: 80,
            rows: 24,
          }),
        );
        expect(restartErr).toBeInstanceOf(TerminalStopError);
        expect(ptyAdapter.spawnInputs).toHaveLength(1);

        // close() must also fail with TerminalStopError while the started runDir remains,
        // keeping the session registered until teardown completes.
        const closeErr = yield* Effect.flip(
          manager.close({ threadId: "thread-1", terminalId: "run-cleanup-wait" }),
        );
        expect(closeErr).toBeInstanceOf(TerminalStopError);

        // Removing the runDir (simulating wrapper/watcher finishing teardown) unblocks close().
        yield* fs.remove(firstRunDir, { recursive: true });
        yield* manager.close({ threadId: "thread-1", terminalId: "run-cleanup-wait" });

        // Also verify open() replacement waits for runDir removal after PTY exit.
        yield* manager.open(
          openInput({
            terminalId: "run-cleanup-wait",
            command: "sudo id",
            elevation: {},
          }),
        );
        const secondDirs = yield* fs.readDirectory(elevatedRunsDir);
        expect(secondDirs).toHaveLength(1);
        const secondRunDir = path.join(elevatedRunsDir, secondDirs[0]!);
        yield* fs.writeFileString(path.join(secondRunDir, "started"), "5678\n");
        const secondProc = ptyAdapter.processes[1]!;
        const secondExited = yield* Deferred.make<void>();
        secondProc.onKill = () => {
          secondProc.emitExit({ exitCode: 0, signal: 15 });
          Deferred.doneUnsafe(secondExited, Exit.void);
        };

        const openErr = yield* Effect.flip(
          manager.open(
            openInput({
              terminalId: "run-cleanup-wait",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          ),
        );
        yield* Deferred.await(secondExited);
        expect(openErr).toBeInstanceOf(TerminalStopError);
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        // The newly staged replacement directory was cleaned up; only secondRunDir remains.
        expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual(secondDirs);

        yield* fs.remove(secondRunDir, { recursive: true });
        yield* manager.open(
          openInput({
            terminalId: "run-cleanup-wait",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        expect(ptyAdapter.spawnInputs).toHaveLength(3);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect("fails fast with TerminalStopError when elevated wrapper records cleanup-failed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "elevated-runs-cleanup-failed-",
      });
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        elevatedRunsDir,
        processKillGraceMs: 20,
        // Deliberately large timeout: cleanup-failed must fail immediately without waiting it out.
        elevatedCleanupTimeoutMs: 10_000,
      });

      yield* manager.open(
        openInput({
          terminalId: "run-cleanup-failed",
          command: "sudo id",
          elevation: {},
        }),
      );
      const dirs = yield* fs.readDirectory(elevatedRunsDir);
      expect(dirs).toHaveLength(1);
      const runDir = path.join(elevatedRunsDir, dirs[0]!);
      yield* fs.writeFileString(path.join(runDir, "started"), "1234\n");
      yield* fs.writeFileString(path.join(runDir, "need-drop"), "");
      yield* fs.writeFileString(path.join(runDir, "cleanup-failed"), "drop-ticket-failed\n");

      const proc = ptyAdapter.processes[0]!;
      proc.emitExit({ exitCode: 0, signal: 0 });

      const startedAt = yield* Clock.currentTimeMillis;
      const closeErr = yield* Effect.flip(
        manager.close({ threadId: "thread-1", terminalId: "run-cleanup-failed" }),
      );
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      expect(closeErr).toBeInstanceOf(TerminalStopError);
      expect(elapsedMs).toBeLessThan(2_000);
      // The failure marker directory must remain intact rather than being deleted.
      expect(yield* fs.exists(path.join(runDir, "cleanup-failed"))).toBe(true);

      const openErr = yield* Effect.flip(
        manager.open(
          openInput({
            terminalId: "run-cleanup-failed",
            command: "sudo id",
            elevation: {},
          }),
        ),
      );
      expect(openErr).toBeInstanceOf(TerminalStopError);
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      // Only the failed runDir remains; the staged replacement dir was cleaned up.
      expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual(dirs);
    }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect("retains pending elevated cleanup guard across full inactive-session eviction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
        prefix: "elevated-runs-eviction-guard-",
      });
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        elevatedRunsDir,
        processKillGraceMs: 20,
        elevatedCleanupTimeoutMs: 60,
        maxRetainedInactiveSessions: 1,
      });

      // Start an elevated run, mark it started, and let its PTY exit while runDir still exists.
      yield* manager.open(
        openInput({
          threadId: "thread-elevated",
          terminalId: "run-evict-guard",
          command: "sudo id",
          elevation: {},
        }),
      );
      const dirs = yield* fs.readDirectory(elevatedRunsDir);
      expect(dirs).toHaveLength(1);
      const runDir = path.join(elevatedRunsDir, dirs[0]!);
      yield* fs.writeFileString(path.join(runDir, "started"), "4321\n");
      ptyAdapter.processes[0]!.emitExit({ exitCode: 0, signal: 0 });

      // Overflow the inactive-session cache with unrelated exited sessions.
      for (const id of ["other-1", "other-2", "other-3"]) {
        yield* manager.open(
          openInput({
            threadId: `thread-${id}`,
            terminalId: id,
          }),
        );
        const proc = ptyAdapter.processes[ptyAdapter.processes.length - 1]!;
        proc.emitExit({ exitCode: 0, signal: 0 });
      }

      // The exited elevated session must NOT have been evicted while runDir still exists,
      // so open(), restart(), and close() all still enforce the pending cleanup guard.
      const openErr = yield* Effect.flip(
        manager.open(
          openInput({
            threadId: "thread-elevated",
            terminalId: "run-evict-guard",
            command: "sudo id",
            elevation: {},
          }),
        ),
      );
      expect(openErr).toBeInstanceOf(TerminalStopError);
      expect(ptyAdapter.spawnInputs).toHaveLength(4);

      const restartErr = yield* Effect.flip(
        manager.restart({
          threadId: "thread-elevated",
          terminalId: "run-evict-guard",
          cwd: openInput().cwd,
          cols: 80,
          rows: 24,
        }),
      );
      expect(restartErr).toBeInstanceOf(TerminalStopError);
      expect(ptyAdapter.spawnInputs).toHaveLength(4);

      const closeErr = yield* Effect.flip(
        manager.close({ threadId: "thread-elevated", terminalId: "run-evict-guard" }),
      );
      expect(closeErr).toBeInstanceOf(TerminalStopError);

      // Once the wrapper/watcher finishes cleanup and removes runDir, replacement succeeds.
      yield* fs.remove(runDir, { recursive: true });
      yield* manager.open(
        openInput({
          threadId: "thread-elevated",
          terminalId: "run-evict-guard",
          command: "sudo id",
          elevation: {},
        }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(5);
    }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "pins elevated sessions against cache eviction from fresh open and in-flight replacement through spawn registration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-inflight-evict-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          processKillGraceMs: 20,
          elevatedCleanupTimeoutMs: 60,
          maxRetainedInactiveSessions: 0,
        });

        // 1. Fresh elevated open with maxRetainedInactiveSessions=0: the starting
        // session must not be evicted by its own eviction pass before spawn registers.
        yield* manager.open(
          openInput({
            threadId: "thread-elevated",
            terminalId: "run-inflight-evict",
            command: "sudo id",
            elevation: {},
          }),
        );
        const firstDirs = yield* fs.readDirectory(elevatedRunsDir);
        expect(firstDirs).toHaveLength(1);
        const firstRunDir = path.join(elevatedRunsDir, firstDirs[0]!);
        yield* fs.writeFileString(path.join(firstRunDir, "started"), "1111\n");
        const firstProc = ptyAdapter.processes[0]!;
        firstProc.emitExit({ exitCode: 0, signal: 0 });

        // Simulate old wrapper/watcher finishing cleanup so replacement clears the old guard
        // while the session is still exited, then pause replacement mid-spawn.
        yield* fs.remove(firstRunDir, { recursive: true });
        const unrelatedExited = yield* Deferred.make<void>();
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "other-evictor"
            ? Deferred.succeed(unrelatedExited, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        try {
          // Pre-open an unrelated session on another thread so its exit triggers
          // evictInactiveSessionsIfNeeded() while replacement is paused mid-spawn.
          yield* manager.open(
            openInput({
              threadId: "thread-unrelated",
              terminalId: "other-evictor",
            }),
          );
          const unrelatedProc = ptyAdapter.processes[ptyAdapter.processes.length - 1]!;

          const replacementInFlight = yield* Deferred.make<void>();
          const releaseReplacement = yield* Deferred.make<void>();
          ptyAdapter.beforeSpawn = () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(replacementInFlight, undefined);
              yield* Deferred.await(releaseReplacement);
            });

          const replacementFiber = yield* Effect.forkChild(
            manager.open(
              openInput({
                threadId: "thread-elevated",
                terminalId: "run-inflight-evict",
                command: "sudo id",
                elevation: {},
              }),
            ),
          );
          yield* Deferred.await(replacementInFlight);

          // 2. While replacement is in flight (old guard cleared, new PTY not yet registered),
          // the unrelated session exits and runs evictInactiveSessionsIfNeeded() with cache limit 0.
          unrelatedProc.emitExit({ exitCode: 0, signal: 0 });
          yield* Deferred.await(unrelatedExited);
          // Give the post-publish eviction step a turn to run.
          yield* Effect.yieldNow;
          yield* Effect.sleep("20 millis");

          // Let the replacement spawn finish.
          ptyAdapter.beforeSpawn = undefined;
          yield* Deferred.succeed(releaseReplacement, undefined);
          yield* Fiber.join(replacementFiber);
        } finally {
          unsubscribe();
        }

        const secondDirs = yield* fs.readDirectory(elevatedRunsDir);
        expect(secondDirs).toHaveLength(1);
        const secondRunDir = path.join(elevatedRunsDir, secondDirs[0]!);
        yield* fs.writeFileString(path.join(secondRunDir, "started"), "2222\n");
        const replacementProc = ptyAdapter.processes[ptyAdapter.processes.length - 1]!;
        replacementProc.onKill = () => {
          replacementProc.emitExit({ exitCode: 0, signal: 15 });
        };

        // The replacement PTY and its new cleanup guard must still be registered and
        // reachable by close() (not orphaned by the concurrent eviction).
        const closeErr = yield* Effect.flip(
          manager.close({ threadId: "thread-elevated", terminalId: "run-inflight-evict" }),
        );
        expect(closeErr).toBeInstanceOf(TerminalStopError);
        expect(replacementProc.killSignals).toContain("SIGTERM");

        // Removing the replacement runDir unblocks close().
        yield* fs.remove(secondRunDir, { recursive: true });
        yield* manager.close({ threadId: "thread-elevated", terminalId: "run-inflight-evict" });
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "emits current elevationState on cleared events so clients stay in sync after clear()",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-clear-state-",
        });
        const serverNonces: Array<string> = [];
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          prepareElevatedRun: async (input) => {
            if (input.elevation.nonce) {
              serverNonces.push(input.elevation.nonce);
            }
            return prepareElevatedRunHandle(input);
          },
        });
        const events: Array<TerminalEvent> = [];
        const unsubscribe = yield* manager.subscribe((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        );
        try {
          yield* manager.open(
            openInput({
              terminalId: "run-clear-state",
              command: "sudo id",
              elevation: {},
            }),
          );
          const serverNonce = serverNonces[0]!;
          const proc = ptyAdapter.processes[0]!;

          proc.emitData(`\u001b]7717;elevation=started;${serverNonce}\u0007hello`);
          yield* manager.clear({ threadId: "thread-1", terminalId: "run-clear-state" });

          const clearedEvent = events.find(
            (event): event is Extract<TerminalEvent, { type: "cleared" }> =>
              event.type === "cleared" && event.terminalId === "run-clear-state",
          );
          expect(clearedEvent?.elevationState).toBe("started");
        } finally {
          unsubscribe();
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "resets prompt-mode elevated session to a plain shell on generic restart instead of replaying wrapper",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-restart-prompt-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
          processKillGraceMs: 50,
        });

        yield* manager.open(
          openInput({
            terminalId: "run-restart-prompt",
            command: "sudo id",
            elevation: {},
          }),
        );
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(ptyAdapter.spawnInputs[0]?.args?.join(" ")).toContain("run.sh");

        const dirs = yield* fs.readDirectory(elevatedRunsDir);
        expect(dirs).toHaveLength(1);
        const runDir = path.join(elevatedRunsDir, dirs[0]!);
        const firstProc = ptyAdapter.processes[0]!;
        firstProc.onKill = () => {
          firstProc.emitExit({ exitCode: 0, signal: 15 });
        };
        yield* fs.remove(runDir, { recursive: true });

        const restarted = yield* manager.restart(
          restartInput({
            terminalId: "run-restart-prompt",
          }),
        );
        expect(restarted.status).toBe("running");
        expect(restarted.elevationState).toBeUndefined();
        expect(restarted.elevationNonce).toBeUndefined();
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect(ptyAdapter.spawnInputs[1]?.args ?? []).not.toContain("-c");
        expect((ptyAdapter.spawnInputs[1]?.args ?? []).join(" ")).not.toContain("run.sh");
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "resets Terminal.app elevated session to a plain shell on generic restart instead of replaying staged launcher",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-restart-terminal-app-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir,
        });

        yield* manager.open(
          openInput({
            terminalId: "run-restart-terminal-app",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        expect(ptyAdapter.spawnInputs).toHaveLength(1);
        expect(ptyAdapter.spawnInputs[0]?.args?.join(" ")).toContain(".command");
        const firstProc = ptyAdapter.processes[0]!;
        firstProc.emitExit({ exitCode: 0, signal: 0 });

        // Restart arrives while the one-shot .command launcher is still staged on disk.
        const stagedFiles = yield* fs.readDirectory(elevatedRunsDir);
        expect(stagedFiles.some((name) => name.endsWith(".command"))).toBe(true);

        const restarted = yield* manager.restart(
          restartInput({
            terminalId: "run-restart-terminal-app",
          }),
        );
        expect(restarted.status).toBe("running");
        expect(restarted.elevationState).toBeUndefined();
        expect(restarted.elevationNonce).toBeUndefined();
        expect(ptyAdapter.spawnInputs).toHaveLength(2);
        expect((ptyAdapter.spawnInputs[1]?.args ?? []).join(" ")).not.toContain(".command");
        expect((ptyAdapter.spawnInputs[1]?.args ?? []).join(" ")).not.toContain("Terminal");
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "stops returned PTY, cleans up staged elevated files, and fails when manager disposes mid-spawn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-disposed-spawn-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const managerScope = yield* Scope.make();
        const { manager } = yield* Scope.provide(
          createManager(5, {
            ptyAdapter,
            elevatedRunsDir,
            processKillGraceMs: 50,
          }),
          managerScope,
        );

        const spawnInFlight = yield* Deferred.make<void>();
        const releaseSpawn = yield* Deferred.make<void>();
        ptyAdapter.beforeSpawn = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(spawnInFlight, undefined);
            yield* Deferred.await(releaseSpawn);
          });

        const openFiber = yield* Effect.forkChild(
          manager.open(
            openInput({
              terminalId: "run-disposed-mid-spawn",
              command: "sudo id",
              elevation: {},
            }),
          ),
        );
        yield* Deferred.await(spawnInFlight);

        // Staged run directory exists while spawn is paused.
        expect((yield* fs.readDirectory(elevatedRunsDir)).length).toBe(1);

        // Dispose the manager before the PTY adapter returns.
        yield* Scope.close(managerScope, Exit.void);

        // Release spawn so the adapter produces a live PTY after disposal.
        ptyAdapter.beforeSpawn = undefined;
        ptyAdapter.onSpawnedProcess = (proc) => {
          proc.onKill = () => {
            proc.emitExit({ exitCode: 0, signal: 15 });
          };
        };
        yield* Deferred.succeed(releaseSpawn, undefined);

        const openErr = yield* Effect.flip(Fiber.join(openFiber));
        expect(openErr).toBeInstanceOf(TerminalNotRunningError);
        expect(ptyAdapter.processes).toHaveLength(1);
        expect(ptyAdapter.processes[0]?.killSignals).toContain("SIGTERM");
        expect(yield* manager.countOpen).toBe(0);
        expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual([]);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "waits for confirmed SIGKILL exit and wrapper cleanup ack when manager disposes mid-spawn after wrapper started",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const elevatedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-disposed-started-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const managerScope = yield* Scope.make();
        const { manager } = yield* Scope.provide(
          createManager(5, {
            ptyAdapter,
            elevatedRunsDir,
            processKillGraceMs: 40,
            elevatedCleanupTimeoutMs: 500,
          }),
          managerScope,
        );

        const spawnInFlight = yield* Deferred.make<void>();
        const releaseSpawn = yield* Deferred.make<void>();
        const sigkillReceived = yield* Deferred.make<void>();
        ptyAdapter.beforeSpawn = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(spawnInFlight, undefined);
            yield* Deferred.await(releaseSpawn);
          });

        let openSettled = false;
        const openFiber = yield* Effect.forkChild(
          manager
            .open(
              openInput({
                terminalId: "run-disposed-started-ack",
                command: "sudo id",
                elevation: {},
              }),
            )
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  openSettled = true;
                }),
              ),
            ),
        );
        yield* Deferred.await(spawnInFlight);

        const stagedEntries = yield* fs.readDirectory(elevatedRunsDir);
        expect(stagedEntries).toHaveLength(1);
        const runDir = path.join(elevatedRunsDir, stagedEntries[0]!);
        // Simulate wrapper already writing `started` and `need-drop` before disposal hits.
        yield* fs.writeFileString(path.join(runDir, "started"), "5555\n");
        yield* fs.writeFileString(path.join(runDir, "need-drop"), "");

        yield* Scope.close(managerScope, Exit.void);

        ptyAdapter.beforeSpawn = undefined;
        let spawnedProc: FakePtyProcess | null = null;
        ptyAdapter.onSpawnedProcess = (proc) => {
          spawnedProc = proc;
          proc.onKill = (signal) => {
            if (signal === "SIGKILL") {
              Deferred.doneUnsafe(sigkillReceived, Exit.void);
            }
          };
        };
        yield* Deferred.succeed(releaseSpawn, undefined);

        // Wait until SIGTERM grace expires and SIGKILL is sent, without exiting yet.
        yield* Deferred.await(sigkillReceived);

        // Staging dir must still exist while waiting for confirmed post-SIGKILL exit.
        expect(yield* fs.exists(path.join(runDir, "started"))).toBe(true);
        expect(openSettled).toBe(false);

        // PTY exits after SIGKILL; wrapper watcher has not yet removed runDir.
        spawnedProc!.emitExit({ exitCode: 0, signal: 9 });
        yield* Effect.sleep(Duration.millis(40));
        expect(yield* fs.exists(path.join(runDir, "need-drop"))).toBe(true);
        expect(openSettled).toBe(false);

        // Watcher finishes descendant teardown + sudo -k and removes runDir.
        yield* fs.remove(runDir, { recursive: true, force: true });

        const openErr = yield* Effect.flip(Fiber.join(openFiber));
        expect(openErr).toBeInstanceOf(TerminalNotRunningError);
        expect(ptyAdapter.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(yield* fs.readDirectory(elevatedRunsDir)).toEqual([]);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "preserves started elevated run directory when manager disposes mid-spawn and PTY exit or cleanup fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // Case 1: PTY ignores SIGTERM and SIGKILL (exit never confirmed).
        const noExitRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-disposed-no-exit-",
        });
        const noExitAdapter = new FakePtyAdapter();
        const noExitScope = yield* Scope.make();
        const { manager: noExitManager } = yield* Scope.provide(
          createManager(5, {
            ptyAdapter: noExitAdapter,
            elevatedRunsDir: noExitRunsDir,
            processKillGraceMs: 30,
            elevatedCleanupTimeoutMs: 100,
          }),
          noExitScope,
        );

        const noExitSpawnInFlight = yield* Deferred.make<void>();
        const noExitReleaseSpawn = yield* Deferred.make<void>();
        noExitAdapter.beforeSpawn = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(noExitSpawnInFlight, undefined);
            yield* Deferred.await(noExitReleaseSpawn);
          });

        const noExitOpen = yield* Effect.forkChild(
          noExitManager.open(
            openInput({
              terminalId: "run-disposed-no-exit",
              command: "sudo id",
              elevation: {},
            }),
          ),
        );
        yield* Deferred.await(noExitSpawnInFlight);
        const noExitEntries = yield* fs.readDirectory(noExitRunsDir);
        expect(noExitEntries).toHaveLength(1);
        const noExitRunDir = path.join(noExitRunsDir, noExitEntries[0]!);
        yield* fs.writeFileString(path.join(noExitRunDir, "started"), "6666\n");
        yield* fs.writeFileString(path.join(noExitRunDir, "need-drop"), "");

        yield* Scope.close(noExitScope, Exit.void);
        noExitAdapter.beforeSpawn = undefined;
        yield* Deferred.succeed(noExitReleaseSpawn, undefined);

        const noExitErr = yield* Effect.flip(Fiber.join(noExitOpen));
        expect(noExitErr).toBeInstanceOf(TerminalNotRunningError);
        expect(noExitAdapter.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(yield* fs.exists(path.join(noExitRunDir, "started"))).toBe(true);
        expect(yield* fs.exists(path.join(noExitRunDir, "need-drop"))).toBe(true);

        // Case 2: PTY exits on SIGTERM, but wrapper reports cleanup-failed.
        const failedRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-runs-disposed-cleanup-failed-",
        });
        const failedAdapter = new FakePtyAdapter();
        const failedScope = yield* Scope.make();
        const { manager: failedManager } = yield* Scope.provide(
          createManager(5, {
            ptyAdapter: failedAdapter,
            elevatedRunsDir: failedRunsDir,
            processKillGraceMs: 30,
            elevatedCleanupTimeoutMs: 100,
          }),
          failedScope,
        );

        const failedSpawnInFlight = yield* Deferred.make<void>();
        const failedReleaseSpawn = yield* Deferred.make<void>();
        failedAdapter.beforeSpawn = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(failedSpawnInFlight, undefined);
            yield* Deferred.await(failedReleaseSpawn);
          });

        const failedOpen = yield* Effect.forkChild(
          failedManager.open(
            openInput({
              terminalId: "run-disposed-cleanup-failed",
              command: "sudo id",
              elevation: {},
            }),
          ),
        );
        yield* Deferred.await(failedSpawnInFlight);
        const failedEntries = yield* fs.readDirectory(failedRunsDir);
        expect(failedEntries).toHaveLength(1);
        const failedRunDir = path.join(failedRunsDir, failedEntries[0]!);
        yield* fs.writeFileString(path.join(failedRunDir, "started"), "7777\n");
        yield* fs.writeFileString(path.join(failedRunDir, "cleanup-failed"), "drop-failed\n");

        yield* Scope.close(failedScope, Exit.void);
        failedAdapter.beforeSpawn = undefined;
        failedAdapter.onSpawnedProcess = (proc) => {
          proc.onKill = () => {
            proc.emitExit({ exitCode: 0, signal: 15 });
          };
        };
        yield* Deferred.succeed(failedReleaseSpawn, undefined);

        const failedErr = yield* Effect.flip(Fiber.join(failedOpen));
        expect(failedErr).toBeInstanceOf(TerminalNotRunningError);
        expect(yield* fs.exists(path.join(failedRunDir, "cleanup-failed"))).toBe(true);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "preserves a pending Terminal.app script on mid-spawn disposal and cleans up a confirmed pre-handoff stop",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // Case 1: launcher already started handoff (created .handoff) before disposal killed it.
        // The staged .command file must stay intact for the delayed Terminal.app consumer.
        const pendingRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-pending-",
        });
        const pendingAdapter = new FakePtyAdapter();
        const pendingScope = yield* Scope.make();
        const { manager: pendingManager } = yield* Scope.provide(
          createManager(5, {
            ptyAdapter: pendingAdapter,
            elevatedRunsDir: pendingRunsDir,
            processKillGraceMs: 30,
          }),
          pendingScope,
        );

        const pendingSpawnInFlight = yield* Deferred.make<void>();
        const pendingReleaseSpawn = yield* Deferred.make<void>();
        pendingAdapter.beforeSpawn = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(pendingSpawnInFlight, undefined);
            yield* Deferred.await(pendingReleaseSpawn);
          });

        const pendingOpen = yield* Effect.forkChild(
          pendingManager.open(
            openInput({
              terminalId: "run-terminal-app-pending",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          ),
        );
        yield* Deferred.await(pendingSpawnInFlight);
        const pendingEntries = yield* fs.readDirectory(pendingRunsDir);
        expect(pendingEntries).toHaveLength(1);
        const commandFile = path.join(pendingRunsDir, pendingEntries[0]!);
        expect(commandFile.endsWith(".command")).toBe(true);
        const handoffMarker = commandFile.replace(/\.command$/, ".handoff");
        // Simulate `: >| <handoff> && open -a Terminal <file>` having already handed off.
        yield* fs.writeFileString(handoffMarker, "");

        yield* Scope.close(pendingScope, Exit.void);
        pendingAdapter.beforeSpawn = undefined;
        pendingAdapter.onSpawnedProcess = (proc) => {
          proc.onKill = () => {
            proc.emitExit({ exitCode: 0, signal: 0 });
          };
        };
        yield* Deferred.succeed(pendingReleaseSpawn, undefined);

        const pendingErr = yield* Effect.flip(Fiber.join(pendingOpen));
        expect(pendingErr).toBeInstanceOf(TerminalNotRunningError);
        expect(yield* fs.exists(commandFile)).toBe(true);
        expect(yield* fs.exists(handoffMarker)).toBe(true);

        // Case 2: launcher exited before creating .handoff (confirmed pre-handoff stop).
        // Disposal must unlink the staged .command file so it is not orphaned.
        const preRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-pre-handoff-",
        });
        const preAdapter = new FakePtyAdapter();
        const preScope = yield* Scope.make();
        const { manager: preManager } = yield* Scope.provide(
          createManager(5, {
            ptyAdapter: preAdapter,
            elevatedRunsDir: preRunsDir,
            processKillGraceMs: 30,
          }),
          preScope,
        );

        const preSpawnInFlight = yield* Deferred.make<void>();
        const preReleaseSpawn = yield* Deferred.make<void>();
        preAdapter.beforeSpawn = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(preSpawnInFlight, undefined);
            yield* Deferred.await(preReleaseSpawn);
          });

        const preOpen = yield* Effect.forkChild(
          preManager.open(
            openInput({
              terminalId: "run-terminal-app-pre",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          ),
        );
        yield* Deferred.await(preSpawnInFlight);
        const preEntries = yield* fs.readDirectory(preRunsDir);
        expect(preEntries).toHaveLength(1);
        const preCommandFile = path.join(preRunsDir, preEntries[0]!);
        expect(preCommandFile.endsWith(".command")).toBe(true);

        yield* Scope.close(preScope, Exit.void);
        preAdapter.beforeSpawn = undefined;
        preAdapter.onSpawnedProcess = (proc) => {
          proc.onKill = () => {
            proc.emitExit({ exitCode: 0, signal: 15 });
          };
        };
        yield* Deferred.succeed(preReleaseSpawn, undefined);

        const preErr = yield* Effect.flip(Fiber.join(preOpen));
        expect(preErr).toBeInstanceOf(TerminalNotRunningError);
        expect(yield* fs.exists(preCommandFile)).toBe(false);

        // Case 3: launcher ignores SIGTERM/SIGKILL and never reports exit -> preserve staged file.
        const stuckRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-no-exit-",
        });
        const stuckAdapter = new FakePtyAdapter();
        const stuckScope = yield* Scope.make();
        const { manager: stuckManager } = yield* Scope.provide(
          createManager(5, {
            ptyAdapter: stuckAdapter,
            elevatedRunsDir: stuckRunsDir,
            processKillGraceMs: 25,
          }),
          stuckScope,
        );

        const stuckSpawnInFlight = yield* Deferred.make<void>();
        const stuckReleaseSpawn = yield* Deferred.make<void>();
        stuckAdapter.beforeSpawn = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(stuckSpawnInFlight, undefined);
            yield* Deferred.await(stuckReleaseSpawn);
          });

        const stuckOpen = yield* Effect.forkChild(
          stuckManager.open(
            openInput({
              terminalId: "run-terminal-app-no-exit",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          ),
        );
        yield* Deferred.await(stuckSpawnInFlight);
        const stuckEntries = yield* fs.readDirectory(stuckRunsDir);
        expect(stuckEntries).toHaveLength(1);
        const stuckCommandFile = path.join(stuckRunsDir, stuckEntries[0]!);
        expect(stuckCommandFile.endsWith(".command")).toBe(true);

        yield* Scope.close(stuckScope, Exit.void);
        stuckAdapter.beforeSpawn = undefined;
        yield* Deferred.succeed(stuckReleaseSpawn, undefined);

        const stuckErr = yield* Effect.flip(Fiber.join(stuckOpen));
        expect(stuckErr).toBeInstanceOf(TerminalNotRunningError);
        expect(stuckAdapter.processes[0]?.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(yield* fs.exists(stuckCommandFile)).toBe(true);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "cleans up staged Terminal.app .command on registered close or exit only when .handoff is absent",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // Case 1: registered terminal-app launcher closed before creating .handoff -> unlinked.
        const closePreRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-reg-close-pre-",
        });
        const closePreAdapter = new FakePtyAdapter();
        const { manager: closePreManager } = yield* createManager(5, {
          ptyAdapter: closePreAdapter,
          elevatedRunsDir: closePreRunsDir,
          processKillGraceMs: 30,
        });
        yield* closePreManager.open(
          openInput({
            terminalId: "run-reg-close-pre",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        const closePreEntries = yield* fs.readDirectory(closePreRunsDir);
        expect(closePreEntries).toHaveLength(1);
        const closePreCommandFile = path.join(closePreRunsDir, closePreEntries[0]!);
        expect(closePreCommandFile.endsWith(".command")).toBe(true);

        const closePreProc = closePreAdapter.processes[0]!;
        closePreProc.onKill = () => {
          closePreProc.emitExit({ exitCode: 0, signal: 15 });
        };
        yield* closePreManager.close({ threadId: "thread-1", terminalId: "run-reg-close-pre" });
        expect(yield* fs.exists(closePreCommandFile)).toBe(false);

        // Case 2: registered terminal-app launcher closed after creating .handoff -> preserved.
        const closePostRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-reg-close-post-",
        });
        const closePostAdapter = new FakePtyAdapter();
        const { manager: closePostManager } = yield* createManager(5, {
          ptyAdapter: closePostAdapter,
          elevatedRunsDir: closePostRunsDir,
          processKillGraceMs: 30,
        });
        yield* closePostManager.open(
          openInput({
            terminalId: "run-reg-close-post",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        const closePostEntries = yield* fs.readDirectory(closePostRunsDir);
        expect(closePostEntries).toHaveLength(1);
        const closePostCommandFile = path.join(closePostRunsDir, closePostEntries[0]!);
        yield* fs.writeFileString(closePostCommandFile.replace(/\.command$/, ".handoff"), "");

        const closePostProc = closePostAdapter.processes[0]!;
        closePostProc.onKill = () => {
          closePostProc.emitExit({ exitCode: 0, signal: 15 });
        };
        yield* closePostManager.close({ threadId: "thread-1", terminalId: "run-reg-close-post" });
        expect(yield* fs.exists(closePostCommandFile)).toBe(true);

        // Case 3: registered terminal-app launcher exits naturally before .handoff -> unlinked.
        const exitPreRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-reg-exit-pre-",
        });
        const exitPreAdapter = new FakePtyAdapter();
        const { manager: exitPreManager } = yield* createManager(5, {
          ptyAdapter: exitPreAdapter,
          elevatedRunsDir: exitPreRunsDir,
          processKillGraceMs: 30,
        });
        const exitDone = yield* Deferred.make<void>();
        const unsubscribe = yield* exitPreManager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "run-reg-exit-pre"
            ? Deferred.succeed(exitDone, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        try {
          yield* exitPreManager.open(
            openInput({
              terminalId: "run-reg-exit-pre",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          );
          const exitPreEntries = yield* fs.readDirectory(exitPreRunsDir);
          expect(exitPreEntries).toHaveLength(1);
          const exitPreCommandFile = path.join(exitPreRunsDir, exitPreEntries[0]!);

          exitPreAdapter.processes[0]!.emitExit({ exitCode: 1, signal: 0 });
          yield* Deferred.await(exitDone);
          expect(yield* fs.exists(exitPreCommandFile)).toBe(false);
        } finally {
          unsubscribe();
        }

        // Case 4: registered terminal-app launcher ignores kill -> fail closed, preserve .command.
        const stuckRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-reg-stuck-",
        });
        const stuckAdapter = new FakePtyAdapter();
        const { manager: stuckManager } = yield* createManager(5, {
          ptyAdapter: stuckAdapter,
          elevatedRunsDir: stuckRunsDir,
          processKillGraceMs: 25,
        });
        yield* stuckManager.open(
          openInput({
            terminalId: "run-reg-stuck",
            command: "sudo id",
            elevation: { openIn: "terminal-app" },
          }),
        );
        const stuckEntries = yield* fs.readDirectory(stuckRunsDir);
        expect(stuckEntries).toHaveLength(1);
        const stuckCommandFile = path.join(stuckRunsDir, stuckEntries[0]!);

        const closeErr = yield* Effect.flip(
          stuckManager.close({ threadId: "thread-1", terminalId: "run-reg-stuck" }),
        );
        expect(closeErr).toBeInstanceOf(TerminalStopError);
        expect(yield* fs.exists(stuckCommandFile)).toBe(true);

        // Case 5: a delayed natural-exit drain from launcher #1 must clean up only launcher #1's
        // staged .command file and never claim or unlink a concurrently opened launcher #2's staging.
        const raceRunsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-terminal-app-reg-exit-race-",
        });
        const raceAdapter = new FakePtyAdapter();
        const cleanupCalls: Array<string> = [];
        const { manager: raceManager } = yield* createManager(5, {
          ptyAdapter: raceAdapter,
          elevatedRunsDir: raceRunsDir,
          processKillGraceMs: 30,
          prepareElevatedRun: async (input) => {
            const handle = await prepareElevatedRunHandle(input);
            const marker = handle.handoffMarker ?? "unknown";
            return {
              ...handle,
              cleanup: async () => {
                cleanupCalls.push(marker);
                await handle.cleanup();
              },
            };
          },
        });
        const firstExitPublished = yield* Deferred.make<void>();
        const unsubRace = yield* raceManager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "run-reg-race"
            ? Deferred.succeed(firstExitPublished, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        try {
          yield* raceManager.open(
            openInput({
              terminalId: "run-reg-race",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          );
          const firstEntries = yield* fs.readDirectory(raceRunsDir);
          expect(firstEntries).toHaveLength(1);
          const firstCommandFile = path.join(raceRunsDir, firstEntries[0]!);
          const firstMarker = firstCommandFile.replace(/\.command$/, ".handoff");

          // Emit launcher #1's exit and immediately open launcher #2 on the same terminalId
          // before launcher #1's async exit drain finishes.
          raceAdapter.processes[0]!.emitExit({ exitCode: 1, signal: 0 });
          const secondSnap = yield* raceManager.open(
            openInput({
              terminalId: "run-reg-race",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          );
          expect(secondSnap.status).toBe("running");
          yield* Deferred.await(firstExitPublished);

          const afterRaceEntries = yield* fs.readDirectory(raceRunsDir);
          expect(afterRaceEntries).toHaveLength(1);
          const secondCommandFile = path.join(raceRunsDir, afterRaceEntries[0]!);
          expect(secondCommandFile).not.toBe(firstCommandFile);
          expect(yield* fs.exists(firstCommandFile)).toBe(false);
          expect(yield* fs.exists(secondCommandFile)).toBe(true);
          expect(cleanupCalls).toEqual([firstMarker]);

          // Launcher #2 still owns its own staging and cleans it up when closed pre-handoff.
          const secondProc = raceAdapter.processes[1]!;
          secondProc.onKill = () => {
            secondProc.emitExit({ exitCode: 0, signal: 15 });
          };
          yield* raceManager.close({ threadId: "thread-1", terminalId: "run-reg-race" });
          expect(yield* fs.exists(secondCommandFile)).toBe(false);
          expect(cleanupCalls).toEqual([
            firstMarker,
            secondCommandFile.replace(/\.command$/, ".handoff"),
          ]);
        } finally {
          unsubRace();
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "does not let a delayed pre-handoff exit drain unregister a concurrently opened replacement's port registration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-port-fence-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const activePorts = new Map<string, ReadonlyArray<number>>();
        const portEvents: Array<string> = [];
        let firstCleanupEntered!: () => void;
        const firstCleanupEnteredPromise = new Promise<void>((resolve) => {
          firstCleanupEntered = resolve;
        });
        let releaseFirstCleanup!: () => void;
        const releaseFirstCleanupPromise = new Promise<void>((resolve) => {
          releaseFirstCleanup = resolve;
        });
        let prepareCount = 0;

        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir: runsDir,
          subprocessPollIntervalMs: 10,
          subprocessInspector: (terminalPid) =>
            Effect.succeed({
              hasRunningSubprocess: true,
              childCommand: `child-${terminalPid}`,
              processIds: [terminalPid, terminalPid + 100],
            }),
          registerTerminalProcesses: ({ threadId, terminalId, processIds }) =>
            Effect.sync(() => {
              activePorts.set(`${threadId}:${terminalId}`, processIds);
              portEvents.push(`register:${processIds.join(",")}`);
            }),
          unregisterTerminal: ({ threadId, terminalId }) =>
            Effect.sync(() => {
              activePorts.delete(`${threadId}:${terminalId}`);
              portEvents.push("unregister");
            }),
          prepareElevatedRun: async (input) => {
            const handle = await prepareElevatedRunHandle(input);
            const idx = ++prepareCount;
            if (idx === 1) {
              return {
                ...handle,
                cleanup: async () => {
                  firstCleanupEntered();
                  await releaseFirstCleanupPromise;
                  await handle.cleanup();
                },
              };
            }
            return handle;
          },
        });

        const firstExitPublished = yield* Deferred.make<void>();
        const unsub = yield* manager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "run-port-fence"
            ? Deferred.succeed(firstExitPublished, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        try {
          yield* manager.open(
            openInput({
              terminalId: "run-port-fence",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          );
          const firstProc = ptyAdapter.processes[0]!;

          // Emit launcher #1's exit and wait until its drainProcessEvents fiber is suspended
          // awaiting staged pre-handoff cleanup (after session.process was cleared).
          firstProc.emitExit({ exitCode: 1, signal: 0 });
          yield* Effect.promise(() => firstCleanupEnteredPromise);

          // Open replacement command #2 in the same terminal and wait for its port registration.
          const secondSnap = yield* manager.open(
            openInput({
              terminalId: "run-port-fence",
              command: "node server.js",
            }),
          );
          expect(secondSnap.status).toBe("running");
          const secondPid = ptyAdapter.processes[1]!.pid;
          yield* waitFor(
            Effect.sync(() => {
              const registered = activePorts.get("thread-1:run-port-fence");
              return registered !== undefined && registered[0] === secondPid;
            }),
          );

          // Release launcher #1's delayed pre-handoff cleanup and wait for its drain to finish.
          releaseFirstCleanup();
          yield* Deferred.await(firstExitPublished);

          // Launcher #1's delayed exit must NOT have unregistered launcher #2's port registration.
          expect(activePorts.get("thread-1:run-port-fence")).toEqual([secondPid, secondPid + 100]);
          expect(portEvents.at(-1)).toBe(`register:${secondPid},${secondPid + 100}`);

          // Closing launcher #2 DOES unregister its port registration.
          const secondProc = ptyAdapter.processes[1]!;
          secondProc.onKill = () => {
            secondProc.emitExit({ exitCode: 0, signal: 15 });
          };
          yield* manager.close({ threadId: "thread-1", terminalId: "run-port-fence" });
          expect(activePorts.has("thread-1:run-port-fence")).toBe(false);
          expect(portEvents.at(-1)).toBe("unregister");
        } finally {
          releaseFirstCleanup();
          unsub();
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "delayed exit unregisters generation 1 ports when generation 2 has advanced processGeneration without registering yet",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-port-stale-clear-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const activePorts = new Map<string, ReadonlyArray<number>>();
        const portEvents: Array<string> = [];
        let firstCleanupEntered!: () => void;
        const firstCleanupEnteredPromise = new Promise<void>((resolve) => {
          firstCleanupEntered = resolve;
        });
        let releaseFirstCleanup!: () => void;
        const releaseFirstCleanupPromise = new Promise<void>((resolve) => {
          releaseFirstCleanup = resolve;
        });
        let prepareCount = 0;
        let firstPidRef: number | undefined;

        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir: runsDir,
          subprocessPollIntervalMs: 10,
          subprocessInspector: (terminalPid) => {
            // Generation 2's inspection stays pending so it has not registered any ports yet.
            if (firstPidRef !== undefined && terminalPid !== firstPidRef) {
              return Effect.never;
            }
            return Effect.succeed({
              hasRunningSubprocess: true,
              childCommand: `child-${terminalPid}`,
              processIds: [terminalPid, terminalPid + 100],
            });
          },
          registerTerminalProcesses: ({ threadId, terminalId, processIds }) =>
            Effect.sync(() => {
              activePorts.set(`${threadId}:${terminalId}`, processIds);
              portEvents.push(`register:${processIds.join(",")}`);
            }),
          unregisterTerminal: ({ threadId, terminalId }) =>
            Effect.sync(() => {
              activePorts.delete(`${threadId}:${terminalId}`);
              portEvents.push("unregister");
            }),
          prepareElevatedRun: async (input) => {
            const handle = await prepareElevatedRunHandle(input);
            const idx = ++prepareCount;
            if (idx === 1) {
              return {
                ...handle,
                cleanup: async () => {
                  firstCleanupEntered();
                  await releaseFirstCleanupPromise;
                  await handle.cleanup();
                },
              };
            }
            return handle;
          },
        });

        const firstExitPublished = yield* Deferred.make<void>();
        const unsub = yield* manager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "run-port-stale-clear"
            ? Deferred.succeed(firstExitPublished, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        try {
          yield* manager.open(
            openInput({
              terminalId: "run-port-stale-clear",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          );
          const firstProc = ptyAdapter.processes[0]!;
          const firstPid = firstProc.pid;
          firstPidRef = firstPid;
          yield* waitFor(
            Effect.sync(() => {
              const registered = activePorts.get("thread-1:run-port-stale-clear");
              return registered !== undefined && registered[0] === firstPid;
            }),
          );

          // Generation 1 exits while its cleanup is paused.
          firstProc.emitExit({ exitCode: 1, signal: 0 });
          yield* Effect.promise(() => firstCleanupEnteredPromise);

          // Generation 2 starts (advancing processGeneration) and its port inspection fails,
          // so generation 1 still owns the port registry entry.
          const secondSnap = yield* manager.open(
            openInput({
              terminalId: "run-port-stale-clear",
              command: "node server.js",
            }),
          );
          expect(secondSnap.status).toBe("running");

          // Release generation 1's cleanup; its delayed exit MUST clear its stale port registration.
          releaseFirstCleanup();
          yield* Deferred.await(firstExitPublished);

          expect(activePorts.has("thread-1:run-port-stale-clear")).toBe(false);
          expect(portEvents).toEqual([`register:${firstPid},${firstPid + 100}`, "unregister"]);
        } finally {
          releaseFirstCleanup();
          unsub();
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "evicts failed spawn once the outermost session pin releases under zero inactive retention",
    () =>
      Effect.gen(function* () {
        const ptyAdapter = new FakePtyAdapter();
        for (let i = 0; i < 8; i += 1) {
          ptyAdapter.spawnFailures.push(new Error("spawn failed"));
        }
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          maxRetainedInactiveSessions: 0,
        });

        const failedSnapshot = yield* manager.open(
          openInput({
            terminalId: "fail-zero-retention",
          }),
        );
        expect(failedSnapshot.status).toBe("error");

        const observeErr = yield* Effect.flip(
          manager.observeStream(
            { threadId: "thread-1", terminalId: "fail-zero-retention" },
            () => Effect.void,
          ),
        );
        expect(observeErr).toBeInstanceOf(TerminalSessionLookupError);
      }),
  );

  it.effect(
    "awaits an in-flight Terminal.app pre-handoff cleanup claimed by exit draining before close resolves",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-prehandoff-close-race-",
        });
        const ptyAdapter = new FakePtyAdapter();
        let cleanupEntered!: () => void;
        const cleanupEnteredPromise = new Promise<void>((resolve) => {
          cleanupEntered = resolve;
        });
        let releaseCleanup!: () => void;
        const releaseCleanupPromise = new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });

        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir: runsDir,
          processKillGraceMs: 30,
          prepareElevatedRun: async (input) => {
            const handle = await prepareElevatedRunHandle(input);
            return {
              ...handle,
              cleanup: async () => {
                cleanupEntered();
                await releaseCleanupPromise;
                await handle.cleanup();
              },
            };
          },
        });

        try {
          yield* manager.open(
            openInput({
              terminalId: "run-prehandoff-close-race",
              command: "sudo id",
              elevation: { openIn: "terminal-app" },
            }),
          );
          const entries = yield* fs.readDirectory(runsDir);
          expect(entries).toHaveLength(1);
          const commandFile = path.join(runsDir, entries[0]!);

          const proc = ptyAdapter.processes[0]!;
          proc.onKill = () => {
            proc.emitExit({ exitCode: 0, signal: 15 });
          };

          const closeFiber = yield* Effect.forkChild(
            manager.close({ threadId: "thread-1", terminalId: "run-prehandoff-close-race" }),
          );
          yield* Effect.promise(() => cleanupEnteredPromise);
          yield* Effect.sleep(25);
          // close() must wait for the in-flight async cleanup instead of returning while .command still exists.
          expect(yield* fs.exists(commandFile)).toBe(true);
          expect(closeFiber.pollUnsafe()).toBeUndefined();

          releaseCleanup();
          yield* Fiber.join(closeFiber);
          expect(yield* fs.exists(commandFile)).toBe(false);
        } finally {
          releaseCleanup();
        }
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );

  it.effect(
    "recovers a fenced cleanup-failed elevated terminal on retry once recover.sh succeeds",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runsDir = yield* fs.makeTempDirectoryScoped({
          prefix: "elevated-recover-retry-",
        });
        const ptyAdapter = new FakePtyAdapter();
        const { manager } = yield* createManager(5, {
          ptyAdapter,
          elevatedRunsDir: runsDir,
          processKillGraceMs: 30,
          elevatedCleanupTimeoutMs: 2_000,
        });

        yield* manager.open(
          openInput({
            terminalId: "run-recover-retry",
            command: "sudo id",
            elevation: {},
          }),
        );
        const runEntries = yield* fs.readDirectory(runsDir);
        expect(runEntries).toHaveLength(1);
        const runDir = path.join(runsDir, runEntries[0]!);
        const failFlag = path.join(runDir, "fail-recovery");
        const recoverLog = path.join(runsDir, "recover-invocations.log");
        yield* fs.writeFileString(path.join(runDir, "started"), "1\n");
        yield* fs.writeFileString(path.join(runDir, "cleanup-failed"), "stop-target-failed\n");
        yield* fs.writeFileString(failFlag, "1\n");
        yield* fs.writeFileString(
          path.join(runDir, "recover.sh"),
          [
            "#!/bin/sh",
            `printf '%s\\n' "$*" >> "${recoverLog}"`,
            'if [ "${1:-}" != "--recover" ]; then exit 1; fi',
            `if [ -f "${failFlag}" ]; then exit 1; fi`,
            `rm -rf "${runDir}"`,
            "exit 0",
            "",
          ].join("\n"),
        );
        yield* fs.chmod(path.join(runDir, "recover.sh"), 0o700);

        const proc = ptyAdapter.processes[0]!;
        proc.onKill = () => {
          proc.emitExit({ exitCode: 0, signal: 15 });
        };

        // First close attempts bounded recovery, sees it fail, and stays fenced with TerminalStopError.
        const firstErr = yield* Effect.flip(
          manager.close({ threadId: "thread-1", terminalId: "run-recover-retry" }),
        );
        expect(firstErr).toBeInstanceOf(TerminalStopError);
        expect(yield* fs.exists(runDir)).toBe(true);

        // Once the transient failure clears, retrying close recovers the fence and succeeds.
        yield* fs.remove(failFlag, { force: true });
        yield* manager.close({ threadId: "thread-1", terminalId: "run-recover-retry" });
        expect(yield* fs.exists(runDir)).toBe(false);
        const logLines = (yield* fs.readFileString(recoverLog))
          .trim()
          .split("\n")
          .filter((line) => line.length > 0);
        expect(logLines).toHaveLength(2);
        expect(logLines[0]).toMatch(/^--recover /);
        expect(logLines[1]).toMatch(/^--recover /);
      }).pipe(Effect.provide(layerWithHostPlatform("darwin"))),
  );
});

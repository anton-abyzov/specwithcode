import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  TerminalCwdNotFoundError,
  TerminalWriteError,
  type TerminalEvent,
  type TerminalOpenInput,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native child events and PID tracking emulate terminal chunking and lifecycle independently.
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as Projects from "./ProjectService.ts";
import * as Setup from "./ProjectSetupScriptRunner.ts";

const layer = ProjectStore.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);
const projectId = ProjectId.make("setup-process-integration");
const fixture = (command: string, options: { noScript?: boolean; writeFailure?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs
      .makeTempDirectoryScoped({ prefix: "setup-process-" })
      .pipe(Effect.flatMap(fs.realPath));
    const worktree = `${root}/worktree`;
    yield* fs.makeDirectory(worktree);
    const store = yield* ProjectStore.ProjectStoreV2;
    const scripts = options.noScript
      ? []
      : [
          {
            id: "install",
            name: "Prepare worktree",
            command,
            icon: "configure" as const,
            runOnWorktreeCreate: true,
            async: false,
          },
        ];
    yield* store.apply({
      sequence: 1,
      eventId: EventId.make("setup-project-created"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-09T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Synthetic setup",
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts,
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
      },
    });
    // Project lookup is read from migrated SQLite; enrichment is irrelevant here.
    const mapProject = (row: ProjectStore.ProjectRow) => {
      const { workspaceSettings, ...fields } = row;
      return {
        ...fields,
        id: row.projectId,
        repositoryIdentity: null,
        ...(workspaceSettings ? { workspaceSettings } : {}),
      };
    };
    const projects = Layer.mock(Projects.ProjectService)({
      getById: (id) => store.get(id).pipe(Effect.map(Option.map(mapProject)), Effect.orDie),
      getByWorkspaceRoot: (cwd) =>
        store.findActiveByWorkspaceRoot(cwd).pipe(Effect.map(Option.map(mapProject)), Effect.orDie),
    });
    const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const closed: string[] = [];
    const opens: TerminalOpenInput[] = [];
    const pids: number[] = [];
    let terminal: TerminalOpenInput | undefined;
    const emit = (event: TerminalEvent) =>
      Effect.forEach([...listeners], (listener) => listener(event), { discard: true });
    // Real non-login /bin/sh, with no inherited HOME, profile or provider settings.
    // The adapter models PTY Enter translation and deliberately splits output into
    // small chunks; script bytes and completion sentinels execute unchanged.
    const manager = Layer.mock(Terminal.TerminalManager)({
      open: (input) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(input.cwd).pipe(Effect.orDie)))
            return yield* new TerminalCwdNotFoundError({ cwd: input.cwd });
          terminal = input;
          opens.push(input);
          return {
            ...input,
            worktreePath: input.worktreePath ?? null,
            status: "running" as const,
            pid: 0,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "Owned shell",
            updatedAt: "2026-10-09T00:00:00.000Z",
          };
        }),
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }),
      closeIdle: ({ terminalId }) =>
        Effect.sync(() => {
          const id = terminalId ?? "default";
          closed.push(id);
          return [id];
        }),
      write: (input) => {
        if (options.writeFailure)
          return Effect.fail(
            new TerminalWriteError({
              ...input,
              terminalPid: 0,
              cause: new Error("owned transport closed before write"),
            }),
          );
        return Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              const child = spawn("/bin/sh", ["-c", input.data.replaceAll("\r", "\n")], {
                cwd: terminal!.cwd,
                env: { PATH: "/usr/bin:/bin", HOME: root, ...terminal!.env },
                stdio: ["ignore", "pipe", "pipe"],
              });
              if (child.pid) pids.push(child.pid);
              let outputs = Promise.resolve();
              const forward = (buffer: Buffer) => {
                const text = buffer.toString();
                for (let at = 0; at < text.length; at += 7) {
                  const data = text.slice(at, at + 7);
                  outputs = outputs.then(() =>
                    Effect.runPromise(
                      emit({
                        type: "output",
                        threadId: input.threadId,
                        terminalId: input.terminalId,
                        data,
                      }),
                    ),
                  );
                }
              };
              child.stdout.on("data", forward);
              child.stderr.on("data", forward);
              child.once("error", reject);
              child.once("close", () => {
                void outputs
                  .then(() =>
                    Effect.runPromise(
                      emit({
                        type: "closed",
                        threadId: input.threadId,
                        terminalId: input.terminalId,
                      }),
                    ),
                  )
                  .then(resolve, reject);
              });
            }),
          catch: (cause) =>
            new TerminalWriteError({ ...input, terminalPid: pids.at(-1) ?? 0, cause }),
        });
      },
    });
    const runner = yield* Setup.make.pipe(
      Effect.provide(Layer.mergeAll(projects, manager, Settings.layerTest())),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { SHELL: "/bin/sh" }),
    );
    const lines: string[] = [];
    const input = {
      threadId: "owned-setup-thread",
      projectId,
      worktreePath: worktree,
      observeCompletion: {
        onOutputLine: (line: string) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    };
    return {
      fs,
      root,
      worktree,
      runner,
      input,
      lines,
      closed,
      opens,
      pids,
      listeners,
      emit,
      scripts,
    };
  });

// These run the POSIX `( ... ); printf sentinel` completion wrapper through a real
// /bin/sh, which only non-Windows hosts use; Windows hosts wrap for PowerShell.
const posixShellIt = it.effect.skipIf(process.platform === "win32");

posixShellIt(
  "runs a persisted setup script in its worktree with isolated project environment and real exit status",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        'printf "%s\\n%s\\n" "$STUDIO_PROJECT_ROOT" "$STUDIO_WORKTREE_PATH" > paths.txt\nprintf "\\033[32minstalled\\033[0m\\n"\n# trailing comment',
      );
      const result = yield* f.runner.runForThread(f.input);
      expect(result.status).toBe("started");
      if (result.status !== "started" || !result.completion) throw new Error("completion missing");
      expect(result).toMatchObject({ terminalId: "setup-install", async: false, cwd: f.worktree });
      expect(yield* result.completion).toMatchObject({ exitCode: 0 });
      expect(yield* f.fs.readFileString(`${f.worktree}/paths.txt`)).toBe(
        `${f.root}\n${f.worktree}\n`,
      );
      expect(f.lines).toEqual(["installed"]);
      expect(f.opens[0]?.env).toMatchObject({ NO_COLOR: "1", FORCE_COLOR: "0", COLORTERM: "" });
      expect(f.closed).toEqual(["setup-install"]);
      expect(f.listeners.size).toBe(0);
      expect(f.pids).toHaveLength(1);
      expect(() => process.kill(f.pids[0]!, 0)).toThrow();
    }).pipe(Effect.provide(layer)),
);

posixShellIt(
  "returns nonzero shell status without closing the failed terminal and caps forwarded output",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        'printf "first\\rsecond\\n"; printf "%0500d\\n" 0; printf "%05000d" 0; exit 7',
      );
      const result = yield* f.runner.runForThread({
        ...f.input,
        preferredTerminalId: "owned-custom-terminal",
      });
      if (result.status !== "started" || !result.completion) throw new Error("completion missing");
      expect(yield* result.completion).toMatchObject({ exitCode: 7 });
      expect(f.lines.slice(0, 2)).toEqual(["first", "second"]);
      expect(f.lines[2]).toHaveLength(400);
      expect(f.lines.every((line) => line.length <= 400)).toBe(true);
      expect(f.lines.join("\n")).not.toContain("__STUDIO_SETUP_DONE__");
      expect(f.closed).toEqual([]);
      expect(f.listeners.size).toBe(0);
    }).pipe(Effect.provide(layer)),
);

posixShellIt(
  "reports unknown completion when the real shell terminates before printing its sentinel",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture('printf "starting\\n"; kill -TERM $$');
      // POSIX $$ inside the subshell targets this test-owned wrapper shell.
      const result = yield* f.runner.runForThread({
        ...f.input,
        project: { id: projectId, workspaceRoot: f.root, scripts: f.scripts },
      });
      if (result.status !== "started" || !result.completion) throw new Error("completion missing");
      expect(yield* result.completion).toMatchObject({ exitCode: null });
      expect(f.lines).toEqual(["starting"]);
      expect(f.closed).toEqual([]);
      expect(f.listeners.size).toBe(0);
    }).pipe(Effect.provide(layer)),
);

posixShellIt(
  "looks up the persisted project by workspace when ID is missing and executes unobserved setup",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture('printf "ready" > unobserved.txt');
      const result = yield* f.runner.runForThread({
        threadId: f.input.threadId,
        projectCwd: f.root,
        worktreePath: f.worktree,
      });
      expect(result).toMatchObject({ status: "started", async: false });
      expect(result).not.toHaveProperty("completion");
      expect(yield* f.fs.readFileString(`${f.worktree}/unobserved.txt`)).toBe("ready");
      expect(f.listeners.size).toBe(0);
    }).pipe(Effect.provide(layer)),
);

it.effect("does not open a process when no setup script or project exists", () =>
  Effect.gen(function* () {
    const f = yield* fixture("unused", { noScript: true });
    expect(yield* f.runner.runForThread(f.input)).toEqual({ status: "no-script" });
    const missing = yield* Effect.flip(f.runner.runForThread({ ...f.input, projectId: "unknown" }));
    expect(missing._tag).toBe("ProjectSetupScriptProjectNotFoundError");
    expect(f.opens).toEqual([]);
    expect(f.pids).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves the opening error when the owned worktree disappeared before setup", () =>
  Effect.gen(function* () {
    const f = yield* fixture("printf ready");
    yield* f.fs.remove(f.worktree, { recursive: true });
    const failure = yield* Effect.flip(f.runner.runForThread(f.input));
    expect(failure).toMatchObject({
      _tag: "ProjectSetupScriptOperationError",
      operation: "openTerminal",
    });
    expect(f.pids).toEqual([]);
    expect(f.listeners.size).toBe(0);
  }).pipe(Effect.provide(layer)),
);

it.effect("unsubscribes when terminal input fails so an orphan observer cannot settle later", () =>
  Effect.gen(function* () {
    const f = yield* fixture("printf ready", { writeFailure: true });
    const failure = yield* Effect.flip(f.runner.runForThread(f.input));
    expect(failure).toMatchObject({
      _tag: "ProjectSetupScriptOperationError",
      operation: "writeCommand",
    });
    expect(f.listeners.size).toBe(0);
    expect(f.pids).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

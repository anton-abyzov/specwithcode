// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A stand-in specweave CLI over a scratch worktree, and binding files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadIncrementProgress,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as IncrementProgress from "../../../project/ThreadIncrementProgressService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { SpecweaveCommandOverride } from "./cli.ts";
import {
  foldedFromList,
  ledgerWriteArgs,
  planLedgerCall,
  runLedgerCall,
  holdOwner,
  recordWrittenHold,
  type FoldedTask,
} from "./ledgerHandlers.ts";

const isWindows = HostProcessPlatform.defaultValue() === "win32";
const INCREMENT = "1497-ledger-tools";
const AGENT = "claude@scratch";

/**
 * A stand-in `specweave` over `state.json`: `task list` prints the tasks as
 * the caller's agent (`<SPECWEAVE_TOOL>@scratch`), `claim`, `release` and
 * `block` change them and append their argv and SpecWeave variables to
 * `writes.jsonl`. `state.exit` makes one action exit with a code instead.
 */
const STAND_IN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const stateFile = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const argv = process.argv.slice(2);
const at = argv.indexOf("task");
const action = argv[at + 1];
const agent = (process.env.SPECWEAVE_AGENT || "") || process.env.SPECWEAVE_TOOL + "@scratch";
if (action === "list") {
  process.stdout.write(JSON.stringify({ increment: argv[at + 2], agent, tasks: state.tasks }));
  process.exit(0);
}
fs.appendFileSync(path.join(dir, "writes.jsonl"), JSON.stringify({ argv, thread: process.env.SPECWEAVE_STUDIO_THREAD_ID, tool: process.env.SPECWEAVE_TOOL, agentSet: process.env.SPECWEAVE_AGENT !== undefined, agentValue: process.env.SPECWEAVE_AGENT, session: process.env.CLAUDE_CODE_SESSION_ID }) + "\\n");
if (state.exit && state.exit[action]) { process.stderr.write("refused by the CLI"); process.exit(state.exit[action]); }
const task = state.tasks.find((t) => t.id === argv[at + 2]);
if (action === "claim") Object.assign(task, { status: "claimed", by: agent, since: new Date().toISOString() });
if (action === "release") { task.status = "open"; delete task.by; delete task.since; }
if (action === "block") Object.assign(task, { status: "blocked", by: agent, since: new Date().toISOString(), note: argv.find((a) => a.startsWith("--reason=")).slice(9) });
fs.writeFileSync(stateFile, JSON.stringify(state));
process.stdout.write(action === "claim" ? JSON.stringify({ claimed: task.id, by: agent }) : action + " " + task.id);
`;

interface Scratch {
  readonly root: string;
  readonly worktree: string;
  readonly increment: string;
  readonly cli: string;
  readonly writes: () => ReadonlyArray<{
    argv: string[];
    thread: string;
    tool: string;
    agentSet: boolean;
    agentValue?: string;
    session: string;
  }>;
  readonly setTasks: (tasks: ReadonlyArray<FoldedTask>, exit?: Record<string, number>) => void;
}

const scratch = Effect.acquireRelease(
  Effect.sync((): Scratch => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-ledger-")),
    );
    const worktree = NodePath.join(root, "worktree");
    const increment = NodePath.join(worktree, ".specweave", "increments", INCREMENT);
    NodeFS.mkdirSync(increment, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(worktree, ".specweave", "config.json"), "{}\n");
    NodeFS.writeFileSync(NodePath.join(increment, "ledger.jsonl"), "");
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    const cli = NodePath.join(bin, "specweave");
    NodeFS.writeFileSync(cli, STAND_IN, { mode: 0o755 });
    const setTasks = (tasks: ReadonlyArray<FoldedTask>, exit?: Record<string, number>) =>
      NodeFS.writeFileSync(NodePath.join(bin, "state.json"), JSON.stringify({ tasks, exit }));
    setTasks([
      { id: "T-01", status: "open" },
      {
        id: "T-02",
        status: "claimed",
        by: "codex@other-machine",
        since: "2026-11-26T10:00:00.000Z",
      },
      { id: "T-03", status: "done", by: AGENT },
    ]);
    const writes = () => {
      const file = NodePath.join(bin, "writes.jsonl");
      return NodeFS.existsSync(file)
        ? NodeFS.readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    };
    return { root, worktree, increment, cli, writes, setTasks };
  }),
  ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

const threadId = ThreadId.make("thread-ledger");

const progressEntry = (
  increment: string,
  binding: ThreadIncrementProgress["binding"] = "claim",
): ThreadIncrementProgress => ({
  threadId,
  incrementId: INCREMENT,
  binding,
  boundTaskId: null,
  title: null,
  status: "active",
  incrementPath: increment,
  specPath: null,
  readable: true,
  tasks: [],
  criteria: [],
  verify: null,
});

const services = (
  fixture: Scratch,
  options: {
    readonly bound?: ThreadIncrementProgress | null;
    readonly caller?: "thread" | "client";
    readonly providerInstanceId?: string;
    readonly threadIdOverride?: ThreadId;
    /** Other live threads in the same checkout. */
    readonly siblings?: ReadonlyArray<ThreadId>;
    /** The project's thread list cannot be read. */
    readonly listFails?: boolean;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  } = {},
) => {
  const caller = options.threadIdOverride ?? threadId;
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-ledger"),
    requestNamespace: "ledger",
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 1,
    thread:
      options.caller === "client"
        ? undefined
        : {
            threadId: caller,
            providerSessionId: "provider-session-ledger",
            providerInstanceId: ProviderInstanceId.make(
              options.providerInstanceId ?? "claudeAgent",
            ),
          },
    client:
      options.caller === "client"
        ? { sessionId: "client", label: "outside agent", access: "full-access" }
        : undefined,
  };
  return Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed({ ...liveThreadShell(id), worktreePath: fixture.worktree }),
      listProjectThreads: () =>
        options.listFails
          ? Effect.fail(
              new ThreadManagement.ThreadManagementProjectionLoadError({
                projectId: liveThreadShell(threadId).projectId,
                threadId,
                cause: new Error("list failed"),
              }),
            )
          : Effect.succeed(
              [threadId, ...(options.siblings ?? [])].map((id) => ({
                ...liveThreadShell(id),
                worktreePath: fixture.worktree,
              })),
            ),
    }),
    Layer.mock(IncrementProgress.ThreadIncrementProgressService)({
      read: (input) =>
        Effect.succeed({
          projectId: input.projectId,
          threads:
            options.bound === null
              ? []
              : [{ ...(options.bound ?? progressEntry(fixture.increment)), threadId: caller }],
        }),
    }),
    ServerSettings.layerTest(options.settings ?? {}),
    Layer.succeed(SpecweaveCommandOverride, fixture.cli),
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
  );
};

const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(error).toBeInstanceOf(OrchestratorMcpFailure);
      return error as OrchestratorMcpFailure;
    }),
  );

const skipOnWindows = it.effect.skipIf(isWindows);

describe("SpecWeave ledger tools (1497)", () => {
  skipOnWindows(
    "claim, re-claim, block, re-block, release and re-release write one event per change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* scratch;
          const layer = services(fixture);
          const call = (action: "claim" | "release" | "block", reason?: string) =>
            runLedgerCall({ action, increment: "1497", task: "T-01", reason }).pipe(
              Effect.provide(layer),
            );

          const claimed = yield* call("claim");
          expect(claimed).toMatchObject({
            changed: true,
            status: "claimed",
            by: AGENT,
            agent: AGENT,
          });
          expect(claimed.command).toContain("task claim T-01 1497-ledger-tools --no-commit --json");
          expect(yield* call("claim")).toMatchObject({
            changed: false,
            status: "claimed",
            command: null,
          });

          expect(yield* call("block", "waiting on the API key")).toMatchObject({
            changed: true,
            status: "blocked",
          });
          expect(yield* call("block", "waiting on the API key")).toMatchObject({ changed: false });
          // The same reason with other spacing is the same reason.
          expect(yield* call("block", "  waiting  on the\tAPI key ")).toMatchObject({
            changed: false,
          });
          expect(yield* call("block", "waiting on review")).toMatchObject({ changed: true });

          expect(yield* call("release")).toMatchObject({ changed: true, status: "open", by: null });
          expect(yield* call("release")).toMatchObject({ changed: false, status: "open" });

          const writes = fixture.writes();
          expect(writes.map((write) => write.argv.slice(2))).toEqual([
            ["task", "claim", "T-01", INCREMENT, "--no-commit", "--json"],
            [
              "task",
              "block",
              "T-01",
              INCREMENT,
              "--reason=waiting on the API key",
              "--no-commit",
              "--json",
            ],
            [
              "task",
              "block",
              "T-01",
              INCREMENT,
              "--reason=waiting on review",
              "--no-commit",
              "--json",
            ],
            ["task", "release", "T-01", INCREMENT, "--no-commit", "--json"],
          ]);
          for (const write of writes) {
            expect(write.argv.slice(0, 2)).toEqual(["--workspace", fixture.worktree]);
            expect(write).toMatchObject({
              thread: threadId,
              tool: "claude",
              agentSet: false,
              session: "",
            });
            for (const flag of ["--force", "-f", "--all-mine", "--run"])
              expect(write.argv).not.toContain(flag);
          }
        }),
      ),
  );

  skipOnWindows("names the holder of a task another agent holds, and writes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        const layer = services(fixture);
        for (const action of ["claim", "release", "block"] as const) {
          const error = yield* refusal(
            runLedgerCall({ action, increment: "1497", task: "T-02", reason: "x y z" }).pipe(
              Effect.provide(layer),
            ),
          );
          expect(error.code).toBe("capability_denied");
          expect(error.message).toContain("held by another agent: claimed by codex@other-machine");
        }
        const done = yield* refusal(
          runLedgerCall({ action: "claim", increment: "1497", task: "T-03" }).pipe(
            Effect.provide(layer),
          ),
        );
        expect(done.message).toContain("already done");
        const missing = yield* refusal(
          runLedgerCall({ action: "claim", increment: "1497", task: "T-09" }).pipe(
            Effect.provide(layer),
          ),
        );
        expect(missing.message).toContain("T-01, T-02, T-03");
        expect(fixture.writes()).toEqual([]);
      }),
    ),
  );

  skipOnWindows("passes the CLI's own refusal on, a lost race as capability_denied", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        fixture.setTasks([{ id: "T-01", status: "open" }], { claim: 3 });
        const error = yield* refusal(
          runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
            Effect.provide(services(fixture)),
          ),
        );
        expect(error.code).toBe("capability_denied");
        expect(error.message).toContain("refused by the CLI");
      }),
    ),
  );

  skipOnWindows(
    "refuses another increment, no assigned one, a coordinator without one, and an outside client",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* scratch;
          const other = yield* refusal(
            runLedgerCall({ action: "claim", increment: "1490", task: "T-01" }).pipe(
              Effect.provide(services(fixture)),
            ),
          );
          expect(other.message).toContain(`owns increment ${INCREMENT}, not 1490`);
          const none = yield* refusal(
            runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
              Effect.provide(services(fixture, { bound: null })),
            ),
          );
          expect(none.message).toContain("no increment assigned");
          // The coordinator's own thread is held to the same rule: no binding, no write.
          const coordinator = yield* refusal(
            runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
              Effect.provide(
                services(fixture, {
                  bound: null,
                  threadIdOverride: ThreadId.make("project-coordinator:project:mcp-test"),
                }),
              ),
            ),
          );
          expect(coordinator.code).toBe("capability_denied");
          const client = yield* refusal(
            runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
              Effect.provide(services(fixture, { caller: "client" })),
            ),
          );
          expect(client.message).toContain("not a thread");
          const guessed = yield* refusal(
            runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
              Effect.provide(
                services(fixture, { bound: progressEntry(fixture.increment, "name") }),
              ),
            ),
          );
          expect(guessed.message).toContain("only guessed");
          expect(fixture.writes()).toEqual([]);
        }),
      ),
  );

  skipOnWindows("refuses a provider whose SpecWeave agent is not known, rather than guess", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        const error = yield* refusal(
          runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
            Effect.provide(services(fixture, { providerInstanceId: "cursor" })),
          ),
        );
        expect(error.message).toContain("does not know which SpecWeave agent");
        expect(fixture.writes()).toEqual([]);
      }),
    ),
  );

  skipOnWindows("tells two threads with one agent id in one checkout apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        fixture.setTasks([
          { id: "T-01", status: "open" },
          // Claimed from some shell under the same agent id: nobody can tell which thread.
          { id: "T-04", status: "claimed", by: AGENT, since: "2026-11-26T09:00:00.000Z" },
        ]);
        const laneB = ThreadId.make("thread-ledger-lane-b");
        const asA = services(fixture, { siblings: [laneB] });
        const asB = services(fixture, { threadIdOverride: laneB });
        const call = (layer: typeof asA, action: "claim" | "release" | "block", task: string) =>
          runLedgerCall({ action, increment: "1497", task, reason: "x y z" }).pipe(
            Effect.provide(layer),
          );

        expect(yield* call(asA, "claim", "T-01")).toMatchObject({ changed: true });
        expect(yield* call(asA, "claim", "T-01")).toMatchObject({ changed: false });
        for (const action of ["claim", "release", "block"] as const) {
          const error = yield* refusal(call(asB, action, "T-01"));
          expect(error.message).toContain(`another thread, "${threadId}" (${threadId})`);
        }
        const unknown = yield* refusal(call(asA, "release", "T-04"));
        expect(unknown.message).toContain("cannot tell which of them took it");
        expect(fixture.writes()).toHaveLength(1);
      }),
    ),
  );

  skipOnWindows("refuses when the checkout's other threads cannot be listed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        const error = yield* refusal(
          runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
            Effect.provide(services(fixture, { listFails: true })),
          ),
        );
        expect(error.code).toBe("capability_denied");
        expect(error.message).toContain("could not list the other threads");
        expect(fixture.writes()).toEqual([]);
      }),
    ),
  );

  skipOnWindows("writes as the SpecWeave agent the provider instance sets for its shell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        const layer = services(fixture, {
          settings: {
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                environment: [{ name: "SPECWEAVE_AGENT", value: "claude@work-laptop" }],
              },
            },
          },
        });
        const claimed = yield* runLedgerCall({
          action: "claim",
          increment: "1497",
          task: "T-01",
        }).pipe(Effect.provide(layer));
        expect(claimed).toMatchObject({ changed: true, by: "claude@work-laptop" });
        expect(fixture.writes()[0]).toMatchObject({ agentValue: "claude@work-laptop" });
      }),
    ),
  );

  skipOnWindows("checks the files again under the lock, just before writing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        // A leftover temporary file: the CLI writes through that name.
        NodeFS.writeFileSync(NodePath.join(fixture.increment, "metadata.json.tmp"), "{}");
        const error = yield* refusal(
          runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
            Effect.provide(services(fixture)),
          ),
        );
        expect(error.message).toContain("left over from an interrupted write");
        expect(fixture.writes()).toEqual([]);
      }),
    ),
  );

  skipOnWindows("two claims at once write one event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* scratch;
        const layer = services(fixture);
        const results = yield* Effect.forEach(
          [1, 2, 3],
          () =>
            runLedgerCall({ action: "claim", increment: "1497", task: "T-01" }).pipe(
              Effect.provide(layer),
            ),
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result.changed)).toHaveLength(1);
        expect(fixture.writes()).toHaveLength(1);
      }),
    ),
  );
});

describe("planLedgerCall (1497)", () => {
  const task = (fields: Partial<FoldedTask>): FoldedTask => ({
    id: "T-01",
    status: "open",
    ...fields,
  });

  it("lets a stale claim of someone else's be claimed, but not released", () => {
    const stale = task({ status: "stale", by: "codex@x", since: "2026-11-20T00:00:00Z" });
    expect(
      planLedgerCall({ action: "claim", task: stale, agent: AGENT, owner: { kind: "caller" } }),
    ).toEqual({
      kind: "write",
    });
    expect(
      planLedgerCall({ action: "release", task: stale, agent: AGENT, owner: { kind: "caller" } }),
    ).toMatchObject({ kind: "refuse", code: "capability_denied" });
  });

  it("refuses a task another thread holds under the same agent id, naming the thread", () => {
    const held = task({ status: "claimed", by: AGENT, since: "2026-11-26T00:00:00Z" });
    for (const action of ["claim", "release", "block"] as const) {
      const plan = planLedgerCall({
        action,
        task: held,
        agent: AGENT,
        reason: "x y z",
        owner: { kind: "thread", name: '"Lane B" (thread-b)' },
      });
      expect(plan).toMatchObject({ kind: "refuse", code: "capability_denied" });
      expect(plan.kind === "refuse" && plan.message).toContain(
        'another thread, "Lane B" (thread-b)',
      );
    }
  });

  it("refuses a hold under the caller's agent id that no thread can be shown to own", () => {
    const held = task({ status: "blocked", by: AGENT, since: "2026-11-26T00:00:00Z" });
    const plan = planLedgerCall({
      action: "release",
      task: held,
      agent: AGENT,
      owner: { kind: "unknown", names: ['"Lane B" (thread-b)'] },
    });
    expect(plan).toMatchObject({ kind: "refuse", code: "capability_denied" });
    expect(plan.kind === "refuse" && plan.message).toContain("cannot tell which of them took it");
  });

  it("claims a task the caller blocked, and blocks a task it claimed", () => {
    const blocked = task({ status: "blocked", by: AGENT, note: "x" });
    expect(
      planLedgerCall({ action: "claim", task: blocked, agent: AGENT, owner: { kind: "caller" } })
        .kind,
    ).toBe("write");
    const claimed = task({ status: "claimed", by: AGENT });
    expect(
      planLedgerCall({
        action: "block",
        task: claimed,
        agent: AGENT,
        reason: "x y",
        owner: { kind: "caller" },
      }).kind,
    ).toBe("write");
  });
});

describe("ledgerWriteArgs (1497)", () => {
  it("keeps a reason that starts with a dash a value", () => {
    expect(
      ledgerWriteArgs({
        action: "block",
        taskId: "T-01",
        incrementId: INCREMENT,
        reason: "--force it",
      }),
    ).toEqual(["task", "block", "T-01", INCREMENT, "--reason=--force it", "--no-commit", "--json"]);
  });
});

describe("foldedFromList (1497)", () => {
  it("needs the agent and the tasks SpecWeave prints", () => {
    expect(foldedFromList({ tasks: [] })).toBeNull();
    expect(
      foldedFromList({ agent: AGENT, tasks: [{ id: "T-01", status: "open" }, { id: 3 }] }),
    ).toEqual({
      agent: AGENT,
      tasks: [{ id: "T-01", status: "open", by: undefined, since: undefined, note: undefined }],
    });
  });
});

describe("holdOwner (1497)", () => {
  const since = "2026-11-26T12:00:00.000Z";
  const withHome = async (
    body: (input: {
      home: string;
      worktree: string;
      write: (thread: string, fields?: Record<string, unknown>) => void;
    }) => Promise<void>,
  ) => {
    const home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-home-")),
    );
    const worktree = NodePath.join(home, "worktree");
    NodeFS.mkdirSync(worktree);
    const bindings = NodePath.join(home, ".specweave", "studio", "threads");
    NodeFS.mkdirSync(bindings, { recursive: true });
    const write = (thread: string, fields: Record<string, unknown> = {}) =>
      NodeFS.writeFileSync(
        NodePath.join(bindings, `${thread}.json`),
        JSON.stringify({
          version: 1,
          threadId: thread,
          root: worktree,
          incrementId: INCREMENT,
          taskId: "T-01",
          event: "claim",
          at: since,
          ...fields,
        }),
      );
    try {
      await body({ home, worktree, write });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  };
  let targets = 0;
  // Each target is its own increment folder, so holds recorded by one test never match another.
  const targetIn = (worktree: string) => ({
    workspace: worktree,
    specweaveRoot: worktree,
    incrementId: INCREMENT,
    incrementDir: `${worktree}/increment-${(targets += 1)}`,
  });
  const task: FoldedTask = { id: "T-01", status: "claimed", by: AGENT, since };
  const lanes = [
    { threadId: "thread-c", title: "Lane C" },
    { threadId: "thread-b", title: "Lane B" },
  ];

  it("is the caller when no other thread works in the checkout", async () => {
    await withHome(async ({ home, worktree }) => {
      expect(
        await holdOwner({
          target: targetIn(worktree),
          task,
          callerThreadId: "thread-a",
          siblings: [],
          home,
        }),
      ).toEqual({ kind: "caller" });
    });
  });

  it("names the sibling whose binding file records this very claim", async () => {
    await withHome(async ({ home, worktree, write }) => {
      write("thread-b");
      write("thread-c", { at: "2026-11-26T11:00:00.000Z" });
      expect(
        await holdOwner({
          target: targetIn(worktree),
          task,
          callerThreadId: "thread-a",
          siblings: lanes,
          home,
        }),
      ).toEqual({ kind: "thread", name: '"Lane B" (thread-b)' });
    });
  });

  it("refuses to guess once the holder's binding has moved on to another task", async () => {
    await withHome(async ({ home, worktree, write }) => {
      // Lane B blocked T-01, then claimed T-02: its binding now names T-02.
      write("thread-b", { taskId: "T-02" });
      expect(
        await holdOwner({
          target: targetIn(worktree),
          task,
          callerThreadId: "thread-a",
          siblings: lanes,
          home,
        }),
      ).toEqual({
        kind: "unknown",
        names: ['"Lane C" (thread-c)', '"Lane B" (thread-b)'],
      });
    });
  });

  it("knows the holds these tools wrote, for the caller and for a sibling", async () => {
    await withHome(async ({ home, worktree }) => {
      const mine = targetIn(worktree);
      recordWrittenHold(mine, task, "thread-a");
      expect(
        await holdOwner({ target: mine, task, callerThreadId: "thread-a", siblings: lanes, home }),
      ).toEqual({ kind: "caller" });
      const theirs = targetIn(worktree);
      recordWrittenHold(theirs, task, "thread-b");
      expect(
        await holdOwner({
          target: theirs,
          task,
          callerThreadId: "thread-a",
          siblings: lanes,
          home,
        }),
      ).toEqual({ kind: "thread", name: '"Lane B" (thread-b)' });
    });
  });

  it("is the caller when its own binding file records the claim", async () => {
    await withHome(async ({ home, worktree, write }) => {
      write("thread-a");
      expect(
        await holdOwner({
          target: targetIn(worktree),
          task,
          callerThreadId: "thread-a",
          siblings: lanes,
          home,
        }),
      ).toEqual({ kind: "caller" });
    });
  });
});

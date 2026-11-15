// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  agentMemoryNotice,
  commandOf,
  makeAgentMemoryNotice,
  parseOomKills,
  type RecordedProcess,
  threadIdOf,
} from "./AgentMemoryNotice.ts";

const GIB = 1024 ** 3;
const PAGES_PER_GIB = GIB / 4096;

const stat = (pid: number, comm: string, pages: number, startTime = "100") =>
  `${pid} (${comm}) S 1 1 1 0 -1 4194304 1 0 0 0 1 1 0 0 20 0 1 0 ${startTime} 1000 ${pages} 18446744073709551615`;

describe("parsers", () => {
  it("reads the kill count, the command and the thread", () => {
    assert.equal(parseOomKills("low 0\nhigh 0\nmax 12\noom 2\noom_kill 3\noom_group_kill 0\n"), 3);
    assert.isNull(parseOomKills(""));
    assert.equal(commandOf("node\0/repo/node_modules/typescript/bin/tsc\0-p\0.\0", "node"), "node /repo/node_modules/typescript/bin/tsc -p .");
    assert.equal(commandOf("", "tsc"), "tsc");
    assert.equal(commandOf("x".repeat(400), "x").length, 160);
    assert.equal(threadIdOf("HOME=/h\0SPECWEAVE_STUDIO_THREAD_ID=thread-1\0PATH=/b\0"), "thread-1");
    assert.isUndefined(threadIdOf("HOME=/h\0SPECWEAVE_STUDIO_THREAD_ID=\0"));
    assert.isUndefined(threadIdOf(""));
  });

  it("names the command, the limit and what to do", () => {
    const message = agentMemoryNotice({
      ended: { pid: 42, startTime: "1", rssBytes: 7.5 * GIB, command: "tsc -p .", threadId: "t" },
      limitBytes: 18 * GIB,
    });
    assert.include(message.text, "`tsc -p .`");
    assert.include(message.text, "7.5 GB");
    assert.include(message.text, "memory limit of 18.0 GB");
    assert.include(message.text, "Run fewer heavy checks at once");
    assert.deepEqual(message.notification, {
      source: { kind: "command" },
      outcome: "failed",
      summary: "A command was ended: agent work reached its memory limit of 18.0 GB.",
    });
  });
});

type Proc = readonly [pid: number, comm: string, gib: number, threadId?: string, startTime?: string];

function fakeMachine() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-memory-notice-"));
  const proc = NodePath.join(root, "proc");
  const agents = NodePath.join(root, "cgroup/agents");
  NodeFS.mkdirSync(NodePath.join(proc, "self"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(agents, "studio-acp-1-x"), { recursive: true });
  const start = (where: string, [pid, comm, gib, threadId, startTime]: Proc) => {
    const dir = NodePath.join(proc, String(pid));
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "stat"), stat(pid, comm, gib * PAGES_PER_GIB, startTime));
    NodeFS.writeFileSync(NodePath.join(dir, "cmdline"), `${comm}\0--build\0`);
    NodeFS.writeFileSync(
      NodePath.join(dir, "environ"),
      threadId === undefined ? "HOME=/h\0" : `HOME=/h\0SPECWEAVE_STUDIO_THREAD_ID=${threadId}\0`,
    );
    const procs = NodePath.join(where, "cgroup.procs");
    const before = NodeFS.existsSync(procs) ? NodeFS.readFileSync(procs, "utf8") : "";
    NodeFS.writeFileSync(procs, `${before}${pid}\n`);
  };
  const machine = {
    proc,
    group: () => ({ relativePath: "/agents", path: agents, limitBytes: 10 * GIB, appsPath: "/apps" }),
    start: (each: Proc) => start(agents, each),
    startInSession: (each: Proc) => start(NodePath.join(agents, "studio-acp-1-x"), each),
    end: (pid: number) => NodeFS.rmSync(NodePath.join(proc, String(pid)), { recursive: true }),
    use: (gib: number) => NodeFS.writeFileSync(NodePath.join(agents, "memory.current"), `${gib * GIB}\n`),
    kills: (count: number) =>
      NodeFS.writeFileSync(NodePath.join(agents, "memory.events"), `max 9\noom 1\noom_kill ${count}\n`),
  };
  machine.use(1);
  machine.kills(0);
  return machine;
}

const told = () => {
  const messages: Array<readonly [RecordedProcess, number]> = [];
  return {
    messages,
    notify: (ended: RecordedProcess, limitBytes: number) =>
      Effect.sync(() => void messages.push([ended, limitBytes])),
  };
};

describe("makeAgentMemoryNotice", () => {
  it.effect("tells the thread whose command the kernel ended", () =>
    Effect.gen(function* () {
      const machine = fakeMachine();
      const sink = told();
      const notice = yield* makeAgentMemoryNotice({ procRoot: machine.proc, group: machine.group, notify: sink.notify });
      machine.start([10, "claude", 0.5, "thread-a"]);
      machine.start([11, "tsc", 6, "thread-a"]);
      machine.startInSession([20, "vitest", 2, "thread-b"]);
      machine.start([30, "bash", 0.01]);
      yield* notice.pass;
      assert.deepEqual(notice.state.recorded, [], "far below the limit nothing is recorded");

      machine.use(9);
      yield* notice.pass;
      assert.deepEqual(
        notice.state.recorded.map((each) => [each.pid, each.threadId]),
        [
          [11, "thread-a"],
          [20, "thread-b"],
          [10, "thread-a"],
        ],
      );

      machine.end(11);
      machine.kills(1);
      machine.use(3);
      yield* notice.pass;
      assert.equal(sink.messages.length, 1);
      const [ended, limit] = sink.messages[0]!;
      assert.deepEqual(
        { pid: ended.pid, threadId: ended.threadId, command: ended.command, rssBytes: ended.rssBytes },
        { pid: 11, threadId: "thread-a", command: "tsc --build", rssBytes: 6 * GIB },
      );
      assert.equal(limit, 10 * GIB);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tells a thread once a minute, and only about processes that are gone", () =>
    Effect.gen(function* () {
      const machine = fakeMachine();
      const sink = told();
      const notice = yield* makeAgentMemoryNotice({ procRoot: machine.proc, group: machine.group, notify: sink.notify });
      machine.use(9);
      machine.start([11, "tsc", 4, "thread-a"]);
      machine.start([12, "tsc", 3, "thread-a"]);
      machine.start([13, "vite", 2, "thread-b"]);
      yield* notice.pass;

      // Two were ended, the largest: both thread-a's, so one message. Pid 13 now
      // names another process, but only two were ended.
      machine.end(11);
      machine.end(12);
      machine.end(13);
      machine.start([13, "sleep", 2, "thread-b", "999"]);
      machine.kills(2);
      yield* notice.pass;
      assert.deepEqual(sink.messages.map(([each]) => each.pid), [11]);

      machine.start([14, "tsc", 4, "thread-a"]);
      yield* notice.pass;
      machine.end(14);
      machine.kills(3);
      yield* notice.pass;
      assert.equal(sink.messages.length, 1, "not again within a minute");

      yield* TestClock.adjust("61 seconds");
      machine.start([15, "tsc", 4, "thread-a"]);
      yield* notice.pass;
      machine.end(15);
      machine.kills(4);
      yield* notice.pass;
      assert.deepEqual(sink.messages.map(([each]) => each.pid), [11, 15]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("blames only as many as the kernel ended, largest first", () =>
    Effect.gen(function* () {
      const machine = fakeMachine();
      const sink = told();
      const notice = yield* makeAgentMemoryNotice({
        procRoot: machine.proc,
        group: machine.group,
        notify: sink.notify,
      });
      machine.use(9);
      machine.start([11, "tsc", 6, "thread-a"]);
      machine.start([12, "vitest", 2, "thread-b"]);
      yield* notice.pass;
      // The typecheck was ended; the test run finished on its own at the same time.
      machine.end(11);
      machine.end(12);
      machine.kills(1);
      yield* notice.pass;
      assert.deepEqual(
        sink.messages.map(([each]) => each.threadId),
        ["thread-a"],
      );
      assert.deepEqual(notice.state.recorded, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says nothing for a terminal command, before the limit is on, or on the first count", () =>
    Effect.gen(function* () {
      const machine = fakeMachine();
      const sink = told();
      let on = false;
      const notice = yield* makeAgentMemoryNotice({
        procRoot: machine.proc,
        group: () => (on ? machine.group() : undefined),
        notify: sink.notify,
      });
      machine.use(9);
      machine.kills(5);
      machine.start([11, "tsc", 4]);
      yield* notice.pass;
      on = true;
      yield* notice.pass;
      assert.deepEqual(sink.messages, [], "kills from before are not news");
      machine.end(11);
      machine.kills(6);
      yield* notice.pass;
      assert.deepEqual(sink.messages, [], "no thread to tell");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

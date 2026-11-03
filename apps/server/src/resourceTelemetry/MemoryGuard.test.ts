// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  AGENT_WORK_OOM_SCORE_ADJ,
  descendantsOf,
  isRerunnableBuild,
  isMemoryCritical,
  makeMemoryGuard,
  pageBytesFrom,
  parseMemory,
  parseProcessStat,
  runGuardPasses,
  victimCandidates,
} from "./MemoryGuard.ts";

const GIB = 1024 ** 3;

/** The sample from the kernel's report at the November 2, 2026 kill on Ministorm. */
const AT_THE_KILL = {
  totalKb: 30_044_996,
  availableKb: 180_000,
  swapTotalKb: 8_388_604,
  swapFreeKb: 252,
  pressureFull: 40,
};

const stat = (pid: number, comm: string, ppid: number, rssPages: number) =>
  `${pid} (${comm}) S ${ppid} 1 1 0 -1 4194304 1 0 0 0 1 1 0 0 20 0 1 0 100 1000 ${rssPages} 18446744073709551615`;

describe("parsers", () => {
  it("reads memory and pressure", () => {
    const memory = parseMemory(
      "MemTotal:       1000 kB\nMemFree: 5 kB\nMemAvailable:    50 kB\nSwapTotal:      200 kB\nSwapFree:        10 kB\n",
      "some avg10=1.00 avg60=0 avg300=0 total=5\nfull avg10=33.50 avg60=0 avg300=0 total=5\n",
    );
    assert.deepEqual(memory, {
      totalKb: 1000,
      availableKb: 50,
      swapTotalKb: 200,
      swapFreeKb: 10,
      pressureFull: 33.5,
    });
  });

  it("has no sample without the required fields, and no pressure without PSI", () => {
    assert.isNull(parseMemory("MemFree: 5 kB\n", ""));
    assert.isNull(parseMemory("MemTotal: 5 kB\nMemAvailable: 1 kB\n", "")?.pressureFull ?? null);
  });

  it("reads a stat line whose name holds spaces and parentheses", () => {
    assert.deepEqual(parseProcessStat(stat(42, "Web (Content) x", 7, 3)), {
      pid: 42,
      ppid: 7,
      comm: "Web (Content) x",
      rssBytes: 3 * 4096,
      startTime: "100",
    });
    assert.equal(parseProcessStat(stat(42, "x", 7, 3), 65536)?.rssBytes, 3 * 65536);
    assert.isNull(parseProcessStat("garbage"));
  });
});

describe("pageBytesFrom", () => {
  it("measures the page size, falling back to 4 KiB", () => {
    assert.equal(pageBytesFrom("VmRSS:\t  8000 kB\n", "99 2000 1"), 4096);
    assert.equal(pageBytesFrom("VmRSS:\t  8000 kB\n", "99 125 1"), 65536);
    assert.equal(pageBytesFrom("", ""), 4096);
  });
});

describe("isRerunnableBuild", () => {
  it("knows builds by name or by a script path", () => {
    assert.isTrue(isRerunnableBuild("tsc", ""));
    assert.isTrue(
      isRerunnableBuild(
        "node",
        "node\0--experimental-import-meta-resolve\0--require\0/x/suppress-warnings.cjs\0--conditions\0node\0--conditions\0development\0/repo/node_modules/.pnpm/vitest@5/node_modules/vitest/dist/workers/forks.js\0",
      ),
    );
    assert.isTrue(isRerunnableBuild("node", "node\0/repo/node_modules/.bin/vite\0build\0"));
    assert.isTrue(
      isRerunnableBuild("node", "node\0/repo/node_modules/typescript/bin/tsc\0-p\0.\0"),
    );
  });

  it("does not take an agent harness, even one whose prompt names a build", () => {
    assert.isFalse(isRerunnableBuild("claude", "claude\0--output-format\0stream-json\0"));
    assert.isFalse(
      isRerunnableBuild("node", "node\0/usr/lib/gemini/gemini.js\0-p\0run vite build\0"),
    );
    assert.isFalse(isRerunnableBuild("codex", "codex\0app-server\0"));
    assert.isFalse(
      isRerunnableBuild(
        "node",
        "node\0/usr/lib/gemini/gemini.js\0-p\0fix apps/web/vite.config.ts\0",
      ),
    );
    assert.isFalse(isRerunnableBuild("claude", "claude\0--add-dir\0/home/a/next/app\0"));
    assert.isFalse(isRerunnableBuild("node", "node\0--env-file\0/x/next\0/usr/lib/claude.js\0"));
    assert.isFalse(isRerunnableBuild("node", "node\0-e\0vite\0"));
    assert.isFalse(isRerunnableBuild("codex", "codex\0-C\0/repo/vite\0"));
    assert.isFalse(
      isRerunnableBuild("node", "node\0/repo/node_modules/@acme/agent/cli.js\0/repo/vite\0"),
    );
  });
});

describe("isMemoryCritical", () => {
  it("is critical at the conditions of the real kill", () => {
    assert.isTrue(isMemoryCritical(AT_THE_KILL));
  });

  it("is not critical while swap has room or plenty is available", () => {
    assert.isFalse(isMemoryCritical({ ...AT_THE_KILL, swapFreeKb: 4_000_000, pressureFull: 0 }));
    assert.isFalse(isMemoryCritical({ ...AT_THE_KILL, availableKb: 19_000_000, pressureFull: 90 }));
  });

  it("counts no swap as swap gone, and sustained pressure with little available", () => {
    assert.isTrue(
      isMemoryCritical({ ...AT_THE_KILL, swapTotalKb: 0, swapFreeKb: 0, pressureFull: null }),
    );
    assert.isTrue(
      isMemoryCritical({
        ...AT_THE_KILL,
        availableKb: 2_500_000,
        swapFreeKb: 4_000_000,
        pressureFull: 30,
      }),
    );
  });
});

describe("victimCandidates", () => {
  const entry = (pid: number, comm: string, ppid: number, rssBytes: number) => ({
    pid,
    ppid,
    comm,
    rssBytes,
    startTime: "1",
  });
  const tree = [
    entry(10, "claude", 1, 3 * GIB),
    entry(11, "tsc", 10, 4 * GIB),
    entry(12, "node", 10, 3 * GIB),
    entry(13, "small", 12, GIB - 1),
    entry(99, "chrome", 50, 7 * GIB),
  ];

  it("lists what is below a direct child, largest first, above the size floor", () => {
    assert.deepEqual(
      victimCandidates(descendantsOf(1, tree)).map((candidate) => candidate.comm),
      ["tsc", "node"],
    );
  });

  it("never lists a direct child, or anything outside the tree", () => {
    assert.deepEqual(victimCandidates(descendantsOf(1, [tree[0]!, tree[4]!])), []);
  });

  it("leaves out an app the user opened, and its tree", () => {
    const opened = [entry(20, "idea", 1, GIB), entry(21, "tsgo", 20, 4 * GIB)];
    assert.deepEqual(
      descendantsOf(1, opened, (pid) => pid === 20),
      [],
    );
  });

  it("keeps a detached terminal or harness tree in", () => {
    const terminal = [entry(30, "bash", 1, GIB), entry(31, "tsc", 30, 4 * GIB)];
    assert.equal(victimCandidates(descendantsOf(1, terminal))[0]?.comm, "tsc");
  });
});

/** A fake /proc: real files, so writes and reads go through the real file system. */
function fakeProc(
  entries: ReadonlyArray<readonly [number, string, number, number]>,
  meminfo: string,
) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "memory-guard-"));
  NodeFS.writeFileSync(NodePath.join(root, "meminfo"), meminfo);
  NodeFS.mkdirSync(NodePath.join(root, "pressure"));
  NodeFS.writeFileSync(NodePath.join(root, "pressure/memory"), "full avg10=0.00\n");
  for (const [pid, comm, ppid, pages] of entries) {
    NodeFS.mkdirSync(NodePath.join(root, String(pid)));
    NodeFS.writeFileSync(NodePath.join(root, String(pid), "stat"), stat(pid, comm, ppid, pages));
    NodeFS.writeFileSync(NodePath.join(root, String(pid), "oom_score_adj"), "200");
  }
  return root;
}

const CRITICAL = "MemTotal: 1000 kB\nMemAvailable: 10 kB\nSwapTotal: 100 kB\nSwapFree: 1 kB\n";
const HEALTHY = "MemTotal: 1000 kB\nMemAvailable: 800 kB\nSwapTotal: 100 kB\nSwapFree: 90 kB\n";
const GIB_PAGES = GIB / 4096;
const TREE = [
  [1, "node", 0, 1000],
  [10, "claude", 1, 2 * GIB_PAGES],
  [11, "tsc", 10, 4 * GIB_PAGES],
  [12, "cloudflared", 1, 100],
  [99, "chrome", 50, 7 * GIB_PAGES],
] as const;

/** The guard's follow-up reads real files, which the test clock does not wait for. */
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)));

const signalLog = () => {
  const sent: Array<[number, string]> = [];
  return { sent, signal: (pid: number, name: string) => void sent.push([pid, name]) };
};

const adj = (root: string, pid: number) =>
  NodeFS.readFileSync(NodePath.join(root, String(pid), "oom_score_adj"), "utf8");

describe("a guard pass", () => {
  it.effect("marks the tree on a scan and ends nothing while memory is healthy", () =>
    Effect.gen(function* () {
      const root = fakeProc(TREE, HEALTHY);
      const sent: Array<[number, string]> = [];
      const guard = yield* makeMemoryGuard({
        procRoot: root,
        rootPid: 1,
        signal: (pid, name) => void sent.push([pid, name]),
      });
      yield* guard.pass(false);
      assert.equal(adj(root, 11), "200");

      yield* guard.pass(true);
      assert.equal(adj(root, 10), String(AGENT_WORK_OOM_SCORE_ADJ));
      assert.equal(adj(root, 11), String(AGENT_WORK_OOM_SCORE_ADJ));
      assert.equal(adj(root, 1), "200", "the service keeps its own");
      assert.equal(adj(root, 12), "200", "the tunnel keeps its own");
      assert.equal(adj(root, 99), "200", "outside the tree");
      assert.deepEqual(sent, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ends the compile at critical memory, once per cooldown, and SIGKILLs a survivor", () =>
    Effect.gen(function* () {
      const root = fakeProc(TREE, CRITICAL);
      const sent: Array<[number, string]> = [];
      const guard = yield* makeMemoryGuard({
        procRoot: root,
        rootPid: 1,
        signal: (pid, name) => void sent.push([pid, name]),
      });
      yield* guard.pass(false);
      assert.deepEqual(sent, [[11, "SIGTERM"]]);
      assert.equal(adj(root, 11), String(AGENT_WORK_OOM_SCORE_ADJ), "marked without a scan");

      yield* guard.pass(false);
      assert.deepEqual(sent, [[11, "SIGTERM"]]);

      yield* settle;
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      assert.deepEqual(sent.at(-1), [11, "SIGKILL"]);

      yield* TestClock.adjust("30 seconds");
      yield* guard.pass(false);
      assert.deepEqual(sent, [
        [11, "SIGTERM"],
        [11, "SIGKILL"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips a harness and a process it may not signal, and uses no cooldown on them", () =>
    Effect.gen(function* () {
      const root = fakeProc(
        [
          [1, "node", 0, 1000],
          [10, "sh", 1, 100],
          [20, "gemini", 10, 9 * GIB_PAGES],
          [21, "tsc", 10, 8 * GIB_PAGES],
          [22, "vite", 10, 2 * GIB_PAGES],
        ],
        CRITICAL,
      );
      const { sent, signal } = signalLog();
      const guard = yield* makeMemoryGuard({
        procRoot: root,
        rootPid: 1,
        signal: (pid, name) => {
          if (pid === 21) throw Object.assign(new Error("denied"), { code: "EPERM" });
          signal(pid, name);
        },
      });
      yield* guard.pass(false);
      assert.deepEqual(sent, [[22, "SIGTERM"]]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("moves past a process that survived its signals", () =>
    Effect.gen(function* () {
      const root = fakeProc(
        [
          [1, "node", 0, 1000],
          [10, "sh", 1, 100],
          [21, "tsc", 10, 8 * GIB_PAGES],
          [22, "vite", 10, 2 * GIB_PAGES],
        ],
        CRITICAL,
      );
      const { sent, signal } = signalLog();
      const guard = yield* makeMemoryGuard({ procRoot: root, rootPid: 1, signal });
      yield* guard.pass(false);
      yield* settle;
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      yield* guard.pass(false);
      assert.deepEqual(sent.at(-1), [22, "SIGTERM"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("sends no SIGKILL to a new process that took the pid", () =>
    Effect.gen(function* () {
      const root = fakeProc(TREE, CRITICAL);
      const { sent, signal } = signalLog();
      const guard = yield* makeMemoryGuard({ procRoot: root, rootPid: 1, signal });
      yield* guard.pass(false);
      NodeFS.writeFileSync(
        NodePath.join(root, "11", "stat"),
        stat(11, "tsc", 10, 1).replace(" 100 1000 ", " 777 1000 "),
      );
      yield* settle;
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      assert.deepEqual(sent, [[11, "SIGTERM"]]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("scans on every third sample", () =>
    Effect.gen(function* () {
      const scans: boolean[] = [];
      yield* runGuardPasses((scan) => Effect.sync(() => void scans.push(scan))).pipe(
        Effect.forkScoped,
      );
      for (let i = 0; i < 4; i++) {
        yield* settle;
        yield* TestClock.adjust("5 seconds");
      }
      yield* settle;
      assert.deepEqual(scans.slice(0, 4), [true, false, false, true]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends no SIGKILL once the process has gone", () =>
    Effect.gen(function* () {
      const root = fakeProc(TREE, CRITICAL);
      const sent: Array<[number, string]> = [];
      const guard = yield* makeMemoryGuard({
        procRoot: root,
        rootPid: 1,
        signal: (pid, name) => void sent.push([pid, name]),
      });
      yield* guard.pass(false);
      NodeFS.rmSync(NodePath.join(root, "11"), { recursive: true });
      yield* settle;
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      assert.deepEqual(sent, [[11, "SIGTERM"]]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.runIf(NodeFS.existsSync("/proc/self/stat"))(
    "on the real /proc, marks a real tree and ends the hog below a direct child only",
    () =>
      Effect.gen(function* () {
        // child (the stand-in service) > sh (a harness) > node (a build holding 80 MB).
        const hogDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "memory-guard-hog-"));
        const hog = NodePath.join(hogDir, "vitest.js");
        NodeFS.writeFileSync(
          hog,
          "globalThis.k=Buffer.alloc(80*1024*1024,1);setInterval(()=>{},1e3)",
        );
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.spawn(
              process.execPath,
              [
                "-e",
                `const {spawn}=require("child_process");
                 spawn("sh",["-c",${JSON.stringify(`"${process.execPath}" '${hog}' & echo $!; wait`)}],{stdio:"inherit"});
                 setInterval(()=>{},1e3);`,
              ],
              { stdio: ["ignore", "pipe", "ignore"] },
            ),
          ),
          (spawned) => Effect.sync(() => void spawned.kill("SIGKILL")),
        );
        const hogPid = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              child.stdout!.once("data", (data) => resolve(Number(String(data).trim())));
            }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(hogPid, "SIGKILL");
            } catch {
              // The guard ended it.
            }
          }),
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
        const readAdj = (pid: number) =>
          NodeFS.readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim();
        const before = readAdj(child.pid!);

        const guard = yield* makeMemoryGuard({
          rootPid: child.pid!,
          minVictimRssBytes: 40e6,
          memory: AT_THE_KILL,
        });
        yield* guard.pass(false);
        assert.equal(readAdj(child.pid!), before, "the service keeps its own");
        assert.equal(readAdj(hogPid), String(AGENT_WORK_OOM_SCORE_ADJ));

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 500)));
        assert.isFalse(NodeFS.existsSync(`/proc/${hogPid}/cmdline`) && isRunning(hogPid));
        assert.isTrue(isRunning(child.pid!), "the stand-in service survives");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 20_000 },
  );
});

/** A killed child stays a zombie until reaped: it holds no memory and counts as gone. */
function isRunning(pid: number) {
  try {
    return parseProcessState(NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8")) !== "Z";
  } catch {
    return false;
  }
}

function parseProcessState(stat: string) {
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
}

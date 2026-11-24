#!/usr/bin/env node
/**
 * 1465: the usage-limit fallback and subagent storm rig. One scratch server,
 * model-free chaos agents, limits that flip during the run on a seeded
 * schedule, and a checker over the server's own projections plus the agents'
 * turn logs. Spends no model tokens and reads no live home.
 *
 *   node scripts/studio-chaos/fallback-storm.mjs --scenario ping-pong|storm
 *     [--seed N] [--out DIR] [--cap-ms N] [--workers N] [--keep]
 *     [--server-root DIR]   run another checkout's server (its built entry, else its source)
 *
 * Exit 0 on pass, 1 on violated, 3 on stalled, 2 on a rig error. The receipt
 * (`<out>/receipt.json`) names the seed; rerun with it to replay the schedule.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { check } from "./check.mjs";
import * as S from "./lib/scratch-server.mjs";

const { values: args } = NodeUtil.parseArgs({
  options: {
    scenario: { type: "string", default: "storm" },
    seed: { type: "string" },
    out: { type: "string" },
    "cap-ms": { type: "string" },
    workers: { type: "string", default: "8" },
    keep: { type: "boolean", default: false },
    "server-root": { type: "string" },
  },
});
const SCENARIOS = ["ping-pong", "storm"];
if (!SCENARIOS.includes(args.scenario)) {
  console.error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
  process.exit(2);
}
const seed = args.seed === undefined ? NodeCrypto.randomInt(1, 2 ** 31) : Number(args.seed);
const rand = S.prng(seed);
const capMs = Number(args["cap-ms"] ?? (args.scenario === "storm" ? 420_000 : 150_000));
const out = NodePath.resolve(
  args.out ?? NodePath.join(NodeOS.tmpdir(), `chaos-${args.scenario}-${seed}-${Date.now()}`),
);
NodeFS.mkdirSync(out, { recursive: true, mode: 0o700 });
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chaos-home-"));
const sources = ["a", "b", "c"];
const instances = args.scenario === "storm" ? [...sources, "w"] : sources;
const sel = (instanceId) => ({ instanceId, model: S.MODEL });

const serverRoot = NodePath.resolve(args["server-root"] ?? S.ROOT);
const builtEntry = NodePath.join(serverRoot, "apps/server/dist/bin.mjs");
const entry = NodeFS.existsSync(builtEntry)
  ? builtEntry
  : NodePath.join(serverRoot, "apps/server/src/bin.ts");
const gitHead = (cwd) => {
  try {
    return NodeChildProcess.execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

/** Every fault and send, in the order the rig applied it (the replayable schedule). */
const schedule = [];
const dispatched = [];
const receipt = {
  increment: "1465",
  scenario: args.scenario,
  seed,
  replay: `node scripts/studio-chaos/fallback-storm.mjs --scenario ${args.scenario} --seed ${seed}`,
  capMs,
  rigCommit: gitHead(S.ROOT),
  serverCommit: gitHead(serverRoot),
  serverEntry: NodePath.relative(serverRoot, entry),
  startedAt: new Date().toISOString(),
  paidProviderTurns: 0,
  schedule,
  dispatched,
  turns: {},
  violations: [],
  verdict: "error",
};
const save = () =>
  NodeFS.writeFileSync(NodePath.join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");

// Workers run another model, so "same model on another source" never moves the coordinator there.
const WORKER_MODEL = "chaos-worker";
const home = S.makeHome(scratch, {
  instances,
  models: { w: WORKER_MODEL },
  settings: {
    providerLimitAction: "switch",
    providerLimitFallbackModels: sources.map(sel),
    providerLimitFallbackListOnly: true,
    providerLimitWaitUnderMinutes: 0,
  },
});
let control = {};
const setControl = (atMs, instance, behaviour) => {
  control = { ...control, [instance]: behaviour };
  S.writeControl(home, control);
  schedule.push({ atMs, kind: "control", instance, behaviour });
};

let server;
const started = Date.now();
// The schedule's clock starts at the first send, so a slow boot never squeezes its events.
let t0 = null;
const elapsed = () => (t0 === null ? 0 : Date.now() - t0);
/** Workers the rig asked each thread to launch; the checker holds the server to it. */
const expectations = { workers: {} };
/** One cleanup, however many signals and the finally block ask for it. */
let cleaning = null;
const cleanUp = () =>
  (cleaning ??= (async () => {
    await S.stopServer(server);
    if (!args.keep) NodeFS.rmSync(scratch, { recursive: true, force: true });
  })());
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => {
    receipt.error = `stopped by ${signal}`;
    receipt.verdict = "error";
    save();
    void cleanUp().finally(() => process.exit(2));
  });
try {
  // Fixed at start: every source reports room, the condition the m4 ping-pong needed.
  const usage = instances.map((name) => `${name}=10@acct-${name}`).join(",");
  server = await S.startServer(home, {
    // Held from spawn, so a signal during sign-in still stops the server's group.
    onSpawn: (child) => {
      server = { child };
      if (cleaning) void S.stopServer(server, { kill: true });
    },
    logFile: NodePath.join(out, "server.log"),
    entry,
    env: { STUDIO_SIMULATE_PROVIDER_USAGE: usage },
  });
  await S.providersReady(server, instances);
  await S.signIn(server, instances);
  const projectId = NodeCrypto.randomUUID();
  await S.request(server, "/api/projects/mutate", {
    type: "project.create",
    commandId: NodeCrypto.randomUUID(),
    projectId,
    title: "Chaos rig",
    workspaceRoot: home.project,
  });
  const threadId = `chaos-${NodeCrypto.randomUUID()}`;
  await S.command(server, {
    type: "thread.create",
    threadId,
    projectId,
    title: `Chaos ${args.scenario}`,
    modelSelection: sel("a"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const send = async (text, mode) => {
    t0 ??= Date.now();
    const messageId = `chaos-msg-${dispatched.length + 1}-${NodeCrypto.randomUUID()}`;
    dispatched.push({ threadId, messageId, atMs: elapsed() });
    schedule.push({ atMs: elapsed(), kind: "send", messageId, mode });
    await S.command(server, {
      type: "message.dispatch",
      threadId,
      messageId,
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: mode },
    });
  };

  if (args.scenario === "ping-pong") {
    // a and b are spent, c has room; the order is a, b, c. The thread must reach c.
    setControl(0, "a", { limited: true });
    setControl(0, "b", { limited: true });
    await send("CHAOS-REPLY ping-pong m1", "start_immediately");
  } else {
    const workers = Number(args.workers);
    expectations.workers[threadId] = workers;
    setControl(0, "w", { delayMs: rand.int(200, 4000) });
    const calls = Array.from(
      { length: workers },
      (_, index) =>
        `MCP-CALL ${JSON.stringify({
          name: "delegate_task",
          arguments: {
            title: `Chaos worker ${index + 1}`,
            task: `CHAOS-RESULT worker-${index + 1}`,
            target: { providerInstanceId: "w", model: WORKER_MODEL },
            increment: "none",
            mode: "async",
            clientRequestId: `chaos-${seed}-worker-${index + 1}`,
          },
        })}`,
    );
    await send(
      ["Fan out the chaos workers.", ...calls, "CHAOS-REPLY fan-out m1"].join("\n"),
      "start_immediately",
    );
    // Limits flip on the coordinator's sources while workers finish and follow-ups queue.
    const events = [];
    for (let index = 0; index < 4; index++)
      events.push({ atMs: rand.int(1_000, 40_000), kind: "send", text: "CHAOS-REPLY follow-up" });
    for (const instance of sources) {
      const on = rand.int(500, 30_000);
      events.push({
        atMs: on,
        kind: "limit",
        instance,
        behaviour: rand.pick([{ limited: true }, { workThenLimit: true }]),
      });
      if (instance !== "c" && rand.next() < 0.5)
        events.push({ atMs: on + rand.int(2_000, 20_000), kind: "limit", instance, behaviour: {} });
    }
    events.push({ atMs: rand.int(5_000, 30_000), kind: "limit", instance: "c", behaviour: {} });
    events.push({
      atMs: rand.int(5_000, 30_000),
      kind: "limit",
      instance: "w",
      behaviour: { delayMs: rand.int(0, 3000) },
    });
    events.sort((x, y) => x.atMs - y.atMs);
    receipt.plannedEvents = events;
    for (const event of events) {
      const wait = event.atMs - elapsed();
      if (wait > 0) await S.sleep(wait);
      if (event.kind === "send") await send(event.text, "queue_after_active");
      else setControl(elapsed(), event.instance, event.behaviour);
    }
  }

  // Run until the thread and its workers are quiet, the checker sees a violation, or the cap.
  let snapshot = null;
  let quietSince = null;
  let lastRuns = -1;
  while (elapsed() < capMs) {
    await S.sleep(2_000);
    snapshot = await collect(server, threadId);
    const result = check(snapshot);
    const busy = snapshot.threads.some((view) =>
      view.runs.some((run) =>
        ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
      ),
    );
    const runs = snapshot.threads.reduce((sum, view) => sum + view.runs.length, 0);
    if (busy || runs !== lastRuns) quietSince = null;
    else quietSince ??= elapsed();
    lastRuns = runs;
    if (result.violations.length > 0 && args.scenario === "ping-pong") break;
    if (quietSince !== null && elapsed() - quietSince >= 15_000) break;
  }
  snapshot ??= await collect(server, threadId);
  const result = check(snapshot);
  receipt.violations = result.violations;
  receipt.notes = result.notes;
  receipt.summary = result.summary;
  receipt.turns = Object.fromEntries(
    instances.map((name) => [name, snapshot.turns.filter((turn) => turn.instance === name).length]),
  );
  receipt.verdict =
    result.violations.length > 0 ? "violated" : quietSince === null ? "stalled" : "pass";
  NodeFS.writeFileSync(NodePath.join(out, "snapshot.json"), JSON.stringify(snapshot, null, 2));
} catch (error) {
  receipt.error = String(error?.stack ?? error);
  receipt.verdict = "error";
} finally {
  receipt.elapsedMs = Date.now() - started;
  save();
  await cleanUp();
}
console.log(
  `${args.scenario} seed ${seed}: ${receipt.verdict} (${receipt.violations.length} violations) -> ${out}/receipt.json`,
);
for (const violation of receipt.violations.slice(0, 10))
  console.log(`  ${violation.rule}: ${violation.detail}`);
if (receipt.error) console.log(receipt.error);
process.exit({ pass: 0, violated: 1, stalled: 3 }[receipt.verdict] ?? 2);

/**
 * The thread, every worker thread it launched, the agents' logs and what was
 * sent. Missing evidence is a rig error, never a quiet pass: a server that died
 * or a projection that cannot be read throws.
 */
async function collect(server, rootThreadId) {
  if (server.child.exitCode !== null || server.child.signalCode !== null)
    throw new Error(
      `the scratch server exited (${server.child.exitCode ?? server.child.signalCode})`,
    );
  const threads = [];
  const seen = new Set();
  const queue = [rootThreadId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const view = await S.projection(server, id);
    if (!view?.thread || !Array.isArray(view.runs))
      throw new Error(`no projection for thread ${id}`);
    threads.push(view);
    for (const child of view.subagents ?? [])
      if (child.childThreadId) queue.push(child.childThreadId);
  }
  return {
    threads,
    turns: S.readTurns(home),
    dispatched,
    expectations,
    schedule,
    nowMs: Date.now(),
  };
}

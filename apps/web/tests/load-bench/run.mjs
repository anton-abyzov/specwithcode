#!/usr/bin/env node
// Load-speed benchmark for one build of SpecWithCode: a real server on a seeded,
// throwaway state directory, driven by headless Chromium through a counting proxy.
//
//   node apps/web/tests/load-bench/run.mjs [options]
//
// Measures, per network profile, the median of N fresh-browser runs of
//   cold_connect_ms     navigation with empty storage until the shell lists threads
//   big_thread_open_ms  click on the big thread until its last answer renders
//   reconnect_ms        network back after a drop until each live subscription resyncs
// plus wire bytes (proxy) and client-parsed JSON bytes (CDP) for each phase.
//
// Options (environment variable in brackets):
//   --profile fast,3g    profiles to run [LOAD_BENCH_PROFILES]          default fast,3g
//   --runs N             measured runs per profile [LOAD_BENCH_RUNS]    default 5
//   --warmup N           unmeasured runs first [LOAD_BENCH_WARMUP]      default 1
//   --scale NAME         fixture size: default | small [LOAD_BENCH_SCALE]
//   --shaper proxy|cdp   who throttles 3g [LOAD_BENCH_SHAPER]           default proxy
//   --label NAME         version label in the file name                 default package version
//   --out DIR            result directory                               default bench-results/load
//   --append-metrics F   append one summary line per profile to F [LOAD_BENCH_METRICS_FILE]
//   --offline-ms N       how long the reconnect drop stays offline [LOAD_BENCH_OFFLINE_MS] 1000
//   --app-root DIR       measure another checkout, built, e.g. an older release
//                        worktree [LOAD_BENCH_APP_ROOT]                 default this checkout
//   --server-entry E     src (apps/server/src/bin.ts with apps/web/dist), dist (the
//                        bundle from `node apps/server/scripts/cli.ts build`, refused when
//                        older than its sources), or a path to another bin.mjs such as an
//                        installed release [LOAD_BENCH_SERVER_ENTRY]     default src
//   --keep-state         keep the throwaway state directory
// Build the web app first (`vp run --filter @specweave-studio/web build`). A path entry is
// labelled from its own package.json (or --label) and named apart from checkout results.
// STUDIO_PLAYWRIGHT_MODULE and STUDIO_TEST_CHROMIUM pick Playwright and the browser. The
// browser is always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { startProxy, wireDelta } from "./proxy.mjs";

const assert = NodeAssert.default;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);

const PROFILES = {
  fast: { name: "fast", shape: null, settleQuietMs: 500, timeoutMs: 60_000 },
  // 300 ms round trip, 1.6 Mbps down, 750 kbps up.
  "3g": {
    name: "3g",
    shape: { latencyMs: 300, downKbps: 1600, upKbps: 750 },
    settleQuietMs: 1500,
    timeoutMs: 300_000,
  },
};

function parseArgs(argv) {
  const env = process.env;
  const options = {
    profiles: (env.LOAD_BENCH_PROFILES ?? "fast,3g").split(","),
    runs: Number(env.LOAD_BENCH_RUNS ?? 5),
    warmup: Number(env.LOAD_BENCH_WARMUP ?? 1),
    scale: env.LOAD_BENCH_SCALE ?? "default",
    shaper: env.LOAD_BENCH_SHAPER ?? "proxy",
    label: undefined,
    out: NodePath.join(root, "bench-results/load"),
    appendMetrics: env.LOAD_BENCH_METRICS_FILE || undefined,
    keepState: false,
    offlineMs: Number(env.LOAD_BENCH_OFFLINE_MS ?? 1000),
    appRoot: env.LOAD_BENCH_APP_ROOT ? NodePath.resolve(env.LOAD_BENCH_APP_ROOT) : root,
    serverEntry: env.LOAD_BENCH_SERVER_ENTRY ?? env.STUDIO_SERVER_ENTRY ?? "src",
  };
  for (let index = 0; index < argv.length; index++) {
    const split = argv[index].indexOf("=");
    const flag = split < 0 ? argv[index] : argv[index].slice(0, split);
    const inline = split < 0 ? undefined : argv[index].slice(split + 1);
    const value = () => inline ?? argv[++index];
    if (flag === "--profile") options.profiles = value().split(",");
    else if (flag === "--runs") options.runs = Number(value());
    else if (flag === "--warmup") options.warmup = Number(value());
    else if (flag === "--scale") options.scale = value();
    else if (flag === "--shaper") options.shaper = value();
    else if (flag === "--label") options.label = value();
    else if (flag === "--out") options.out = NodePath.resolve(value());
    else if (flag === "--append-metrics") options.appendMetrics = NodePath.resolve(value());
    else if (flag === "--offline-ms") options.offlineMs = Number(value());
    else if (flag === "--app-root") options.appRoot = NodePath.resolve(value());
    else if (flag === "--server-entry") options.serverEntry = value();
    else if (flag === "--keep-state") options.keepState = true;
    else throw new Error(`Unknown option ${argv[index]}; see the header of ${import.meta.url}`);
  }
  for (const name of options.profiles) assert.ok(PROFILES[name], `Unknown profile ${name}`);
  assert.ok(Number.isInteger(options.runs) && options.runs >= 1, "--runs must be at least 1");
  assert.ok(Number.isInteger(options.warmup) && options.warmup >= 0, "--warmup must be >= 0");
  assert.ok(["proxy", "cdp"].includes(options.shaper), "--shaper must be proxy or cdp");
  return options;
}

const options = parseArgs(process.argv.slice(2));
const log = (...parts) => console.error(`[load-bench]`, ...parts);

function loadPlaywright() {
  const require = NodeModule.createRequire(import.meta.url);
  const candidates = [
    process.env.STUDIO_PLAYWRIGHT_MODULE,
    // Global install next to the running Node (nvm, Homebrew, setup-node).
    NodePath.join(NodePath.dirname(process.execPath), "../lib/node_modules/playwright"),
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
    "playwright",
    // CI installs only the server's playwright-core and its headless shell.
    NodePath.join(root, "apps/server/node_modules/playwright-core"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { module: require(candidate), path: candidate };
    } catch {}
  }
  throw new Error("Playwright not found; set STUDIO_PLAYWRIGHT_MODULE");
}

const git = (...args) =>
  NodeChildProcess.execFileSync("git", args, { cwd: options.appRoot, encoding: "utf8" }).trim();
const freePort = () =>
  new Promise((done, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function stats(values, unit) {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return { unit, median: null, p90: null, min: null, max: null, values };
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const middle = sorted.length / 2;
  const median =
    sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
  const round = (value) => (unit === "ms" ? Math.round(value * 10) / 10 : Math.round(value));
  return {
    unit,
    median: round(median),
    p90: round(at(0.9)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
    values: values.map((value) => (typeof value === "number" ? round(value) : value)),
  };
}

// Runs in the page before any app script. It timestamps (page clock, ms since
// navigation start) the first animation frame after a watched text enters the DOM,
// and the last click. DOM text works for every version, with or without app marks.
function pageInstrumentation(initial) {
  const marks = {};
  const watchers = [];
  const scan = (node) => {
    if (!node) return;
    for (const watcher of watchers) {
      if (watcher.seen || !(node.textContent ?? "").includes(watcher.text)) continue;
      watcher.seen = true;
      requestAnimationFrame(() => {
        marks[watcher.name] = performance.now();
      });
    }
  };
  const observer = new MutationObserver((records) => {
    if (watchers.every((watcher) => watcher.seen)) return;
    for (const record of records) {
      if (record.type === "characterData") scan(record.target.parentNode);
      else for (const node of record.addedNodes) scan(node);
    }
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener("click", () => (marks.click = performance.now()), true);
  window.__loadBench = {
    marks,
    watch(name, text) {
      delete marks[name];
      const watcher = { name, text, seen: false };
      watchers.push(watcher);
      scan(document.body);
    },
  };
  for (const [name, text] of Object.entries(initial)) window.__loadBench.watch(name, text);
}

/** Collects HTTP and WebSocket traffic of one page from CDP, tagged by phase. */
async function recordTraffic(session) {
  const state = {
    phase: "setup",
    inflight: new Map(),
    lastActivity: performance.now(),
    bytes: {},
    subscriptions: new Map(),
    syncs: [],
  };
  const add = (key, value) => {
    const bucket = (state.bytes[state.phase] ??= {});
    bucket[key] = (bucket[key] ?? 0) + value;
  };
  const touch = () => (state.lastActivity = performance.now());
  session.on("Network.requestWillBeSent", ({ requestId, request }) => {
    state.inflight.set(requestId, { url: request.url, json: false });
    add("http_requests", 1);
    touch();
  });
  session.on("Network.responseReceived", ({ requestId, response }) => {
    const entry = state.inflight.get(requestId);
    if (entry) entry.json = /json/.test(response.mimeType) || /\/api\//.test(response.url);
    touch();
  });
  session.on("Network.dataReceived", ({ requestId, dataLength }) => {
    const entry = state.inflight.get(requestId);
    add(entry?.json ? "json_http_bytes" : "asset_bytes", dataLength);
    touch();
  });
  const finish = ({ requestId }) => {
    state.inflight.delete(requestId);
    touch();
  };
  session.on("Network.loadingFinished", finish);
  session.on("Network.loadingFailed", finish);
  session.on("Network.webSocketFrameSent", ({ response }) => {
    if (response.opcode !== 1) return;
    add("ws_sent_bytes", Buffer.byteLength(response.payloadData));
    touch();
    if (!response.payloadData.includes("subscribe")) return;
    for (const message of parseFrame(response.payloadData))
      if (message?._tag === "Request" && /subscribe/i.test(message.tag ?? ""))
        state.subscriptions.set(String(message.id), { tag: message.tag, phase: state.phase });
  });
  session.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode !== 1) return;
    add("json_ws_bytes", Buffer.byteLength(response.payloadData));
    add("ws_frames", 1);
    touch();
    if (!response.payloadData.includes('"synchronized"')) return;
    for (const message of parseFrame(response.payloadData)) {
      if (message?._tag !== "Chunk") continue;
      const synchronized = (message.values ?? []).some((value) => value?.kind === "synchronized");
      const subscription = state.subscriptions.get(String(message.requestId));
      if (synchronized && subscription)
        state.syncs.push({ ...subscription, phase: state.phase, at: performance.now() });
    }
  });
  await session.send("Network.enable", {
    maxTotalBufferSize: 0,
    maxResourceBufferSize: 0,
  });
  return state;
}

function parseFrame(payload) {
  try {
    const value = JSON.parse(payload);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

/** Waits until no request is in flight and nothing moved for `quietMs`. */
async function settle(traffic, quietMs, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (traffic.inflight.size === 0 && performance.now() - traffic.lastActivity >= quietMs)
      return traffic.lastActivity;
    await sleep(25);
  }
  log(`traffic did not settle within ${timeoutMs} ms (${traffic.inflight.size} in flight)`);
  return traffic.lastActivity;
}

async function waitForMark(page, name, timeoutMs) {
  await page.waitForFunction((mark) => window.__loadBench?.marks[mark] !== undefined, name, {
    timeout: timeoutMs,
    polling: 50,
  });
  return page.evaluate((mark) => window.__loadBench.marks[mark], name);
}

function phaseBytes(traffic, phase, wire) {
  const bytes = traffic.bytes[phase] ?? {};
  return {
    wire_bytes: wire.total,
    wire_http_bytes: wire.http,
    wire_ws_bytes: wire.ws,
    json_bytes: (bytes.json_http_bytes ?? 0) + (bytes.json_ws_bytes ?? 0),
    json_ws_bytes: bytes.json_ws_bytes ?? 0,
    asset_bytes: bytes.asset_bytes ?? 0,
    http_requests: bytes.http_requests ?? 0,
    ws_frames: bytes.ws_frames ?? 0,
  };
}

/** One fresh browser context: cold connect, big thread open, reconnect. */
async function runOnce({ browser, origin, proxy, session, fixture, profile }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  try {
    await context.addInitScript(() => {
      try {
        if (!localStorage.getItem("studio:client-settings:v1"))
          localStorage.setItem(
            "studio:client-settings:v1",
            JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
          );
      } catch {}
    });
    await context.addInitScript(pageInstrumentation, { shell: fixture.bigThreadTitle });
    // The startup token pairs once; later runs reuse that session cookie and nothing else.
    if (session.cookies) await context.addCookies(session.cookies);
    else {
      const auth = await context.request.post(origin + "/api/auth/browser-session", {
        data: { credential: session.credential },
        headers: { Origin: origin },
      });
      assert.equal(auth.status(), 200, `browser session failed: ${await auth.text()}`);
      session.cookies = await context.cookies();
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await emulate(cdp, profile, false);
    const traffic = await recordTraffic(cdp);
    const result = {};

    // Cold connect: empty storage, navigation start until the shell lists the big thread.
    traffic.phase = "cold";
    let wireStart = proxy.totals();
    await page.goto(origin + "/", { waitUntil: "commit", timeout: profile.timeoutMs });
    result.cold_connect_ms = await waitForMark(page, "shell", profile.timeoutMs);
    await settle(traffic, profile.settleQuietMs, profile.timeoutMs);
    Object.assign(
      result,
      prefix("cold", phaseBytes(traffic, "cold", wireDelta(proxy.totals(), wireStart))),
    );

    // Big thread open: click in the sidebar until its last answer is in the DOM.
    traffic.phase = "open";
    wireStart = proxy.totals();
    const present = await page.evaluate(
      (marker) => document.body.textContent.includes(marker),
      fixture.lastAnswerMarker,
    );
    assert.equal(present, false, "the big thread's last answer is visible before opening it");
    await page.evaluate(
      (marker) => window.__loadBench.watch("open", marker),
      fixture.lastAnswerMarker,
    );
    await page.getByText(fixture.bigThreadTitle, { exact: true }).first().click();
    const openedAt = await waitForMark(page, "open", profile.timeoutMs);
    result.big_thread_open_ms =
      openedAt - (await page.evaluate(() => window.__loadBench.marks.click));
    await settle(traffic, profile.settleQuietMs, profile.timeoutMs);
    Object.assign(
      result,
      prefix("open", phaseBytes(traffic, "open", wireDelta(proxy.totals(), wireStart))),
    );

    // Reconnect: a network drop. Every connection is cut and the page goes offline for
    // --offline-ms; the clock starts when the network comes back (the client retries
    // at once on `online` instead of waiting out its jittered backoff). Done when each
    // subscription that synchronized before the drop synchronized again after it.
    const expected = new Set(traffic.syncs.map((sync) => sync.tag));
    traffic.phase = "reconnect";
    wireStart = proxy.totals();
    await emulate(cdp, profile, true);
    proxy.drop();
    await sleep(options.offlineMs);
    await emulate(cdp, profile, false);
    const droppedAt = performance.now();
    // A subscription the client does not reopen must not stall the run for the full timeout.
    const deadline = droppedAt + Math.min(profile.timeoutMs, 60_000);
    let resynced = null;
    while (performance.now() < deadline) {
      const after = traffic.syncs.filter(
        (sync) => sync.phase === "reconnect" && sync.at > droppedAt,
      );
      const tags = new Set(after.map((sync) => sync.tag));
      if (expected.size > 0 && [...expected].every((tag) => tags.has(tag))) {
        resynced = Math.max(...after.map((sync) => sync.at));
        break;
      }
      if (expected.size === 0 && performance.now() - droppedAt > 2_000) break;
      await sleep(10);
    }
    const settledAt = await settle(traffic, profile.settleQuietMs, profile.timeoutMs);
    if (process.env.LOAD_BENCH_DEBUG)
      log(
        "subscriptions",
        JSON.stringify(
          traffic.syncs.map((sync) => ({
            tag: sync.tag,
            phase: sync.phase,
            ms: Math.round(sync.at - droppedAt),
          })),
        ),
      );
    // Without completion markers (older protocols) fall back to the end of the catch-up traffic.
    result.reconnect_ms = (resynced ?? settledAt) - droppedAt;
    result.reconnect_resync_detected = resynced !== null;
    Object.assign(
      result,
      prefix("reconnect", phaseBytes(traffic, "reconnect", wireDelta(proxy.totals(), wireStart))),
    );
    assert.equal(
      await page.evaluate(
        (marker) => document.body.textContent.includes(marker),
        fixture.lastAnswerMarker,
      ),
      true,
      "the big thread is gone after the reconnect",
    );
    result.page_errors = errors.length;
    return result;
  } finally {
    await context.close();
  }
}

/** Offline, or online with the CDP throttle when `--shaper cdp` shapes this profile. */
function emulate(cdp, profile, offline) {
  const shaped = profile.shape && options.shaper === "cdp" && !offline;
  return cdp.send("Network.emulateNetworkConditions", {
    offline,
    latency: shaped ? profile.shape.latencyMs : 0,
    downloadThroughput: shaped ? (profile.shape.downKbps * 1000) / 8 : -1,
    uploadThroughput: shaped ? (profile.shape.upKbps * 1000) / 8 : -1,
  });
}

function prefix(phase, values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [`${phase}_${key}`, value]),
  );
}

// Every server this run spawned, killed however the run ends.
const servers = new Set();
const killServers = () => {
  for (const child of servers) if (child.exitCode === null) child.kill("SIGKILL");
};
process.once("exit", killServers);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    killServers();
    process.exit(130);
  });

async function startServer({ entry, baseDir, port }) {
  const home = NodePath.join(baseDir, "home");
  NodeFS.mkdirSync(home, { recursive: true });
  const started = performance.now();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      entry,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--no-browser",
    ],
    {
      cwd: baseDir,
      env: {
        PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        LANG: "en_US.UTF-8",
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  servers.add(child);
  child.once("exit", () => servers.delete(child));
  const logFile = NodeFS.createWriteStream(NodePath.join(baseDir, "server.log"));
  let buffer = "";
  const credential = await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not print a token in 180 s: ${buffer.slice(-2000)}`));
    }, 180_000);
    const observe = (chunk) => {
      logFile.write(chunk);
      buffer = (buffer + chunk).slice(-65536);
      const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${buffer.slice(-2000)}`));
    });
  });
  return { child, credential, startMs: performance.now() - started };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const timeout = sleep(10_000).then(() => "timeout");
  if ((await Promise.race([exited, timeout])) === "timeout") child.kill("SIGKILL");
}

// Seed with the measured checkout's own seeder, so its own migrations create the
// schema. A checkout older than the seeder borrows this one's (recorded in the result).
function seed(baseDir) {
  const own = NodePath.join(options.appRoot, "apps/server/integration/loadBenchSeed.ts");
  const seeder = NodeFS.existsSync(own)
    ? own
    : NodePath.join(root, "apps/server/integration/loadBenchSeed.ts");
  const output = NodeChildProcess.execFileSync(process.execPath, [seeder, baseDir, options.scale], {
    cwd: NodePath.dirname(seeder),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 << 20,
  });
  return {
    ...JSON.parse(output.trim().split("\n").at(-1)),
    seeder: seeder === own ? "own" : "harness",
  };
}

function machine() {
  const cpus = NodeOS.cpus();
  return {
    // oxlint-disable-next-line studio/no-global-process-runtime -- Standalone benchmark has no Effect runtime.
    platform: NodeOS.platform(),
    // oxlint-disable-next-line studio/no-global-process-runtime -- Standalone benchmark has no Effect runtime.
    arch: NodeOS.arch(),
    os: `${NodeOS.type()} ${NodeOS.release()}`,
    cpu: cpus[0]?.model ?? "unknown",
    cpu_count: cpus.length,
    memory_gb: Math.round(NodeOS.totalmem() / 2 ** 30),
    ci: Boolean(process.env.CI),
  };
}

const METRICS = {
  ms: ["cold_connect_ms", "big_thread_open_ms", "reconnect_ms"],
  bytes: [
    "cold_wire_bytes",
    "cold_json_bytes",
    "cold_wire_ws_bytes",
    "cold_asset_bytes",
    "open_wire_bytes",
    "open_json_bytes",
    "reconnect_wire_bytes",
    "reconnect_json_bytes",
  ],
  count: ["cold_http_requests", "cold_ws_frames", "open_ws_frames", "reconnect_ws_frames"],
};

/** Newest modification time of any file under `directory`, or 0 when it is missing. */
function newestMtime(directory) {
  let newest = 0;
  if (!NodeFS.existsSync(directory)) return newest;
  for (const entry of NodeFS.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const mtime = NodeFS.statSync(NodePath.join(entry.parentPath, entry.name)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/**
 * Which server runs, and how its result is labelled. `src` and `dist` belong to the measured
 * checkout and take its version and commit. A path entry takes the version of the package it
 * ships in (or --label), a commit of "external" and a file name unique to that path, so it never
 * overwrites a checkout result.
 */
function resolveServer() {
  const app = (path) => NodePath.join(options.appRoot, path);
  const webBuilt = NodeFS.existsSync(app("apps/web/dist/index.html"));
  if (options.serverEntry === "src") {
    assert.ok(webBuilt, "Build the web app first: vp run --filter @specweave-studio/web build");
    return { kind: "src", entry: app("apps/server/src/bin.ts"), ...checkoutLabels() };
  }
  if (options.serverEntry === "dist") {
    const entry = app("apps/server/dist/bin.mjs");
    assert.ok(
      NodeFS.existsSync(entry),
      `${entry} is missing: node apps/server/scripts/cli.ts build`,
    );
    // The bundle serves its own dist/client copy, so it must be newer than both sources.
    const built = NodeFS.statSync(entry).mtimeMs;
    for (const source of ["apps/server/src", "apps/web/dist"])
      assert.ok(
        newestMtime(app(source)) <= built,
        `apps/server/dist is older than ${source}; rebuild it (node apps/server/scripts/cli.ts build) or use --server-entry src`,
      );
    return { kind: "dist", entry, ...checkoutLabels() };
  }
  const entry = NodePath.resolve(options.serverEntry);
  assert.ok(NodeFS.existsSync(entry), `No server entry at ${entry}`);
  let version = options.label;
  for (let directory = NodePath.dirname(entry); !version; directory = NodePath.dirname(directory)) {
    const manifest = NodePath.join(directory, "package.json");
    if (NodeFS.existsSync(manifest))
      version = JSON.parse(NodeFS.readFileSync(manifest, "utf8")).version;
    if (directory === NodePath.dirname(directory)) break;
  }
  assert.ok(version, `Cannot tell the version of ${entry}; pass --label`);
  const id = NodeCrypto.createHash("sha256").update(NodeFS.realpathSync(entry)).digest("hex");
  return {
    kind: "path",
    entry,
    version,
    sha: "external",
    dirty: null,
    fileId: `external-${id.slice(0, 8)}`,
  };
}

function checkoutLabels() {
  const version =
    options.label ??
    JSON.parse(
      NodeFS.readFileSync(NodePath.join(options.appRoot, "apps/server/package.json"), "utf8"),
    ).version;
  const sha = git("rev-parse", "--short=10", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
  return { version, sha, dirty, fileId: sha };
}

async function main() {
  const target = resolveServer();
  const { entry, version, sha, dirty } = target;
  const scratch = NodePath.join(root, ".artifacts/load-bench", `${Date.now()}-${process.pid}`);
  NodeFS.mkdirSync(scratch, { recursive: true });
  const seedDir = NodePath.join(scratch, "seed");
  log(`seeding the ${options.scale} fixture into ${seedDir}`);
  const fixture = seed(seedDir);
  log(`seeded ${fixture.threads} threads, ${fixture.events} events in ${fixture.seedMs} ms`);
  if (fixture.seeder === "harness")
    log(
      "warning: the measured checkout has no seeder; its server reads a schema seeded by this one",
    );
  const { module: playwright, path: playwrightPath } = loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  const written = [];
  let failed = true;
  try {
    for (const name of options.profiles) {
      const profile = PROFILES[name];
      const baseDir = NodePath.join(scratch, name);
      NodeFS.cpSync(seedDir, baseDir, { recursive: true });
      const port = await freePort();
      const loadBefore = NodeOS.loadavg()[0];
      if (loadBefore > NodeOS.cpus().length)
        log(
          `warning: load average ${loadBefore.toFixed(0)} on ${NodeOS.cpus().length} cores; expect noise`,
        );
      const server = await startServer({ entry, baseDir, port });
      const proxy = await startProxy({
        upstreamPort: port,
        shape: options.shaper === "proxy" ? profile.shape : null,
      });
      const origin = `http://127.0.0.1:${proxy.port}`;
      log(
        `${name}: server pid ${server.child.pid} up in ${Math.round(server.startMs)} ms, proxy ${origin}`,
      );
      const runs = [];
      const session = { credential: server.credential, cookies: null };
      try {
        for (let index = 0; index < options.warmup + options.runs; index++) {
          const warm = index < options.warmup;
          const run = await runOnce({ browser, origin, proxy, session, fixture, profile });
          log(
            `${name} ${warm ? "warmup" : `run ${index - options.warmup + 1}/${options.runs}`}: ` +
              `cold ${Math.round(run.cold_connect_ms)} ms, open ${Math.round(run.big_thread_open_ms)} ms, ` +
              `reconnect ${Math.round(run.reconnect_ms)} ms`,
          );
          if (!warm) runs.push(run);
        }
      } finally {
        await proxy.close();
        await stopServer(server.child);
      }
      const metrics = {};
      for (const [unit, names] of Object.entries(METRICS))
        for (const metric of names)
          metrics[metric] = stats(
            runs.map((run) => run[metric]),
            unit,
          );
      const result = {
        schema: "loadBench.v1",
        version,
        sha,
        dirty,
        profile: name,
        created_at: new Date().toISOString(),
        machine: machine(),
        node: process.version,
        chromium: browser.version(),
        playwright: playwrightVersion(playwrightPath),
        config: {
          runs: options.runs,
          warmup: options.warmup,
          shaper: profile.shape ? options.shaper : "none",
          offline_ms: options.offlineMs,
          network: profile.shape,
          server_entry: target.kind === "path" ? entry : NodePath.relative(options.appRoot, entry),
          server_entry_kind: target.kind,
          seeder: fixture.seeder,
        },
        fixture: {
          scale: fixture.scale,
          projects: fixture.projects,
          threads: fixture.threads,
          events: fixture.events,
          big_thread_items: fixture.bigThreadItems,
        },
        server_start_ms: Math.round(server.startMs),
        // Above about 1 per core the numbers mostly measure the other work on the machine.
        load_avg_1m: { before: round2(loadBefore), after: round2(NodeOS.loadavg()[0]) },
        reconnect_resync_detected: runs.every((run) => run.reconnect_resync_detected),
        page_errors: runs.reduce((sum, run) => sum + run.page_errors, 0),
        metrics,
        runs,
      };
      NodeFS.mkdirSync(options.out, { recursive: true });
      const file = NodePath.join(options.out, `${version}-${target.fileId}-${name}.json`);
      NodeFS.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      written.push(file);
      if (options.appendMetrics) {
        NodeFS.mkdirSync(NodePath.dirname(options.appendMetrics), { recursive: true });
        NodeFS.appendFileSync(
          options.appendMetrics,
          JSON.stringify({
            at: result.created_at,
            schema: result.schema,
            version,
            sha,
            dirty,
            profile: name,
            scale: fixture.scale,
            runs: options.runs,
            machine: `${result.machine.cpu} x${result.machine.cpu_count}`,
            node: result.node,
            chromium: result.chromium,
            ...Object.fromEntries(
              Object.entries(metrics).map(([key, value]) => [key, value.median]),
            ),
            file: NodePath.relative(root, file),
          }) + "\n",
        );
      }
      log(`${name}: wrote ${file}`);
    }
    failed = false;
  } finally {
    await browser.close();
    if (failed) log(`kept the state and server logs in ${scratch}`);
    else if (!options.keepState) NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  for (const file of written) console.log(file);
}

const round2 = (value) => Math.round(value * 100) / 100;

function playwrightVersion(path) {
  try {
    const require = NodeModule.createRequire(import.meta.url);
    return require(NodePath.join(NodePath.dirname(require.resolve(path)), "package.json")).version;
  } catch {
    return "unknown";
  }
}

await main();

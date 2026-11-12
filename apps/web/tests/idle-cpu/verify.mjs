// Headless check that an idle window stays idle while other threads work.
// Usage: node apps/web/tests/idle-cpu/verify.mjs <report-dir> [--baseline] [--seconds N]
//          [--limit PERCENT] [--query "threads=1100&batches=2.2"] [--site DIR]
// Opens the fixture (real client store, sidebar and thread route over about 1,100
// simulated threads), streams shell updates for other threads at the rate a busy
// machine sends them, and measures how much of the window's main thread that uses:
// Chrome DevTools Protocol task time over the window, plus a CPU profile that names
// the functions. Fails above the limit (20%); --baseline reports without failing.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
const assert = NodeAssert.default;
const { resolve, extname, join } = NodePath;
const { readFile, mkdir, writeFile } = NodeFSP;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const baseline = flag("--baseline");
const seconds = Number(option("--seconds") ?? 30);
const limit = Number(option("--limit") ?? 20);
const query = option("--query") ?? "";
const site = resolve(option("--site") || ".artifacts/idle-cpu/site");
const output = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : ".artifacts/idle-cpu/evidence",
);
const WARMUP_MS = 5000;
assert.ok(NodeFS.existsSync(join(site, "index.html")), `no fixture build at ${site}`);
await mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(site, "." + (pathname === "/" ? "/index.html" : pathname));
    if (!file.startsWith(site + "/")) throw Error("path");
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[extname(file)] ||
        "application/octet-stream",
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
/** The browser named by the environment, else Playwright's own, else the newest headless shell it has cached. */
function findChromium() {
  const named = process.env.STUDIO_CHROMIUM_EXECUTABLE || process.env.STUDIO_TEST_CHROMIUM;
  if (named) return named;
  if (NodeFS.existsSync(chromium.executablePath())) return undefined;
  const caches = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : ["Library/Caches/ms-playwright", ".cache/ms-playwright"].map((folder) =>
        join(NodeOS.homedir(), folder),
      );
  for (const cache of caches.filter((folder) => NodeFS.existsSync(folder))) {
    const shells = NodeFS.readdirSync(cache)
      .filter((name) => name.startsWith("chromium_headless_shell-"))
      .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]));
    for (const shell of shells) {
      for (const folder of NodeFS.readdirSync(join(cache, shell))) {
        const binary = join(cache, shell, folder, "chrome-headless-shell");
        if (NodeFS.existsSync(binary)) return binary;
      }
    }
  }
  return undefined;
}
const executablePath = findChromium();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath && { executablePath }),
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Self time per function, from the profile's samples. */
function topFunctions(profile, count) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let total = 0;
  profile.samples.forEach((id, index) => {
    const delta = profile.timeDeltas[index] ?? 0;
    total += delta;
    const frame = nodes.get(id).callFrame;
    if (frame.functionName === "(idle)" || frame.functionName === "(program)") return;
    const file = frame.url.split("/").at(-1) || "(native)";
    const key = `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + delta);
  });
  return [...self]
    .sort((left, right) => right[1] - left[1])
    .slice(0, count)
    .map(([name, micros]) => ({
      function: name,
      selfMs: Math.round(micros / 1000),
      shareOfWindow: Number(((micros / total) * 100).toFixed(2)),
    }));
}

/** Time under each named function, itself and what it calls, for the heaviest callers. */
function topInclusive(profile, count) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const inclusive = new Map();
  let total = 0;
  profile.samples.forEach((id, index) => {
    const delta = profile.timeDeltas[index] ?? 0;
    total += delta;
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const frame = nodes.get(at).callFrame;
      if (!frame.url || !frame.functionName) continue;
      const key = `${frame.functionName} ${frame.url.split("/").at(-1)}:${frame.lineNumber + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + delta);
    }
  });
  return [...inclusive]
    .sort((left, right) => right[1] - left[1])
    .slice(0, count)
    .map(([name, micros]) => ({
      function: name,
      totalMs: Math.round(micros / 1000),
      shareOfWindow: Number(((micros / total) * 100).toFixed(2)),
    }));
}

let failure = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?live=off${query ? `&${query}` : ""}`);
  await page
    .locator(".sws-chat-row")
    .first()
    .waitFor()
    .catch((error) => {
      throw new Error(`the sidebar did not render: ${errors.join("; ") || error.message}`);
    });
  const scale = await page.evaluate(() => window.fixture.scale());
  const orderBefore = await page.evaluate(() => window.fixture.chatOrder());
  const currentBefore = await page.evaluate(() => window.fixture.currentChat());
  await page.screenshot({ path: join(output, "start.png") });

  // A fixed run of updates first: what the screen says after it must not depend on the build.
  await page.evaluate(async () => {
    for (let batch = 0; batch < 150; batch += 1) {
      window.fixture.shellBatch();
      if (batch % 4 === 0) window.fixture.remoteWorkerPoll();
      if (batch % 10 === 9) await new Promise((done) => requestAnimationFrame(done));
    }
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  const signature = await page.evaluate(() => window.fixture.signature());
  await writeFile(join(output, "signature.json"), JSON.stringify(signature, null, 2) + "\n");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((metric) => [
        metric.name,
        metric.value,
      ]),
    );

  // The same page with nothing arriving: what the fixture itself costs at rest.
  const restStart = await metrics();
  await sleep(3000);
  const restEnd = await metrics();
  const restBusy =
    ((restEnd.TaskDuration - restStart.TaskDuration) / (restEnd.Timestamp - restStart.Timestamp)) *
    100;

  await page.evaluate(() => window.fixture.start());
  await sleep(WARMUP_MS);
  const countersStart = await page.evaluate(() => window.fixture.counters());
  const start = await metrics();
  await cdp.send("Profiler.start");
  await sleep(seconds * 1000);
  const { profile } = await cdp.send("Profiler.stop");
  const end = await metrics();
  const countersEnd = await page.evaluate(() => window.fixture.counters());
  await page.evaluate(() => window.fixture.stop());
  await sleep(500);

  const wall = end.Timestamp - start.Timestamp;
  const delta = (name) => end[name] - start[name];
  const share = (name) => Number(((delta(name) / wall) * 100).toFixed(2));
  const counted = Object.fromEntries(
    Object.keys(countersEnd).map((name) => [name, countersEnd[name] - countersStart[name]]),
  );
  const orderAfter = await page.evaluate(() => window.fixture.chatOrder());
  const currentAfter = await page.evaluate(() => window.fixture.currentChat());
  const workingThreads = await page.evaluate(() => window.fixture.workingThreads());
  await page.screenshot({ path: join(output, "after.png") });

  const top = topFunctions(profile, 40);
  const inclusive = topInclusive(profile, 60);
  const report = {
    headless: true,
    baseline,
    scope:
      "Real client shell reducer, thread atoms, entity hooks, StudioSidebar and ThreadRouteView in headless Chromium; simulated machine, settings, routing and event stream; the chat view is a stand-in that counts its renders. Not the installed desktop window.",
    scale,
    windowSeconds: Number(wall.toFixed(2)),
    limitPercent: limit,
    busyPercent: share("TaskDuration"),
    scriptPercent: share("ScriptDuration"),
    layoutPercent: share("LayoutDuration"),
    stylePercent: share("RecalcStyleDuration"),
    busyPercentAtRest: Number(restBusy.toFixed(2)),
    jsHeapMb: Math.round(end.JSHeapUsedSize / 1e6),
    duringWindow: {
      ...counted,
      batchesPerSecond: Number((counted.batches / wall).toFixed(2)),
      eventsPerSecond: Number((counted.events / wall).toFixed(2)),
      chatViewRendersPerBatch: Number(
        (counted.chatViewRenders / Math.max(1, counted.batches)).toFixed(2),
      ),
    },
    behaviour: {
      chatRows: orderAfter.length,
      chatOrderHeld: JSON.stringify(orderBefore) === JSON.stringify(orderAfter),
      openChat: currentAfter,
      workingThreads,
      afterFixedRun: {
        projectsWaiting: signature.projectsWaiting,
        paneSummary: signature.paneSummary,
        paneGroups: signature.paneGroups,
        paneRows: signature.paneRows.length,
      },
      errors,
    },
    topSelfTime: top,
    topTotalTime: inclusive,
  };
  await writeFile(join(output, "profile.cpuprofile"), JSON.stringify(profile));
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "top-functions.txt"),
    [
      `busy ${report.busyPercent}% of the main thread over ${report.windowSeconds} s (script ${report.scriptPercent}%)`,
      "",
      "self time",
      ...top.map(
        (row) =>
          `${String(row.selfMs).padStart(7)} ms ${String(row.shareOfWindow).padStart(6)}%  ${row.function}`,
      ),
      "",
      "total time (function and what it calls)",
      ...inclusive.map(
        (row) =>
          `${String(row.totalMs).padStart(7)} ms ${String(row.shareOfWindow).padStart(6)}%  ${row.function}`,
      ),
      "",
    ].join("\n"),
  );
  const { topSelfTime: _self, topTotalTime: _total, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    top
      .slice(0, 12)
      .map((row) => `${row.shareOfWindow}% ${row.function}`)
      .join("\n"),
  );

  if (!baseline) {
    assert.deepEqual(errors, [], "page errors");
    assert.ok(counted.batches >= seconds, `only ${counted.batches} batches arrived`);
    assert.ok(orderAfter.length > 0, "no chat rows on screen");
    assert.ok(report.behaviour.chatOrderHeld, "chat rows changed order while streaming");
    assert.equal(currentAfter, currentBefore, "the open chat changed");
    assert.ok(workingThreads > 0, "no thread is working");
    assert.ok(signature.paneRows.length > 0, "the project's thread list is empty");
    assert.ok(signature.projectsWaiting.length > 0, "no project shows a waiting count");
    assert.ok(
      report.busyPercent <= limit,
      `main thread busy ${report.busyPercent}% of ${report.windowSeconds} s, limit ${limit}%`,
    );
  }
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
if (failure) {
  console.error(failure.message ?? failure);
  process.exit(1);
}

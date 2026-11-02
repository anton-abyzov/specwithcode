// Cost of artifact card previews over real report files, always headless.
// node apps/web/tests/project-artifacts/bench.mjs <reports-root> <out.json> [site-dir]
// <reports-root> holds `.specweave`. Report contents stay out of the repository;
// out.json carries numbers only. Build the fixture first (see verify.mjs).
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { dirname, extname, join, relative, resolve, sep } = NodePath;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(resolve("apps/server/package.json"))("playwright-core");

const reportsRoot = resolve(process.argv[2]);
const outFile = resolve(process.argv[3]);
const site = resolve(process.argv[4] ?? ".artifacts/project-artifacts/site");
const TOTAL = 495;
const PREVIEWED = /\.(md|markdown|txt|html?|png|jpe?g|webp|json|csv|log|ya?ml)$/i;

/** The newest report files, read the way the server's output scan reads them. */
function scanOutputs() {
  const found = [];
  const walk = (dir, depth) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth > 1) walk(full, depth - 1);
      else if (entry.isFile()) {
        const stat = NodeFS.statSync(full);
        found.push({
          path: relative(reportsRoot, full),
          byteLength: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        });
      }
    }
  };
  walk(join(reportsRoot, ".specweave/reports"), 3);
  const increments = join(reportsRoot, ".specweave/increments");
  for (const entry of NodeFS.readdirSync(increments, { withFileTypes: true })) {
    const reports = join(increments, entry.name, "reports");
    if (entry.isDirectory() && NodeFS.existsSync(reports)) walk(reports, 3);
  }
  return found.toSorted((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

const all = scanOutputs();
const previewable = all.filter((item) => PREVIEWED.test(item.path));
const MIXES = {
  // The server lists at most 120 outputs.
  typical: { outputs: all.slice(0, 120) },
  // The most this could cost: every card is a real document or image.
  everyDocument: { outputs: previewable.slice(0, TOTAL) },
};

let manifest = MIXES.typical;
let served = { requests: 0, bytes: 0 };
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/bench/manifest.json") {
      return void res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(manifest));
    }
    if (url.pathname === "/bench/file") {
      const file = resolve(reportsRoot, url.searchParams.get("path"));
      if (!file.startsWith(reportsRoot + sep)) return void res.writeHead(403).end();
      const body = await NodeFSP.readFile(file);
      served.requests += 1;
      served.bytes += body.length;
      const type = /\.png$/i.test(file)
        ? "image/png"
        : /\.jpe?g$/i.test(file)
          ? "image/jpeg"
          : /\.webp$/i.test(file)
            ? "image/webp"
            : "text/plain; charset=utf-8";
      return void res.writeHead(200, { "Content-Type": type }).end(body);
    }
    const file = resolve(site, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(site + sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const launched = await chromium.launchServer({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
const browser = await chromium.connect(launched.wsEndpoint());
const rootPid = launched.process().pid;

/** Resident memory of the whole browser process tree, in MB. */
function treeRssMb() {
  const rows = NodeChild.execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const inTree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) {
      if (inTree.has(ppid) && !inTree.has(pid)) {
        inTree.add(pid);
        grew = true;
      }
    }
  }
  return rows.reduce((sum, [pid, , rss]) => (inTree.has(pid) ? sum + rss : sum), 0) / 1024;
}

const round = (value, places = 1) => Number(value.toFixed(places));
const percentile = (values, p) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

async function metrics(session) {
  const { metrics: list } = await session.send("Performance.getMetrics");
  return Object.fromEntries(list.map((item) => [item.name, item.value]));
}

async function settle(page) {
  // Quiet: no served file and no long task for 1.5 seconds, at most 90 seconds.
  const started = Date.now();
  let last = served.requests;
  let lastChange = Date.now();
  while (Date.now() - started < 90_000) {
    await page.waitForTimeout(250);
    const busy = await page.evaluate(() => window.__benchLastLongTask ?? 0);
    if (served.requests !== last || performance.now() < 0) {
      last = served.requests;
      lastChange = Date.now();
    }
    const longAgo = await page.evaluate((at) => performance.now() - at, busy);
    if (Date.now() - lastChange > 1500 && longAgo > 1500) break;
  }
  return Date.now() - started;
}

async function run(mixName, shots) {
  manifest = MIXES[mixName];
  served = { requests: 0, bytes: 0 };
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1300, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    window.__benchLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__benchLongTasks.push(entry.duration);
        window.__benchLastLongTask = entry.startTime + entry.duration;
      }
    }).observe({ type: "longtask", buffered: true });
  });
  const session = await context.newCDPSession(page);
  await session.send("Performance.enable");
  const before = treeRssMb();
  const started = Date.now();
  await page.goto(`${origin}/?bench=1&theme=dark&view=grid`);
  await page.locator(".sws-artifact-grid").waitFor();
  const mountMs = Date.now() - started;
  await settle(page);
  const opened = await metrics(session);
  const openedRss = treeRssMb();
  const openedServed = { ...served };
  if (shots) await page.screenshot({ path: `${shots}-top.png` });

  // Scroll to the end at 1500 px/s, as a fast reader would, recording every frame.
  const frames = await page.evaluate(
    () =>
      new Promise((done) => {
        const scroller = document.querySelector('[data-testid="library-scroll"]');
        const intervals = [];
        let last = performance.now();
        const step = (at) => {
          intervals.push(at - last);
          scroller.scrollTop += ((at - last) * 1500) / 1000;
          last = at;
          if (scroller.scrollTop + scroller.clientHeight + 1 >= scroller.scrollHeight) {
            done(intervals);
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  await settle(page);
  if (process.env.ARTIFACT_BENCH_TRACE) {
    await page.evaluate(() => {
      document.querySelector('[data-testid="library-scroll"]').scrollTop = 0;
    });
    await settle(page);
    const chunks = [];
    session.on("Tracing.dataCollected", (event) => chunks.push(...event.value));
    await session.send("Tracing.start", {
      categories: "devtools.timeline,disabled-by-default-devtools.timeline",
      transferMode: "ReportEvents",
    });
    await page.evaluate(
      () =>
        new Promise((done) => {
          const scroller = document.querySelector('[data-testid="library-scroll"]');
          let last = performance.now();
          const step = (at) => {
            scroller.scrollTop += ((at - last) * 1500) / 1000;
            last = at;
            if (scroller.scrollTop + scroller.clientHeight + 1 >= scroller.scrollHeight) done();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    const finished = new Promise((done) => session.once("Tracing.tracingComplete", done));
    await session.send("Tracing.end");
    await finished;
    const byName = {};
    for (const event of chunks) {
      if (event.ph !== "X" || !event.dur) continue;
      const entry = (byName[event.name] ??= { ms: 0, count: 0, max: 0 });
      entry.ms += event.dur / 1000;
      entry.count += 1;
      entry.max = Math.max(entry.max, event.dur / 1000);
    }
    console.log(
      JSON.stringify(
        Object.entries(byName)
          .toSorted((a, b) => b[1].ms - a[1].ms)
          .slice(0, 14)
          .map(([name, v]) => [name, Math.round(v.ms), v.count, Math.round(v.max)]),
      ),
    );
  }
  if (shots) await page.screenshot({ path: `${shots}-end.png` });
  const scrolled = await metrics(session);
  const dom = await page.evaluate(async () => {
    window.gc?.();
    await new Promise((done) => setTimeout(done, 300));
    return {
      iframes: document.querySelectorAll("iframe").length,
      images: document.querySelectorAll("img").length,
      nodes: document.querySelectorAll("*").length,
      longTasks: window.__benchLongTasks.length,
      longestTaskMs: Math.max(0, ...window.__benchLongTasks),
      heapMb: performance.memory.usedJSHeapSize / 1048576,
      cache: window.__artifactPreviewCacheStats?.() ?? null,
    };
  });
  const scrolledRss = treeRssMb();
  await context.close();
  return {
    mix: mixName,
    artifacts: manifest.outputs.length,
    files: manifest.outputs.length,
    errors: errors.slice(0, 3),
    open: {
      firstPaintOfGridMs: mountMs,
      filesRead: openedServed.requests,
      mbRead: round(openedServed.bytes / 1048576),
      cpuTaskMs: round(opened.TaskDuration * 1000, 0),
      treeRssMb: round(openedRss, 0),
      rssAddedMb: round(openedRss - before, 0),
    },
    scrollToEnd: {
      frames: frames.length,
      p50FrameMs: round(percentile(frames, 0.5)),
      p95FrameMs: round(percentile(frames, 0.95)),
      p99FrameMs: round(percentile(frames, 0.99)),
      framesOver50Ms: frames.filter((value) => value > 50).length,
      filesRead: served.requests,
      mbRead: round(served.bytes / 1048576),
      cpuTaskMs: round((scrolled.TaskDuration - opened.TaskDuration) * 1000, 0),
      scriptMs: round((scrolled.ScriptDuration - opened.ScriptDuration) * 1000, 0),
      layoutMs: round((scrolled.LayoutDuration - opened.LayoutDuration) * 1000, 0),
      styleMs: round((scrolled.RecalcStyleDuration - opened.RecalcStyleDuration) * 1000, 0),
      treeRssMb: round(scrolledRss, 0),
    },
    after: {
      iframes: dom.iframes,
      images: dom.images,
      domNodes: dom.nodes,
      longTasks: dom.longTasks,
      longestTaskMs: round(dom.longestTaskMs, 0),
      jsHeapMb: round(dom.heapMb),
      cache: dom.cache,
    },
  };
}

/** One preview at a time over every real file: milliseconds and retained bytes. */
async function previewCost() {
  manifest = MIXES.everyDocument;
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await context.newPage();
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?bench=1&view=list`);
  await page.locator(".sws-library-table").waitFor();
  const available = await page.evaluate(() => typeof window.__artifactPreviewCost === "function");
  if (!available) {
    await context.close();
    return null;
  }
  const seen = await page.evaluate(() => window.__artifactPreviewCost());
  await context.close();
  const formats = {};
  let totalBytes = 0;
  let totalMs = 0;
  for (const [format, { ms, bytes, failed }] of Object.entries(seen)) {
    const sum = bytes.reduce((a, b) => a + b, 0);
    totalBytes += sum;
    totalMs += ms.reduce((a, b) => a + b, 0);
    formats[format] = {
      files: ms.length,
      failed,
      p50Ms: round(percentile(ms, 0.5)),
      p95Ms: round(percentile(ms, 0.95)),
      maxMs: round(Math.max(...ms)),
      avgKb: round(sum / bytes.length / 1024),
      totalKb: round(sum / 1024),
    };
  }
  return {
    formats,
    allPreviewsKb: round(totalBytes / 1024),
    allPreviewsSeconds: round(totalMs / 1000),
  };
}

const results = [];
let cost = null;
try {
  await NodeFSP.mkdir(dirname(outFile), { recursive: true });
  const shotBase = outFile.replace(/\.json$/, "");
  for (const mix of Object.keys(MIXES)) {
    results.push(await run(mix, `${shotBase}-${mix}`));
    console.log(JSON.stringify(results.at(-1)));
  }
  cost = await previewCost();
  console.log(JSON.stringify(cost));
  await NodeFSP.writeFile(
    outFile,
    `${JSON.stringify({ at: new Date().toISOString(), filesScanned: all.length, results, cost }, null, 2)}\n`,
  );
} finally {
  await browser.close().catch(() => undefined);
  await launched.close();
  server.close();
}

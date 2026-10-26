// Headless check of thread follow on a real ChatView: a click on a message while the
// view sits off the end (new-turn framing, a frame behind streamed text) must not stop
// following; a real upward wheel does, and scrolling back to the end resumes it.
// Derived from installed-check.mjs: installed bundle by default, or SPECWITHCODE_SOURCE_ENTRY.
// Runs the app's own bundled server (ELECTRON_RUN_AS_NODE) on a private base dir
// and port. No provider can run: every provider is disabled except claudeAgent,
// which points at a missing binary and a private CLAUDE_CONFIG_DIR so a synthetic
// transcript can be imported as a long thread. The live app and its state are untouched.
// Usage: node thread-follow-check.mjs <report-dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const out = resolve(process.argv[2] ?? "report");
mkdirSync(out, { recursive: true });
const app = process.env.SPECWITHCODE_APP ?? "/Applications/SpecWithCode.app";
const asar = `${app}/Contents/Resources/app.asar`;
const entrypoint = `${asar}/apps/server/dist/bin.mjs`;
const privateRoot =
  process.env.INSTALLED_CHECK_ROOT ??
  join(homedir(), ".local/share/specwithcode/verification/thread-follow");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const state = mkdtempSync(join(privateRoot, "state-"));
mkdirSync(join(state, "userdata"));
const claudeHome = join(state, "claude-home");
// A private HOME keeps the server away from the real provider homes and usage caches.
const privateHome = join(state, "home");
mkdirSync(privateHome);
// Import skips folders inside the server's base dir, so projects live beside it.
const work = mkdtempSync(join(privateRoot, "work-"));
const atlasRoot = join(work, "atlas");
const beaconRoot = join(work, "beacon");
for (const dir of [atlasRoot, beaconRoot]) mkdirSync(dir);
writeFileSync(
  join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: {
      ...Object.fromEntries(
        ["codex", "cursor", "grok", "pi", "opencode", "antigravity"].map((id) => [
          id,
          { enabled: false },
        ]),
      ),
      claudeAgent: {
        enabled: true,
        binaryPath: join(state, "no-such-claude"),
        homePath: claudeHome,
      },
    },
  }),
);

// 40 exchanges: long enough that the thread opens far below its first message.
const MESSAGES = 80;
const sessionId = randomUUID();
const transcriptDir = join(claudeHome, "projects", atlasRoot.replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(transcriptDir, { recursive: true });
const start = Date.parse("2026-10-17T09:00:00Z");
writeFileSync(
  join(transcriptDir, `${sessionId}.jsonl`),
  Array.from({ length: MESSAGES }, (_, index) => {
    const n = Math.floor(index / 2) + 1;
    const user = index % 2 === 0;
    const text = user
      ? `Question ${n}: what changed in step ${n}?`
      : `Answer ${n}: step ${n} moved the reader. ${"Details follow on this line. ".repeat(6)}`;
    return JSON.stringify({
      type: user ? "user" : "assistant",
      sessionId,
      cwd: atlasRoot,
      uuid: randomUUID(),
      timestamp: new Date(start + index * 60_000).toISOString(),
      message: user
        ? { role: "user", content: text }
        : { role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text }] },
    });
  }).join("\n") + "\n",
);

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright-core"
);
const port = await new Promise((done, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
// SPECWITHCODE_SOURCE_ENTRY runs a source checkout's server (serving its built web client) under Node instead.
const sourceEntry = process.env.SPECWITHCODE_SOURCE_ENTRY;
const child = spawn(
  sourceEntry ? process.execPath : `${app}/Contents/MacOS/SpecWithCode`,
  [
    sourceEntry ?? entrypoint,
    "serve",
    "--no-browser",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
  ],
  {
    cwd: state,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) =>
            k !== "CLAUDE_CONFIG_DIR" &&
            !k.startsWith("ANTHROPIC_") &&
            !k.startsWith("CLAUDE_CODE") &&
            !k.startsWith("STUDIO_") &&
            !k.startsWith("SPECWITHCODE_"),
        ),
      ),
      ...(sourceEntry ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      STUDIO_DISABLE_HOSTED_SERVICES: "true",
      SPECWEAVE_STUDIO_THREAD_ID: "",
      CLAUDE_CONFIG_DIR: claudeHome,
      HOME: privateHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
// The server prints its pairing token, a pairing URL and a QR code of it; keep none of them.
const scrub = (text) =>
  text
    .split("\n")
    .filter((line) => !/[\u2580-\u259f]/.test(line))
    .join("\n")
    .replace(/Token: \S+/g, "Token: <omitted>")
    .replace(/token=[^\s&]+/gi, "token=<omitted>");
let output = "";
const credential = new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error("installed server startup timed out")), 60000);
  const observe = (chunk) => {
    output += chunk.toString();
    const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
    if (match) {
      clearTimeout(timer);
      done(match[1]);
    }
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`installed server exited ${code}: ${scrub(output).slice(-1500)}`));
  });
});
const receipt = {
  app: sourceEntry ?? app,
  version: null,
  pid: child.pid,
  port,
  state,
  work,
  headless: true,
  checks: [],
  screenshots: [],
};
let browser;
let page;
const shot = async (name) => {
  await page.screenshot({ path: join(out, name) });
  receipt.screenshots.push(join(out, name));
};
try {
  const token = await credential;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential: token },
    headers: { Origin: origin },
  });
  assert.equal(auth.status(), 200);
  async function rpc(tag, payload) {
    const ticket = (
      await (
        await context.request.post(`${origin}/api/auth/websocket-ticket`, {
          headers: { Origin: origin },
        })
      ).json()
    ).ticket;
    const url = new URL(origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    return new Promise((done, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => (ws.close(), reject(new Error(`RPC timeout ${tag}`))), 30000);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        for (const item of [JSON.parse(event.data)].flat())
          if (item._tag === "Exit" && String(item.requestId) === "1") {
            clearTimeout(timer);
            ws.close();
            item.exit?._tag === "Success"
              ? done(item.exit.value)
              : reject(new Error(`RPC ${tag}: ${JSON.stringify(item.exit).slice(0, 800)}`));
          }
      });
    });
  }
  const config = await rpc("server.getConfig", {});
  receipt.claudeSettings = {
    provider:
      config.providers?.find?.(
        (p) => p.instanceId === "claudeAgent" || p.provider === "claudeAgent",
      ) ?? null,
    settings: config.settings?.providers?.claudeAgent ?? null,
    instances: Object.keys(config.settings?.providerInstances ?? {}),
  };
  receipt.version = config.environment?.serverVersion ?? null;

  for (const [projectId, title, workspaceRoot] of [
    ["atlas", "Atlas Studio", atlasRoot],
    ["beacon", "Beacon", beaconRoot],
  ])
    await rpc("projects.mutate", {
      type: "project.create",
      commandId: `create-${projectId}`,
      projectId,
      title,
      workspaceRoot,
    });
  const scanned = await rpc("agentSessions.scan", {});
  receipt.checks.push({
    name: "scan",
    candidates: scanned.candidates.map((c) => ({
      path: c.path,
      threadCount: c.threadCount,
      sources: c.sources,
    })),
  });
  const imported = await rpc("agentSessions.import", { projectId: "atlas" });
  receipt.checks.push({ name: "import", imported });

  page = await context.newPage();
  page.setDefaultTimeout(20000);
  // The default 250-entry resource buffer drops later lazy chunks from the marker scan.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  await page.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
    ),
  );
  await page.goto(`${origin}/`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // 1.0.7x lists check-made projects under "Automated"; open the project, then its thread.
  const automated = page.getByText(/^Automated \(\d+\)$/).first();
  if (
    await automated.waitFor({ timeout: 15000 }).then(
      () => true,
      () => false,
    )
  )
    await automated.click();
  await page.getByText("Atlas Studio", { exact: true }).first().click();
  // An imported thread with no live turn is listed under the collapsed "Resolved" group.
  const resolved = page.getByText(/^Resolved\s*\d+$/).first();
  await page
    .getByText("Welcome back.")
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => undefined);
  await page.waitForTimeout(1000);
  const header = page.locator("button[aria-expanded=false]", { hasText: "Resolved" }).first();
  if (await header.count()) await header.click();
  else if (
    await resolved.waitFor({ timeout: 10000 }).then(
      () => true,
      () => false,
    )
  )
    await resolved.click();
  const threadLink = page.getByText(/Question 1: what changed/).first();
  await threadLink.waitFor();
  await threadLink.click();
  const last = page
    .getByText(`Answer ${MESSAGES / 2}: step ${MESSAGES / 2} moved the reader`)
    .first();
  await last.waitFor();
  await page.waitForTimeout(500);
  const jump = page.locator("[data-jump-to-latest]");
  receipt.checks.push({
    name: "opens-at-latest",
    lastVisible: await last.isVisible(),
    jumpShown: await jump.isVisible().catch(() => false),
  });
  await shot("installed-thread-latest.png");

  const scrollNode = page.locator(".messages-timeline-scroll").first();
  const fromEnd = () =>
    scrollNode.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  const shown = () => jump.isVisible().catch(() => false);
  const state = async (label) => {
    await page.waitForTimeout(450);
    const at = { label, fromEnd: await fromEnd(), jump: await shown() };
    receipt.checks.push(at);
    return at;
  };
  await state("opened");
  // The view off the end with nobody scrolling: what new-turn framing or a
  // frame of streamed text leaves.
  await scrollNode.evaluate((el) => {
    el.scrollTop -= 160;
  });
  const nudged = await state("off the end, nobody scrolled");
  // A click on a message there: reading, selecting a word, opening a link.
  // By coordinates on a message in plain view: Playwright's own click would scroll it first.
  const spot = await scrollNode.evaluate((el) => {
    const view = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll("p, span")].filter((n) =>
      /^Answer \d+: step/.test(n.textContent ?? ""),
    );
    const visible = rows
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.top > view.top + 80 && r.bottom < view.bottom - 260);
    const r = visible.at(-1);
    return r ? { x: r.left + 30, y: r.top + 8 } : null;
  });
  if (spot) await page.mouse.click(spot.x, spot.y);
  receipt.clickSpot = spot;
  await scrollNode.evaluate((el) => {
    el.scrollTop -= 1;
  });
  const clicked = await state("clicked a message off the end");
  await shot("thread-after-click.png");
  // No message in plain view means no click happened: that is a failed check, not a pass.
  receipt.clickKeepsFollowing = spot !== null && !clicked.jump;
  // A real wheel up does stop following and offers the way back.
  const box = await scrollNode.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -1200);
  const wheeled = await state("wheeled up");
  await shot("thread-wheeled-up.png");
  // Scrolling back to the end follows again, no click.
  await page.mouse.wheel(0, 20000);
  const back = await state("wheeled back to the end");
  await shot("thread-back-at-end.png");
  receipt.wheelPauses = wheeled.jump && wheeled.fromEnd > 300;
  receipt.scrollBackResumes = !back.jump && back.fromEnd <= 24;
  receipt.nudgeKeepsFollowing = !nudged.jump;
  receipt.ok =
    receipt.clickKeepsFollowing &&
    receipt.wheelPauses &&
    receipt.scrollBackResumes &&
    receipt.nudgeKeepsFollowing;
} finally {
  if (!receipt.ok && page)
    await page.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
  writeFileSync(join(out, "thread-follow.json"), JSON.stringify(receipt, null, 2) + "\n");
  if (child.exitCode === null) child.kill("SIGTERM");
  await browser?.close().catch(() => undefined);
}
process.exitCode = receipt.ok ? 0 : 1;
console.log(JSON.stringify(receipt, null, 2));

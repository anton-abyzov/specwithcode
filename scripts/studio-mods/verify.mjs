// Headless end-to-end check of Studio Mods on a private, freshly built server.
//
//   node scripts/studio-mods/verify.mjs /absolute/owned/report-dir
//
// Builds nothing: run `node apps/server/scripts/cli.ts build` first. Starts the
// server in a new temporary home with the example mods plus a probe mod that
// tries to reach the network, approves them in Settings > Mods, runs a mod
// command from the palette, and checks the probe never reached the network.
// No provider credentials exist in the home and no turn is started.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

NodeAssert.ok(process.versions.node.startsWith("22."));
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const out = NodePath.resolve(process.argv[2] ?? ".studio-build-evidence/mods");
NodeFS.mkdirSync(out, { recursive: true });

const freePort = () =>
  new Promise((done, reject) => {
    const socket = NodeNet.createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => done(port));
    });
  });

// Anything the probe mod manages to send lands here.
const leaks = [];
const leakServer = NodeHttp.createServer((request, response) => {
  leaks.push(request.url);
  response.end("leak");
});
await new Promise((done) => leakServer.listen(0, "127.0.0.1", done));
const leakOrigin = `http://127.0.0.1:${leakServer.address().port}`;

const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mods-"));
const modsDir = NodePath.join(home, "userdata/mods");
NodeFS.mkdirSync(modsDir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(home, "userdata/settings.json"),
  JSON.stringify({ providerInstances: {} }),
);
for (const name of [
  "review-queue",
  "focus-timer",
  "ready-to-close",
  "ac-trace-lint",
  "increment-standup",
]) {
  NodeFS.cpSync(NodePath.join(root, "examples/mods", name), NodePath.join(modsDir, name), {
    recursive: true,
  });
}
NodeFS.mkdirSync(NodePath.join(modsDir, "net-probe"));
NodeFS.writeFileSync(
  NodePath.join(modsDir, "net-probe/mod.json"),
  JSON.stringify({ name: "net-probe", version: "0.0.1", main: "./register.js" }),
);
NodeFS.writeFileSync(
  NodePath.join(modsDir, "net-probe/register.js"),
  `export function register(on) {
  on("app.start", async ($, e, next) => {
    const probes = {};
    try { await fetch("${leakOrigin}/fetch"); probes.fetch = "open"; } catch { probes.fetch = "blocked"; }
    try { probes.parent = String(window.parent.location.href); } catch { probes.parent = "blocked"; }
    try { localStorage.getItem("studio:client-settings:v1"); probes.storage = "open"; } catch { probes.storage = "blocked"; }
    try { new Image().src = "${leakOrigin}/image"; } catch {}
    try { const s = document.createElement("script"); s.src = "${leakOrigin}/script.js"; document.head.append(s); } catch {}
    try { parent.postMessage({ type: "request", requestId: 9, method: "threads.list" }, "*"); } catch {}
    // A frame can navigate itself even under default-src 'none'; a worker cannot.
    try { location.href = "${leakOrigin}/navigate"; probes.navigate = "open"; } catch { probes.navigate = "blocked"; }
    try { const a = document.createElement("a"); a.href = "${leakOrigin}/link"; document.body.append(a); a.click(); } catch {}
    for (let target = self; target; target = Object.getPrototypeOf(target)) {
      const original = Object.getOwnPropertyDescriptor(target, "fetch");
      if (original && typeof original.value === "function") {
        try { await original.value.call(self, "${leakOrigin}/prototype-fetch"); } catch {}
      }
    }
    $.ui.toast("probe " + JSON.stringify(probes));
    return next(e);
  });
}
`,
);

// A SpecWeave project: 0001 has every task done and was never verified, 0002
// has an acceptance criterion no task covers.
const project = NodePath.join(home, "work/payments");
const at = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
const seedIncrement = (name, files) => {
  for (const [file, text] of Object.entries(files)) {
    const target = NodePath.join(project, ".specweave/increments", name, file);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, text);
  }
};
const ledger = (...entries) =>
  entries.map((entry) => JSON.stringify({ by: "agent@host", ...entry })).join("\n") + "\n";
seedIncrement("0001-retry-worker", {
  "metadata.json": JSON.stringify({ status: "active", lastActivity: at(1) }),
  "spec.md": `# Retry worker\n\n- [ ] AC-01: Failed charges retry.\n\n### T-01 Worker\n- AC: AC-01 | Files: a.ts | Test: true\n`,
  "ledger.jsonl": ledger(
    { t: "T-01", e: "claim", at: at(31) },
    { t: "T-01", e: "done", at: at(30), evidence: "abc123" },
  ),
});
seedIncrement("0002-retry-badge", {
  "metadata.json": JSON.stringify({ status: "active", lastActivity: at(1) }),
  "spec.md": `# Retry badge\n\n- [ ] AC-01: Badge shows.\n- [ ] AC-02: Nobody covers this.\n\n### T-01 Badge\n- AC: AC-01 | Files: b.tsx | Test: true\n`,
  "ledger.jsonl": ledger({ t: "T-01", e: "claim", at: at(0.5) }),
});

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const serverEnv = {
  PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: home,
  CODEX_HOME: NodePath.join(home, "codex"),
  CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
  XDG_CONFIG_HOME: NodePath.join(home, "config"),
  XDG_CACHE_HOME: NodePath.join(home, "cache"),
  LANG: "en_US.UTF-8",
};
NodeChildProcess.execFileSync(
  process.execPath,
  [
    NodePath.join(root, "apps/server/dist/bin.mjs"),
    "project",
    "add",
    "--base-dir",
    home,
    "--title",
    "Payments",
    project,
  ],
  { cwd: home, env: serverEnv, stdio: "ignore" },
);
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(root, "apps/server/dist/bin.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    home,
    "--no-browser",
  ],
  {
    cwd: home,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const receipt = { headless: true, privateHome: home, pid: child.pid, nativeTurns: 0, checks: [] };
const check = (name, ok, detail) => {
  receipt.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  NodeAssert.ok(ok, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
let browser;
let page;
try {
  const credential = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Private server did not become ready")), 45000);
    const observe = (chunk) => {
      output += chunk;
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
      reject(new Error(`Private server exited: ${code}`));
    });
  });

  const { chromium } = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"))(
    "playwright-core",
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  // Init scripts run in every frame; mod frames have no storage by design.
  await context.addInitScript(() => {
    if (window !== window.top) return;
    if (!localStorage.getItem("studio:client-settings:v1"))
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
      );
  });
  const auth = await context.request.post(origin + "/api/auth/browser-session", {
    data: { credential },
    headers: { Origin: origin },
  });
  NodeAssert.equal(auth.status(), 200);
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(origin + "/settings/mods");
  const names = [
    "ac-trace-lint",
    "focus-timer",
    "increment-standup",
    "net-probe",
    "ready-to-close",
    "review-queue",
  ];
  for (const name of names) {
    await page.locator(`#mod-${name}`).getByText("Needs review").waitFor({ timeout: 30000 });
  }
  check("six mods listed as needing review", true);
  await page.screenshot({ path: NodePath.join(out, "mods-pending.png"), fullPage: true });

  for (const name of names) {
    await page.locator(`#mod-${name}`).getByRole("button", { name: "Review and approve" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText(`Approve ${name}?`).waitFor();
    await dialog.getByRole("button", { name: "Approve", exact: true }).click();
    await page.locator(`#mod-${name}`).getByText("Running").waitFor({ timeout: 15000 });
  }
  check("approvals pinned and mods running", true);
  const approvals = JSON.parse(
    NodeFS.readFileSync(NodePath.join(home, "userdata/mod-approvals.json"), "utf8"),
  );
  check("approvals stored outside the mods folder", Object.keys(approvals).length === names.length);

  await page
    .getByText(/^probe /)
    .first()
    .waitFor({ timeout: 15000 });
  const probe = await page
    .getByText(/^probe /)
    .first()
    .textContent();
  check(
    "probe mod blocked from network, navigation, parent and storage",
    /"fetch":"blocked"/.test(probe) &&
      /"parent":"blocked"/.test(probe) &&
      /"storage":"blocked"/.test(probe) &&
      /"navigate":"blocked"/.test(probe),
    probe,
  );
  await page.screenshot({ path: NodePath.join(out, "mods-running.png"), fullPage: true });

  // Run a mod command from the palette and see its status in the sidebar.
  await page.goto(origin + "/");
  await page.waitForTimeout(1500);
  // SpecWeave mods read the seeded increments through specweave:read.
  const modStatus = page.getByLabel("Mod status");
  await modStatus.getByText("1 needs verify").waitFor({ timeout: 15000 });
  await modStatus.getByText("1 trace gap in 1 increment").waitFor({ timeout: 15000 });
  check("SpecWeave mods report the close queue and the trace gap", true);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("waiting to be closed");
  await page.getByText("Show increments waiting to be closed").first().click();
  const queue = page.getByRole("dialog");
  await queue.getByText("0001-retry-worker").waitFor({ timeout: 10000 });
  await queue.getByText("Never verified").waitFor();
  check("close queue pane lists the unverified increment", true);
  await page.screenshot({ path: NodePath.join(out, "mods-close-queue.png") });
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("input:focus").fill("standup");
  await page.getByText("Show the standup from SpecWeave increments").first().click();
  const standup = page.getByRole("dialog");
  // 0001's task finished 30 hours ago: outside "Since yesterday", inside "Last week".
  await standup.getByText("0 tasks done · 1 in progress · 0 blocked · 0 stale").waitFor({
    timeout: 10000,
  });
  await standup.getByRole("button", { name: "Last week" }).click();
  await standup.getByText("1 task done · 1 in progress · 0 blocked · 0 stale").waitFor();
  await standup.getByText("T-01 Worker").waitFor();
  check("standup pane reads the ledger and its window buttons redraw it", true);
  await page.screenshot({ path: NodePath.join(out, "mods-standup.png") });
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("input:focus").fill("focus timer");
  await page.getByText("Start a 25 minute focus timer").first().click();
  await page.getByLabel("Mod status").getByText("Focus 25 min").waitFor({ timeout: 10000 });
  check("palette command ran and the sidebar shows mod status", true);

  await page.keyboard.press("ControlOrMeta+k");
  // The palette keeps its last query; replace it.
  await page.locator("input:focus").fill("waiting on me");
  await page.getByText("Show sessions waiting on me").first().click();
  await page
    .getByRole("dialog")
    .getByText("Nothing is waiting on you.")
    .waitFor({ timeout: 10000 });
  check("mod pane drawn by the host from its tree", true);
  await page.screenshot({ path: NodePath.join(out, "mods-pane.png") });
  await page.keyboard.press("Escape");

  // Editing an approved mod pauses it until it is approved again.
  NodeFS.appendFileSync(NodePath.join(modsDir, "focus-timer/register.js"), "\n// edited\n");
  await page.goto(origin + "/settings/mods");
  await page.locator("#mod-focus-timer").getByText("Changed, paused").waitFor({ timeout: 15000 });
  check("edited mod is paused", true);
  await page.screenshot({ path: NodePath.join(out, "mods-changed.png"), fullPage: true });

  await page.waitForTimeout(1000);
  check("probe reached nothing on the network", leaks.length === 0, leaks);
  check("no page errors", errors.length === 0, errors);
} catch (error) {
  await page?.screenshot({ path: NodePath.join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  leakServer.close();
  NodeFS.writeFileSync(NodePath.join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  NodeFS.rmSync(home, { recursive: true, force: true });
}
console.log(`Studio Mods verified headless; evidence in ${out}`);

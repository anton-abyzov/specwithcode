// Installed acceptance for folder-only Claude Code MCP entries (0978).
// Runs the INSTALLED app's bundled server (ELECTRON_RUN_AS_NODE) with a private
// state folder and a fixture HOME, so it never reads the user's ~/.claude.json,
// credentials or live app state. Checks the inventory payload and project
// scoping over RPC, then Settings > Connections in headless Chrome, light and dark.
// Usage: node scripts/studio-verify/connections-folder-only-installed.mjs <report-dir>
import * as NodeAssert from "node:assert/strict";
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const out = NodePath.resolve(process.argv[2] ?? "reports/connections-folder-only-installed");
NodeFS.mkdirSync(out, { recursive: true });
const app = process.env.SPECWITHCODE_APP ?? "/Applications/SpecWithCode.app";
const entrypoint = `${app}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`;
// Resolved before the server starts or fixture folders exist, so a failure leaves nothing behind.
const version = NodeChild.execFileSync("/usr/bin/defaults", [
  "read",
  `${app}/Contents/Info.plist`,
  "CFBundleShortVersionString",
])
  .toString()
  .trim();
const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const privateRoot = NodePath.join(NodeOS.homedir(), ".local/share/specweave-studio/verification");
NodeFS.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const root = NodeFS.mkdtempSync(NodePath.join(privateRoot, "folder-only-"));
let child;
// Whatever fails from here on, the fixture and the server this script started go away.
process.once("exit", () => {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  NodeFS.rmSync(root, { recursive: true, force: true });
});
const state = NodePath.join(root, "state");
const home = NodePath.join(root, "home");
const clientFolder = NodePath.join(home, "Clients", "acme-portal");
const demoFolder = NodePath.join(home, "work", "demo-site");
for (const dir of [NodePath.join(state, "userdata"), clientFolder, demoFolder])
  NodeFS.mkdirSync(dir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(
      ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"].map((id) => [
        id,
        { enabled: false },
      ]),
    ),
  }),
);
// Secrets the payload must never carry.
const SECRETS = ["fixture-header-token", "fixture-env-secret", "fixture-arg-secret"];
NodeFS.writeFileSync(
  NodePath.join(home, ".claude.json"),
  JSON.stringify({
    // A user entry so the matrix shows its groups, as on a real machine.
    mcpServers: { posthog: { type: "http", url: "https://example.invalid/mcp" } },
    projects: {
      [clientFolder]: {
        mcpServers: {
          figma: {
            type: "http",
            url: "https://mcp.invalid/acme",
            headers: { Authorization: `Bearer ${SECRETS[0]}` },
          },
          playwright: {
            command: "/opt/fixture-bin/playwright",
            args: ["--token", SECRETS[2]],
            env: { API_SECRET: SECRETS[1] },
          },
        },
      },
      [demoFolder]: { mcpServers: { playwright: { command: "npx" } } },
    },
  }),
);
const port = await new Promise((done, reject) => {
  const socket = NodeNet.createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
// Only what the server needs to start: no provider tokens, STUDIO_* or dev settings from this shell.
const env = {
  ...Object.fromEntries(
    ["PATH", "TMPDIR", "LANG", "USER", "LOGNAME", "SHELL"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  ),
  HOME: home,
  CODEX_HOME: NodePath.join(home, ".codex"),
  XDG_CONFIG_HOME: NodePath.join(home, ".config"),
  ELECTRON_RUN_AS_NODE: "1",
  STUDIO_DISABLE_AUTO_UPDATE: "true",
  SPECWEAVE_STUDIO_THREAD_ID: "",
};
child = NodeChild.spawn(
  `${app}/Contents/MacOS/SpecWithCode`,
  [
    entrypoint,
    "serve",
    "--no-browser",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
  ],
  { cwd: state, env, stdio: ["ignore", "pipe", "pipe"] },
);
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
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(
      new Error(
        `installed server exited ${code}: ${output.replace(/Token: \S+/g, "Token: <omitted>").slice(-1500)}`,
      ),
    );
  });
});
const receipt = {
  app,
  version,
  pid: child.pid,
  headless: true,
  fixtureHome: true,
  checks: [],
  screenshots: [],
};
let browser;
let page;
try {
  const token = await credential;
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    reducedMotion: "reduce",
  });
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential: token },
    headers: { Origin: origin },
  });
  NodeAssert.equal(auth.status(), 200);
  const rpc = async (tag, payload) => {
    const response = await context.request.post(`${origin}/api/auth/websocket-ticket`, {
      headers: { Origin: origin },
    });
    const url = new URL(origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", (await response.json()).ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    return new Promise((done, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => (ws.close(), reject(new Error(`RPC timeout ${tag}`))), 20000);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        for (const item of [JSON.parse(event.data)].flat())
          if (item._tag === "Exit" && String(item.requestId) === "1") {
            clearTimeout(timer);
            ws.close();
            if (item.exit?._tag === "Success") done(item.exit.value);
            else reject(new Error(`RPC ${tag}: ${JSON.stringify(item.exit).slice(0, 800)}`));
          }
      });
    });
  };

  // AC-02: folder entries carry only the folder's base name, transport and server name.
  const all = await rpc("connections.nativeRead", {});
  const folder = all.connections.filter((c) => c.sourceId === "claude-all-projects");
  NodeAssert.deepEqual(
    folder.map((c) => [c.name, c.transport, c.project]),
    [
      ["figma", "http", "acme-portal"],
      ["playwright", "stdio", "acme-portal"],
      ["playwright", "stdio", "demo-site"],
    ],
  );
  const allowed = [
    "id",
    "name",
    "project",
    "provider",
    "scope",
    "shadowed",
    "sourceId",
    "state",
    "transport",
  ];
  for (const entry of folder) NodeAssert.deepEqual(Object.keys(entry).toSorted(), allowed);
  const payload = JSON.stringify(all);
  for (const leak of [
    ...SECRETS,
    "Authorization",
    "API_SECRET",
    "mcp.invalid",
    "fixture-bin",
    "Clients",
    home,
  ])
    NodeAssert.ok(
      !payload.includes(leak),
      `inventory carries ${leak === home ? "the home path" : leak}`,
    );
  receipt.checks.push({ name: "inventory-payload", entries: folder.length, keys: allowed });

  // AC-03 (server half): a project's inventory holds only its own folder's local entries.
  const projectId = "folder-only-check";
  await rpc("projects.mutate", {
    type: "project.create",
    commandId: "fo-project",
    projectId,
    title: "Demo",
    workspaceRoot: demoFolder,
  });
  const scoped = await rpc("connections.nativeRead", { projectId });
  const local = scoped.connections.filter((c) => c.scope === "local");
  NodeAssert.deepEqual(
    local.map((c) => [c.name, c.sourceId, c.project]),
    [["playwright", "claude-local", undefined]],
  );
  NodeAssert.ok(
    !/figma|acme-portal/.test(JSON.stringify(scoped)),
    "project inventory names another folder",
  );
  receipt.checks.push({ name: "project-scoped-inventory", local: local.map((c) => c.name) });

  // AC-01 and AC-05: Settings > Connections, light and dark.
  for (const theme of ["light", "dark"]) {
    page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(() =>
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
      ),
    );
    await page.goto(`${origin}/settings/connections`);
    await page.getByText("Only in one folder (Claude Code) · 2").waitFor();
    await page.getByText("Claude Code loads these only when it runs in that folder.").waitFor();
    await page.getByText("Claude Code, only in acme-portal and 1 more folder · stdio").waitFor();
    await page.getByText("Claude Code, only in acme-portal · http").waitFor();
    NodeAssert.equal(await page.getByText(/private project/i).count(), 0);
    await page.getByRole("button", { name: "figma Claude Code details" }).click();
    await page.getByText("Claude Code, only in acme-portal (~/.claude.json)").waitFor();
    const file = `installed-folder-only-${theme}.png`;
    await page.getByTestId("connection-matrix").screenshot({ path: NodePath.join(out, file) });
    receipt.screenshots.push(file);
    receipt.checks.push({ name: `settings-${theme}`, ok: true });
    await page.close();
    page = undefined;
  }
  receipt.ok = true;
} finally {
  if (!receipt.ok && page)
    await page
      .screenshot({ path: NodePath.join(out, "failure.png"), fullPage: true })
      .catch(() => {});
  NodeFS.writeFileSync(
    NodePath.join(out, "installed-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((done) => setTimeout(() => done(false), 10000)),
    ]);
    if (!stopped) child.kill("SIGKILL");
  }
  NodeFS.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));

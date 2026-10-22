#!/usr/bin/env node
// Headless end-to-end check of the design editor against a real, isolated server: built
// apps/server/dist and apps/web/dist, a private base dir, every model provider off and one
// model-free ACP agent that edits through design_apply. Writes screenshots, downloads and
// report.json to the report folder.
// It shares design-agent.mjs with verify-live.mjs. Build first: web `vp build`, server `vp pack`.
// Usage: node apps/web/tests/design-workspace/live/verify-canvas.mjs /absolute/report-dir
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { launch, repoRoot } from "../../design-canvas/serve.mjs";

if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use Node 22");
const out = NodePath.resolve(process.argv[2] ?? "/tmp/design-canvas-real");
const shots = NodePath.join(out, "screenshots");
const downloads = NodePath.join(out, "downloads");
for (const dir of [out, shots, downloads]) NodeFS.mkdirSync(dir, { recursive: true });
const entrypoint = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
for (const file of [entrypoint, NodePath.join(repoRoot, "apps/web/dist/index.html")])
  if (!NodeFS.existsSync(file)) throw new Error(`Build first: missing ${file}`);

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "design-canvas-real-"));
const data = NodePath.join(scratch, "data");
const workspace = NodePath.join(scratch, "marina");
const agentResult = NodePath.join(scratch, "agent-result.json");
const results = [];
const errors = [];
const report = {
  source: NodeChildProcess.execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
  evidenceKind: "real-isolated-server-headless-chromium",
  builtEntrypointSha256: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(entrypoint))
    .digest("hex"),
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  modelTurns: 0,
  results,
  errors,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function waitFor(predicate, timeout = 5000, label = "condition") {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
let failureShot = null;
async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) });
    console.log(`ok   ${name}${detail ? ` (${JSON.stringify(detail)})` : ""}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    });
    await failureShot?.(name).catch(() => undefined);
    console.log(`FAIL ${name}: ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

// ---- isolated server -------------------------------------------------------------------------
const freePort = () =>
  new Promise((done, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
NodeFS.mkdirSync(NodePath.join(data, "userdata"), { recursive: true });
const drivers = [
  "codex",
  "claudeAgent",
  "claude-agent",
  "cursor",
  "grok",
  "pi",
  "opencode",
  "opencode2",
  "antigravity",
];
NodeFS.writeFileSync(
  NodePath.join(data, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: {
      ...Object.fromEntries(
        drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
      ),
      designAgent: {
        driver: "acpRegistry",
        displayName: "Design apply agent",
        enabled: true,
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [
            NodePath.join(repoRoot, "apps/web/tests/design-workspace/live/design-agent.mjs"),
            agentResult,
          ],
          customModels: ["design-agent"],
        },
      },
    },
    cursorKeychainUsageEnabled: false,
  }),
);
NodeFS.mkdirSync(workspace);
NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "Synthetic design canvas check.\n");
NodeChildProcess.execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], {
  cwd: workspace,
  env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
});

const serverLog = NodeFS.createWriteStream(NodePath.join(out, "server.log"));
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    entrypoint,
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    data,
    "--no-browser",
  ],
  {
    cwd: scratch,
    env: {
      PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: scratch,
      LANG: "en_US.UTF-8",
      STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const bootstrap = await new Promise((done, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("server startup timeout")), 45000);
  const inspect = (chunk) => {
    serverLog.write(chunk);
    buffer = (buffer + chunk).slice(-65536);
    const token = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
    if (token) {
      clearTimeout(timer);
      done(token[1]);
    }
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  child.once("exit", () => reject(new Error("server exited during startup")));
});
let token;
{
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Design canvas real-server check",
    }),
  });
  assert(response.status === 200, `token exchange ${response.status}`);
  token = (await response.json()).access_token;
}
async function request(path, body) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== 200)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function rpc(tag, payload) {
  const { ticket } = await request("/api/auth/websocket-ticket");
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((done, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`RPC timeout: ${tag}`));
    }, 20000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    socket.addEventListener("message", (event) => {
      const values = [JSON.parse(event.data)].flat();
      for (const value of values)
        if (value._tag === "Exit" && String(value.requestId) === "1") {
          clearTimeout(timer);
          socket.close();
          value.exit?._tag === "Success"
            ? done(value.exit.value)
            : reject(new Error(`RPC ${tag} failed: ${JSON.stringify(value.exit).slice(0, 600)}`));
        }
    });
  });
}

// ---- seed: a project and one design with a frame, text, a card and an html node --------------
const projectId = NodeCrypto.randomUUID();
await request("/api/projects/mutate", {
  type: "project.create",
  commandId: NodeCrypto.randomUUID(),
  projectId,
  title: "Marina",
  workspaceRoot: workspace,
  defaultModelSelection: { instanceId: "designAgent", model: "design-agent" },
});
const owner = { kind: "project", projectId };
const created = await rpc("design.create", { owner, kind: "design", title: "Marina booking" });
const designId = created.ref.designId ?? created.document.id;
const pageId = created.document.pages[0].id;
const frameId = created.document.pages[0].nodes.find((n) => n.type === "frame").id;
await rpc("design.apply", {
  owner,
  designId,
  expectedRevision: created.document.revision,
  operations: [
    {
      op: "update_node",
      pageId,
      id: frameId,
      patch: { name: "Booking", width: 1280, height: 820, fill: "#ffffff" },
    },
    {
      op: "add_node",
      pageId,
      node: {
        id: "n_title",
        parentId: frameId,
        type: "text",
        name: "Headline",
        text: "Reserve a slip for tonight",
        x: 40,
        y: 140,
        width: 640,
        height: 64,
        fontSize: 48,
        fontWeight: 700,
        color: "#0f172a",
      },
    },
    {
      op: "add_node",
      pageId,
      node: {
        id: "n_card",
        parentId: frameId,
        type: "rect",
        name: "Map card",
        x: 720,
        y: 120,
        width: 520,
        height: 420,
        fill: "#e2e8f0",
        radius: 16,
        stroke: "#cbd5e1",
        strokeWidth: 1,
      },
    },
    {
      op: "add_node",
      pageId,
      node: {
        id: "n_html",
        parentId: frameId,
        type: "html",
        name: "Tide table",
        x: 40,
        y: 320,
        width: 400,
        height: 160,
        html: "<table><tr><th>High</th><td>06:12</td></tr><tr><th>Low</th><td>12:40</td></tr></table>",
      },
    },
  ],
});
const designKey = `p.${projectId}.${designId}`;
const serverDoc = async () => (await rpc("design.get", { owner, designId })).document;
const serverNodes = async () => (await serverDoc()).pages[0].nodes;
const serverNode = async (id) => (await serverNodes()).find((n) => n.id === id);
report.design = { projectId, designId, designKey, workspace };

// ---- browser ---------------------------------------------------------------------------------
const browser = await launch();
const VIEWPORT = { width: 1600, height: 960 };
async function signedInContext(colorScheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme,
    acceptDownloads: true,
  });
  // Design reads need filesystem:read, which a default paired browser does not get.
  const pairing = await request("/api/auth/pairing-token", {
    label: `Design canvas ${colorScheme}`,
    scopes: [
      "orchestration:read",
      "orchestration:operate",
      "filesystem:read",
      "filesystem:write",
      "settings:write",
    ],
  });
  const signedIn = await context.request.post(`${origin}/api/auth/browser-session`, {
    headers: { Origin: origin },
    data: { credential: pairing.credential },
  });
  assert(signedIn.status() === 200, `browser sign-in ${signedIn.status()}`);
  // A paired browser is a design member and may not bind threads; the desktop app is the
  // owner. Act as the owner by carrying the startup credential's session in the cookie.
  const cookies = await context.cookies(origin);
  const session = cookies.find((cookie) => cookie.name.startsWith("studio_session"));
  assert(session, `no session cookie: ${cookies.map((cookie) => cookie.name).join(",")}`);
  await context.addCookies([{ ...session, value: token }]);
  return context;
}
async function openEditor(context, label) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${label}: ${error}`));
  page.on(
    "console",
    (message) =>
      message.type() === "error" &&
      !(
        message.location().url === "about:srcdoc" && /Content Security Policy/.test(message.text())
      ) &&
      errors.push(`${label}: ${message.text()}`),
  );
  await page.goto(`${origin}/design/${designKey}`);
  try {
    await page.waitForSelector("[data-testid=design-canvas]", { timeout: 30000 });
  } catch (error) {
    await shot(page, `${label}-open-failed`);
    console.error(
      `open failed at ${page.url()}\n${errors.join("\n")}\n${(await page.locator("body").innerText()).slice(0, 2000)}`,
    );
    throw error;
  }
  await page.locator(`[data-node="${frameId}"]`).waitFor({ timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
}
const saved = (page) =>
  waitFor(
    async () => (await page.getByTestId("save-state").textContent())?.trim() === "Saved",
    6000,
    "Saved",
  );
const box = async (page, id) => {
  const value = await page.locator(`[data-node="${id}"]`).first().boundingBox();
  assert(value !== null, `${id} has no box`);
  return value;
};
const focusCanvas = (page) => page.getByTestId("design-canvas").focus();
const shot = (page, name) => page.screenshot({ path: NodePath.join(shots, `${name}.png`) });

try {
  const context = await signedInContext("light");
  const page = await openEditor(context, "light");
  failureShot = (name) => shot(page, `fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);

  await check("opens the design from the real server, Saved", async () => {
    await saved(page);
    assert(await page.locator('[data-node="n_title"]').isVisible(), "headline not on the canvas");
    const sandbox = await page.locator(`[data-node="n_html"] iframe`).getAttribute("sandbox");
    assert(sandbox !== null && !sandbox.includes("allow-same-origin"), `sandbox ${sandbox}`);
    // The header picker reads designSystem.list through the guarded read path.
    const picker = page.getByTestId("design-system-picker").getByRole("combobox");
    assert(!(await picker.isDisabled()), "the owner cannot change the design system");
    const system = (await picker.textContent()).trim();
    assert(system === "None" && (await serverDoc()).designSystem === null, `picker ${system}`);
    await shot(page, "01-opened-light");
    return { revision: (await serverDoc()).revision, sandbox, system };
  });

  let drawnId;
  await check("draw a rectangle; autosave reaches the server", async () => {
    const before = (await serverNodes()).length;
    const frame = await box(page, frameId);
    await focusCanvas(page);
    await page.keyboard.press("r");
    const start = { x: frame.x + 60, y: frame.y + frame.height * 0.75 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + 40, { steps: 4 });
    await page.mouse.move(start.x + 160, start.y + 80, { steps: 4 });
    await page.mouse.up();
    await saved(page);
    const nodes = await waitFor(
      async () => {
        const list = await serverNodes();
        return list.length === before + 1 ? list : null;
      },
      5000,
      "server node count",
    );
    const added = nodes.at(-1);
    assert(added.type === "rect", `added ${added.type}`);
    drawnId = added.id;
    return { id: added.id, width: added.width, height: added.height };
  });

  await check("draw text from the keyboard", async () => {
    await focusCanvas(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    await page.keyboard.press("Enter");
    await page.locator("[data-testid=design-canvas] textarea").fill("Berths open after 6 pm");
    await page.keyboard.press("ControlOrMeta+Enter");
    await saved(page);
    await waitFor(
      async () =>
        (await serverNodes()).some((n) => n.type === "text" && n.text === "Berths open after 6 pm"),
      5000,
      "text on the server",
    );
  });

  await check("move the headline and nudge it; server has the edit", async () => {
    const before = await serverNode("n_title");
    const headline = await box(page, "n_title");
    const x = headline.x + headline.width / 2;
    const y = headline.y + headline.height / 2;
    await focusCanvas(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("v");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y + 10, { steps: 5 });
    await page.mouse.move(x + 40, y + 20, { steps: 5 });
    await page.mouse.up();
    await focusCanvas(page);
    await page.keyboard.press("Shift+ArrowRight");
    await saved(page);
    const after = await waitFor(
      async () => {
        const node = await serverNode("n_title");
        return node.x > before.x + 10 && node.y > before.y ? node : null;
      },
      5000,
      "moved headline on the server",
    );
    await shot(page, "02-drawn-and-edited");
    return { from: [before.x, before.y], to: [after.x, after.y] };
  });

  await check("autosave survives a reload", async () => {
    const revision = (await serverDoc()).revision;
    await page.reload();
    await page.locator(`[data-node="${drawnId}"]`).waitFor({ timeout: 15000 });
    await saved(page);
    assert((await serverDoc()).revision === revision, "reload changed the revision");
    return { revision };
  });

  await check("an agent edits through design_apply and the canvas shows it live", async () => {
    await page.getByTestId("bound-thread-empty").waitFor();
    await page.getByRole("button", { name: "Start a thread" }).click();
    await waitFor(() => NodeFS.existsSync(agentResult), 30000, "agent turn");
    const outcome = JSON.parse(NodeFS.readFileSync(agentResult, "utf8"));
    assert(!outcome.error, `agent: ${outcome.error}`);
    await page.locator('[data-node="agent_panel"]').waitFor({ timeout: 5000 });
    const doc = await waitFor(
      async () => {
        const value = await serverDoc();
        return value.thread?.threadId ? value : null;
      },
      10000,
      "design bound to the thread",
    );
    await page.getByTestId("bound-thread").waitFor({ timeout: 10000 });
    await page.getByText("Added a heading and a panel").first().waitFor({ timeout: 10000 });
    report.modelTurns = 0;
    await shot(page, "03-agent-edit");
    return {
      steps: outcome.calls.map((call) => call.name),
      revision: outcome.revision,
      thread: doc.thread.threadId,
    };
  });

  await check("place a comment; it saves to the server", async () => {
    const before = (await serverDoc()).comments.length;
    const card = await box(page, "n_card");
    await focusCanvas(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("c");
    // The chat's type-to-focus must not take the tool key from the canvas.
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    if (focused !== "design-canvas")
      throw new Error(`the c key moved focus to ${focused ?? "nothing"}`);
    await page.mouse.click(card.x + card.width / 2, card.y + card.height / 2);
    await page.getByPlaceholder("What should change?").fill("Show tide times under the map.");
    await page
      .getByTestId("comments-panel")
      .getByRole("button", { name: "Comment", exact: true })
      .click();
    await saved(page);
    const comments = await waitFor(
      async () => {
        const list = (await serverDoc()).comments;
        return list.length === before + 1 ? list : null;
      },
      5000,
      "comment on the server",
    );
    assert((await page.locator("[data-comment-pin]").count()) >= 1, "no pin");
    await shot(page, "04-comment");
    await page
      .getByRole("button", { name: "Close comments" })
      .click()
      .catch(() => undefined);
    return { comments: comments.length, author: comments.at(-1).author };
  });

  await check("export PNG, HTML and PDF from the server", async () => {
    const files = {};
    for (const [item, ext] of [
      [/^PNG of Booking/, "png"],
      ["Standalone HTML", "html"],
      ["PDF of all frames", "pdf"],
    ]) {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        page.getByRole("menuitem", { name: item }).click(),
      ]);
      const file = NodePath.join(downloads, `booking.${ext}`);
      await download.saveAs(file);
      const bytes = NodeFS.readFileSync(file);
      files[ext] = bytes.length;
      if (ext === "png") assert(bytes.subarray(1, 4).toString() === "PNG", "not a PNG");
      if (ext === "html")
        assert(bytes.toString().includes("Reserve a slip"), "HTML lacks the headline");
      if (ext === "pdf") assert(bytes.subarray(0, 5).toString() === "%PDF-", "not a PDF");
    }
    return files;
  });

  await check("present mode opens and exits with Escape", async () => {
    await page.getByRole("button", { name: "Present" }).click();
    const present = page.getByTestId("present-mode");
    await present.waitFor();
    await page.waitForTimeout(400);
    await shot(page, "05-present-light");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await present.waitFor({ state: "detached", timeout: 3000 });
  });

  await check("light: no console errors", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await context.close();

  const dark = await signedInContext("dark");
  const darkPage = await openEditor(dark, "dark");
  await check("dark theme renders the same design, agent edit and present mode", async () => {
    await saved(darkPage);
    await darkPage.locator('[data-node="agent_panel"]').waitFor();
    const background = await darkPage.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    await darkPage.locator('[data-node="n_card"]').click({ position: { x: 8, y: 8 } });
    await shot(darkPage, "06-dark");
    await darkPage.getByRole("button", { name: "Present" }).click();
    await darkPage.getByTestId("present-mode").waitFor();
    await darkPage.waitForTimeout(400);
    await shot(darkPage, "07-present-dark");
    await darkPage.keyboard.press("Escape");
    return { background };
  });
  await check("dark: no console errors", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await dark.close();
} finally {
  await browser.close().catch(() => undefined);
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (child.exitCode === null) child.kill("SIGKILL");
  const passed = results.filter((r) => r.ok).length;
  report.summary = `${passed}/${results.length} checks passed`;
  NodeFS.writeFileSync(NodePath.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(report.summary);
  NodeFS.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = passed === results.length ? 0 : 1;
}

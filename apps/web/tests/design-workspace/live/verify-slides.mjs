#!/usr/bin/env node
// Headless end-to-end check of slides against a real, isolated server: built apps/server/dist
// and apps/web/dist, a private test home under ~/.local/share/specweave-studio/verification,
// every model provider off, and a scratch project holding one design system. Creates a deck
// from the gallery, builds it from layouts, reorders and edits it through the slide rail,
// writes speaker notes and presents it with the presenter view, in light and dark. Writes
// screenshots, downloads and report.json to the report folder.
// Build first: web `vp build`, server `vp pack`.
// Usage: node apps/web/tests/design-workspace/live/verify-slides.mjs /absolute/report-dir
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { launch, repoRoot } from "../../design-canvas/serve.mjs";

if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use Node 22");
const out = NodePath.resolve(process.argv[2] ?? "/tmp/design-slides-real");
const shots = NodePath.join(out, "screenshots");
const downloads = NodePath.join(out, "downloads");
for (const dir of [out, shots, downloads]) NodeFS.mkdirSync(dir, { recursive: true });
const entrypoint = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
for (const file of [entrypoint, NodePath.join(repoRoot, "apps/web/dist/index.html")])
  if (!NodeFS.existsSync(file)) throw new Error(`Build first: missing ${file}`);

const privateRoot = NodePath.join(
  NodeOS.homedir(),
  ".local/share/specweave-studio/verification/design-slides",
);
NodeFS.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const scratch = NodeFS.mkdtempSync(NodePath.join(privateRoot, "run-"));
const data = NodePath.join(scratch, "data");
const workspace = NodePath.join(scratch, "harbor");
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

// ---- scratch project with one design system -----------------------------------------------
NodeFS.mkdirSync(workspace);
NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "Synthetic slides check.\n");
NodeChildProcess.execFileSync("/usr/bin/git", ["init", "-q", "-b", "main"], {
  cwd: workspace,
  env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
});
const systemId = "harbor-deck";
const token = (name, type, light, dark = light) => {
  const value = (raw, line) => ({
    raw,
    resolved: raw,
    provenance: { source: "file", location: "harbor/tokens.css", line, extractor: "css" },
  });
  return { name, type, values: { light: value(light, 1), dark: value(dark, 2) } };
};
const now = new Date().toISOString();
NodeFS.mkdirSync(NodePath.join(workspace, ".specweave/design/systems", systemId), {
  recursive: true,
});
NodeFS.writeFileSync(
  NodePath.join(workspace, ".specweave/design/systems", systemId, "system.json"),
  JSON.stringify(
    {
      schema: "swc.design-system/1",
      id: systemId,
      name: "Harbor deck",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      modes: [
        { id: "light", name: "Light" },
        { id: "dark", name: "Dark" },
      ],
      tokens: [
        token("hb-background", "color", "#ffffff", "#0d1419"),
        token("hb-foreground", "color", "#0e1a24", "#e8eef2"),
        token("hb-muted-foreground", "color", "#536271", "#93a3b0"),
        token("hb-card", "color", "#e7eef1", "#17242c"),
        token("hb-primary", "color", "#0b6e69", "#3fb7ae"),
        token("hb-primary-foreground", "color", "#ffffff", "#062320"),
        token("hb-font-display", "fontFamily", '"Iowan Old Style", Georgia, serif'),
        token("hb-font-sans", "fontFamily", '"Avenir Next", "Helvetica Neue", sans-serif'),
      ],
      components: [],
      sources: [{ kind: "file", location: "harbor/tokens.css", readAt: now }],
      copiedFrom: null,
    },
    null,
    2,
  ),
);

// Launch the browser first, so a missing browser never leaves a server running.
const browser = await launch();

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
  "copilot",
  "githubCopilot",
];
NodeFS.writeFileSync(
  NodePath.join(data, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: Object.fromEntries(
      drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
    ),
    cursorKeychainUsageEnabled: false,
  }),
);
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
report.serverPid = child.pid;
const bootstrap = await new Promise((done, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("server startup timeout")), 45000);
  const inspect = (chunk) => {
    serverLog.write(chunk);
    buffer = (buffer + chunk).slice(-65536);
    const found = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
    if (found) {
      clearTimeout(timer);
      done(found[1]);
    }
  };
  child.stdout.on("data", inspect);
  child.stderr.on("data", inspect);
  child.once("exit", () => reject(new Error("server exited during startup")));
});
let accessToken;
{
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Slides real-server check",
    }),
  });
  assert(response.status === 200, `token exchange ${response.status}`);
  accessToken = (await response.json()).access_token;
}
async function request(path, body) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Authorization: `Bearer ${accessToken}`,
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
          if (value.exit?._tag === "Success") done(value.exit.value);
          else reject(new Error(`RPC ${tag} failed: ${JSON.stringify(value.exit).slice(0, 600)}`));
        }
    });
  });
}

const projectId = NodeCrypto.randomUUID();
await request("/api/projects/mutate", {
  type: "project.create",
  commandId: NodeCrypto.randomUUID(),
  projectId,
  title: "Harbor",
  workspaceRoot: workspace,
});
const owner = { kind: "project", projectId };
report.project = { projectId, workspace };

// ---- browser ---------------------------------------------------------------------------------
const VIEWPORT = { width: 1600, height: 960 };
const NARROW_SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
const MIN_CANVAS = 480;
async function signedInContext(colorScheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme,
    acceptDownloads: true,
  });
  const pairing = await request("/api/auth/pairing-token", {
    label: `Slides ${colorScheme}`,
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
  // Act as the owner (the desktop app) by carrying the startup credential's session.
  const cookies = await context.cookies(origin);
  const session = cookies.find((cookie) => cookie.name.startsWith("studio_session"));
  assert(session, `no session cookie: ${cookies.map((cookie) => cookie.name).join(",")}`);
  await context.addCookies([{ ...session, value: accessToken }]);
  return context;
}
function watchErrors(page, label) {
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
}
const shot = (page, name) => page.screenshot({ path: NodePath.join(shots, `${name}.png`) });
const saved = (page) =>
  waitFor(
    async () => (await page.getByTestId("save-state").textContent())?.trim() === "Saved",
    8000,
    "Saved",
  );
let designId = null;
const serverDoc = async () => (await rpc("design.get", { owner, designId })).document;
const rail = (page) => page.getByTestId("slide-rail");
const slideItems = (page) => rail(page).getByTestId("slide-item");
const canvas = (page) => page.getByTestId("design-canvas");

/**
 * The prompt must sit inside the canvas viewport, and inside the slide whenever the slide
 * is drawn larger than the prompt's minimum (264 x 168 plus insets); otherwise centered on it.
 */
async function promptPlacement(page, frameId) {
  const round = (box) =>
    Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v)]));
  const prompt = round(await page.getByTestId("slide-layout-prompt").boundingBox());
  const view = round(await canvas(page).boundingBox());
  const slide = round(await canvas(page).locator(`[data-node="${frameId}"]`).boundingBox());
  const inside = (a, b) =>
    a.x >= b.x - 1 &&
    a.y >= b.y - 1 &&
    a.x + a.width <= b.x + b.width + 1 &&
    a.y + a.height <= b.y + b.height + 1;
  assert(
    inside(prompt, view),
    `prompt ${JSON.stringify(prompt)} leaves the canvas ${JSON.stringify(view)}`,
  );
  if (slide.width >= 288 && slide.height >= 192)
    assert(
      inside(prompt, slide),
      `prompt ${JSON.stringify(prompt)} leaves the slide ${JSON.stringify(slide)}`,
    );
  else {
    const centerOff = Math.abs(prompt.x + prompt.width / 2 - (slide.x + slide.width / 2));
    assert(centerOff <= 14, `prompt is ${centerOff}px off the small slide's center`);
  }
  return { prompt, canvas: view, slide };
}

async function addLayoutSlide(page, layout) {
  await page.getByTestId("new-slide").click();
  const picker = page.locator(`[data-testid=slide-layout][data-layout="${layout}"]`).last();
  await picker.waitFor();
  await picker.click();
}

try {
  const context = await signedInContext("light");
  const page = await context.newPage();
  watchErrors(page, "light");
  failureShot = (name) => shot(page, `fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);

  await check(
    "gallery: Slides creates a 1920x1080 deck in the project with its system",
    async () => {
      await page.goto(`${origin}/design`);
      await page.getByTestId("design-gallery").waitFor({ timeout: 30000 });
      await page.locator('[data-testid=design-create][data-kind="slides"]').click();
      const dialog = page.locator('[data-testid=new-design-dialog][data-kind="slides"]');
      await dialog.waitFor();
      await dialog.getByLabel("Title").fill("Harbor launch");
      await dialog.getByLabel("Save in").click();
      await page.getByRole("option", { name: "Harbor" }).click();
      await dialog.getByTestId("design-system-picker").getByRole("combobox").click();
      await page.getByRole("option", { name: /Harbor deck/ }).click();
      await shot(page, "01-new-slides-dialog-light");
      await dialog.getByRole("button", { name: "Create slides" }).click();
      await page.waitForURL(/\/design\/p\./, { timeout: 30000 });
      designId = decodeURIComponent(page.url().split("/design/")[1]).split(".").at(-1);
      await page.getByTestId("design-editor").waitFor({ timeout: 30000 });
      const document = await serverDoc();
      assert(document.kind === "slides", `kind ${document.kind}`);
      assert(document.designSystem === systemId, `system ${document.designSystem}`);
      const frame = document.pages[0].nodes[0];
      assert(frame.width === 1920 && frame.height === 1080, `frame ${frame.width}x${frame.height}`);
      return { designId, title: document.title, frame: `${frame.width}x${frame.height}` };
    },
  );

  await check("an empty slide offers the six layouts in the system's tokens", async () => {
    await rail(page).waitFor();
    assert((await slideItems(page).count()) === 1, "rail does not show one slide");
    const prompt = page.getByTestId("slide-layout-prompt");
    await prompt.waitFor();
    assert((await prompt.getByTestId("slide-layout").count()) === 6, "not six layouts");
    await page.waitForTimeout(300);
    await shot(page, "02-layout-prompt-light");
    const frameId = (await serverDoc()).pages[0].nodes[0].id;
    const placement = await promptPlacement(page, frameId);
    await prompt.locator('[data-layout="title"]').click();
    await saved(page);
    const nodes = (await serverDoc()).pages[0].nodes;
    const frame = nodes[0];
    const title = nodes.find((node) => node.name === "Title");
    assert(frame.fill?.token === "hb-background", `frame fill ${JSON.stringify(frame.fill)}`);
    assert(title?.color?.token === "hb-foreground", `title color ${JSON.stringify(title?.color)}`);
    assert(title?.fontFamily?.token === "hb-font-display", "title font is not the display token");
    await prompt.waitFor({ state: "detached" });
    return {
      nodes: nodes.length,
      frameFill: frame.fill,
      titleFont: title.fontFamily,
      placement,
    };
  });

  for (const size of NARROW_SIZES)
    await check(
      `${size.width}x${size.height}: the canvas keeps ${MIN_CANVAS}px, its toolbar and a 25% slide`,
      async () => {
        // A blank slide (Add slide after) brings the prompt back; then shrink the window.
        await slideItems(page).nth(0).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Add slide after" }).click();
        await saved(page);
        await page.setViewportSize(size);
        await page.waitForTimeout(300);
        await canvas(page).focus();
        await page.keyboard.press("Shift+1");
        await page.getByTestId("slide-layout-prompt").waitFor();
        await page.waitForTimeout(400);
        const box = await canvas(page).boundingBox();
        assert(box.width >= MIN_CANVAS, `canvas is ${Math.round(box.width)}px wide`);
        // Every toolbar group, and every tool, stays inside the canvas.
        const groups = await page.getByTestId("canvas-toolbar").locator(":scope > *").all();
        const outside = [];
        for (const group of groups) {
          const rect = await group.boundingBox();
          if (
            rect.x < box.x - 1 ||
            rect.y < box.y - 1 ||
            rect.x + rect.width > box.x + box.width + 1 ||
            rect.y + rect.height > box.y + box.height + 1
          )
            outside.push(rect);
        }
        assert(outside.length === 0, `toolbar leaves the canvas: ${JSON.stringify(outside)}`);
        const tools = page.getByTestId("canvas-toolbar").locator("[data-tool]");
        const toolCount = await tools.count();
        assert(toolCount === 11, `${toolCount} tools in the toolbar`);
        for (const tool of await tools.all()) {
          const rect = await tool.boundingBox();
          assert(
            rect !== null && rect.x + rect.width <= box.x + box.width + 1,
            "a tool leaves the canvas",
          );
        }
        const zoom = Number(
          (await page.getByTestId("zoom-menu").textContent()).replace(/[^0-9]/g, ""),
        );
        assert(zoom >= 25, `zoom to fit shows the slide at ${zoom}%`);
        const editor = page.getByTestId("design-editor");
        const layout = await editor.locator("[data-chat]").evaluate((element) => ({
          chat: element.getAttribute("data-chat"),
          side: element.getAttribute("data-side"),
        }));
        const railCompact = (await rail(page).getAttribute("data-compact")) === "true";
        const document = await serverDoc();
        const placement = await promptPlacement(page, document.pages[1].nodes[0].id);
        await shot(page, `02b-narrow-${size.width}x${size.height}-light`);
        // A thread and a side panel that open over the canvas leave its width alone.
        const overlays = {};
        if (layout.chat === "overlay") {
          await page.getByRole("button", { name: "Show thread", exact: true }).click();
          await page.getByTestId("design-thread").waitFor();
          overlays.thread = Math.round((await canvas(page).boundingBox()).width);
          await page.getByRole("button", { name: "Hide thread", exact: true }).click();
          await page.getByTestId("design-thread").waitFor({ state: "detached" });
        }
        if (layout.side === "overlay") {
          await page.getByRole("button", { name: "Properties", exact: true }).click();
          await page.getByTestId("design-side-panel").waitFor();
          overlays.properties = Math.round((await canvas(page).boundingBox()).width);
          await shot(page, `02c-narrow-${size.width}x${size.height}-properties-light`);
          await page.getByRole("button", { name: "Properties", exact: true }).click();
          await page.getByTestId("design-side-panel").waitFor({ state: "detached" });
        }
        for (const width of Object.values(overlays))
          assert(Math.abs(width - box.width) <= 1, `an overlay changed the canvas to ${width}px`);
        // Remove the blank slide again and restore the window.
        await slideItems(page).nth(1).click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Delete/ }).click();
        await saved(page);
        await page.setViewportSize(VIEWPORT);
        await waitFor(
          async () => (await serverDoc()).pages.length === 1,
          5000,
          "blank slide deleted",
        );
        return {
          canvasWidth: Math.round(box.width),
          zoom,
          tools: toolCount,
          layout: { ...layout, rail: railCompact ? "compact" : "full" },
          overlays,
          placement,
        };
      },
    );

  await check("New slide adds each layout after the current slide", async () => {
    await page.getByTestId("new-slide").click();
    await page.locator("[data-testid=slide-layout]").first().waitFor();
    await page.waitForTimeout(300);
    await shot(page, "03-layout-picker-light");
    await page.keyboard.press("Escape");
    for (const layout of ["section", "title-body", "two-columns", "image-caption", "quote"])
      await addLayoutSlide(page, layout);
    await saved(page);
    const document = await serverDoc();
    assert(document.pages.length === 6, `pages ${document.pages.length}`);
    const names = document.pages.map((p) => p.nodes.map((n) => n.name).join("|"));
    assert(names[5].includes("Quote"), "the last slide is not the quote layout");
    assert((await slideItems(page).count()) === 6, "rail does not show six slides");
    return { pages: document.pages.map((p) => p.name) };
  });

  await check("layout nodes stay editable: select and nudge the quote", async () => {
    const document = await serverDoc();
    const quote = document.pages[5].nodes.find((node) => node.name === "Quote");
    const node = canvas(page).locator(`[data-node="${quote.id}"]`);
    await node.click();
    await canvas(page).focus();
    await page.keyboard.press("Shift+ArrowRight");
    await saved(page);
    const moved = await waitFor(
      async () => {
        const next = (await serverDoc()).pages[5].nodes.find((n) => n.id === quote.id);
        return next.x === quote.x + 10 ? next : null;
      },
      5000,
      "nudged quote on the server",
    );
    await page.keyboard.press("Escape");
    return { from: quote.x, to: moved.x };
  });

  await check("speaker notes save to the slide (AC-04)", async () => {
    await slideItems(page).nth(1).click();
    const field = page.getByTestId("speaker-notes-field");
    await field.click();
    await field.fill("Name the three harbors, then pause for questions.");
    await canvas(page).click({ position: { x: 20, y: 300 } });
    await saved(page);
    const document = await waitFor(
      async () => {
        const value = await serverDoc();
        return value.pages[1].notes ? value : null;
      },
      5000,
      "notes on the server",
    );
    assert(
      document.pages[1].notes === "Name the three harbors, then pause for questions.",
      `notes ${document.pages[1].notes}`,
    );
    return { notes: document.pages[1].notes };
  });

  await check("reorder by keyboard (Alt+Up) and by drag", async () => {
    const before = (await serverDoc()).pages.map((p) => p.id);
    await slideItems(page).nth(2).click();
    await slideItems(page).nth(2).focus();
    await page.keyboard.press("Alt+ArrowUp");
    await saved(page);
    const keyed = await waitFor(
      async () => {
        const ids = (await serverDoc()).pages.map((p) => p.id);
        return ids[1] === before[2] ? ids : null;
      },
      5000,
      "keyboard move on the server",
    );
    await slideItems(page)
      .nth(5)
      .dragTo(slideItems(page).nth(0), {
        targetPosition: { x: 40, y: 4 },
      });
    await saved(page);
    const dragged = await waitFor(
      async () => {
        const ids = (await serverDoc()).pages.map((p) => p.id);
        return ids[0] === keyed[5] ? ids : null;
      },
      5000,
      "drag move on the server",
    );
    return { before, keyed, dragged };
  });

  await check("slide menu: duplicate, skip and delete", async () => {
    await slideItems(page).nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
    await saved(page);
    await waitFor(async () => (await serverDoc()).pages.length === 7, 5000, "duplicate");
    await slideItems(page).nth(2).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Delete/ }).click();
    await saved(page);
    await waitFor(async () => (await serverDoc()).pages.length === 6, 5000, "delete");
    // Skip the image slide, wherever the moves left it.
    const document = await serverDoc();
    const imageIndex = document.pages.findIndex((p) => p.nodes.some((n) => n.name === "Caption"));
    await slideItems(page).nth(imageIndex).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Skip slide" }).click();
    await saved(page);
    const skipped = await waitFor(
      async () => {
        const value = await serverDoc();
        return value.pages[imageIndex].skipped === true ? value : null;
      },
      5000,
      "skip on the server",
    );
    assert(
      (await slideItems(page).nth(imageIndex).getAttribute("data-skipped")) === "true",
      "the rail does not mark the skipped slide",
    );
    await slideItems(page).nth(0).click();
    await page.waitForTimeout(300);
    await shot(page, "04-rail-light");
    return { pages: skipped.pages.length, skipped: imageIndex + 1 };
  });

  await check("present mode keys, skipped slide left out", async () => {
    await slideItems(page).nth(0).click();
    await page.getByRole("button", { name: "Present", exact: true }).click();
    const present = page.getByTestId("present-mode");
    await present.waitFor();
    const position = () => page.getByTestId("present-position").textContent();
    assert((await position()) === "1 / 5", `start ${await position()}`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press(" ");
    await page.keyboard.press("PageDown");
    assert((await position()) === "4 / 5", `after three steps ${await position()}`);
    await page.keyboard.press("PageUp");
    await page.keyboard.press("ArrowLeft");
    assert((await position()) === "2 / 5", `after two back ${await position()}`);
    await page.keyboard.press("End");
    assert((await position()) === "5 / 5", `End ${await position()}`);
    await page.keyboard.press("Home");
    await page.keyboard.press("3");
    assert((await position()) === "3 / 5", `3 ${await position()}`);
    await page.keyboard.press("1");
    await page.waitForTimeout(400);
    await shot(page, "05-present-light");
    await page.keyboard.press("Escape");
    await present.waitFor({ state: "detached", timeout: 3000 });
  });

  await check("presenter view: current, next, notes and timer", async () => {
    // Open on the slide with notes.
    const document = await serverDoc();
    const notesIndex = document.pages.findIndex((p) => p.notes);
    await slideItems(page).nth(notesIndex).click();
    await page.getByRole("button", { name: "Presenter view", exact: true }).click();
    const view = page.getByTestId("presenter-view");
    await view.waitFor();
    await page.getByTestId("presenter-current").locator("[data-node]").first().waitFor();
    await page.getByTestId("presenter-next").locator("[data-node]").first().waitFor();
    const notes = await page.getByTestId("presenter-notes").textContent();
    assert(notes.includes("three harbors"), `notes ${notes}`);
    const first = await page.getByTestId("presenter-timer").textContent();
    await page.waitForTimeout(2200);
    const later = await page.getByTestId("presenter-timer").textContent();
    assert(first !== later, `timer did not run: ${first} -> ${later}`);
    await shot(page, "06-presenter-light");
    await page.keyboard.press("p");
    await view.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    return { notes, timer: [first, later] };
  });

  await check("export PDF of all slides", async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.getByRole("menuitem", { name: "PDF of all slides" }).click(),
    ]);
    const file = NodePath.join(downloads, "harbor-launch.pdf");
    await download.saveAs(file);
    const bytes = NodeFS.readFileSync(file);
    assert(bytes.subarray(0, 5).toString() === "%PDF-", "not a PDF");
    const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    return { bytes: bytes.length, pages };
  });

  await check("export PowerPoint of all slides", async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120000 }),
      page.getByRole("menuitem", { name: "PowerPoint of all slides" }).click(),
    ]);
    const file = NodePath.join(downloads, "harbor-launch.pptx");
    await download.saveAs(file);
    const bytes = NodeFS.readFileSync(file);
    assert(bytes.subarray(0, 2).toString() === "PK", "not a zip");
    const names = new Set(bytes.toString("latin1").match(/ppt\/slides\/slide\d+\.xml/g) ?? []);
    const document = await serverDoc();
    const shown = document.pages.filter((p) => !p.skipped).length;
    assert(names.size === shown, `pptx has ${names.size} slides, deck shows ${shown}`);
    return { bytes: bytes.length, slides: names.size, fileName: download.suggestedFilename() };
  });

  await check("light: no console errors", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await context.close();

  const dark = await signedInContext("dark");
  const darkPage = await dark.newPage();
  watchErrors(darkPage, "dark");
  failureShot = (name) => shot(darkPage, `fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);
  await check("dark: rail, layouts and presenter view in the system's dark mode", async () => {
    await darkPage.goto(`${origin}/design/p.${projectId}.${designId}`);
    await darkPage.getByTestId("design-editor").waitFor({ timeout: 30000 });
    await rail(darkPage).waitFor();
    await saved(darkPage);
    await darkPage.waitForTimeout(400);
    const frame = (await serverDoc()).pages[0].nodes[0];
    const background = await canvas(darkPage)
      .locator(`[data-node="${frame.id}"]`)
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    assert(background === "rgb(13, 20, 25)", `dark slide background ${background}`);
    await shot(darkPage, "07-rail-dark");
    await darkPage.getByTestId("new-slide").click();
    await darkPage.locator("[data-testid=slide-layout]").first().waitFor();
    await darkPage.waitForTimeout(300);
    await shot(darkPage, "08-layout-picker-dark");
    await darkPage.keyboard.press("Escape");
    const document = await serverDoc();
    await slideItems(darkPage)
      .nth(document.pages.findIndex((p) => p.notes))
      .click();
    await darkPage.getByRole("button", { name: "Presenter view", exact: true }).click();
    await darkPage.getByTestId("presenter-view").waitFor();
    await darkPage.waitForTimeout(400);
    await shot(darkPage, "09-presenter-dark");
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

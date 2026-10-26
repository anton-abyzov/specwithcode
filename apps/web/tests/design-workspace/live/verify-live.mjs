#!/usr/bin/env node
/**
 * Real-server check of the Design gallery, the Library Designs group, Design
 * from code and copy/delete. Runs this checkout's built server (apps/server/dist)
 * against a private, throwaway home with every built-in provider off and one
 * model-free ACP agent (design-agent.mjs) that edits the design through MCP.
 * Build first: web `vp build`, server `node scripts/cli.ts build`.
 * Usage: node apps/web/tests/design-workspace/live/verify-live.mjs <evidence-dir>
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const { spawn } = NodeChildProcess;
const { execFileSync } = NodeChildProcess;
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = NodeFS;
const { createRequire } = NodeModule;
const { createServer } = NodeNet;
const { homedir } = NodeOS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath } = NodeURL;

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const out = resolve(process.argv[2] ?? join(here, "evidence"));
mkdirSync(out, { recursive: true });
const entry = join(root, "apps/server/dist/bin.mjs");
assert.ok(existsSync(entry), `build the server first: ${entry}`);

const privateRoot = join(homedir(), ".local/share/specweave-studio/verification/design-gallery");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(privateRoot, "run-"));
const state = join(scratch, "state");
const agentResult = join(scratch, "agent-result.json");
mkdirSync(join(state, "userdata"), { recursive: true });
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
writeFileSync(
  join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: {
      ...Object.fromEntries(
        drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
      ),
      designAgent: {
        driver: "acpRegistry",
        displayName: "Design agent",
        enabled: true,
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [join(here, "design-agent.mjs"), agentResult],
          customModels: ["design-agent"],
        },
      },
    },
    cursorKeychainUsageEnabled: false,
  }),
);
const workspaces = {};
for (const [id, title] of [
  ["atlas", "Atlas web"],
  ["harbor", "Harbor app"],
]) {
  const dir = join(scratch, id);
  mkdirSync(dir);
  writeFileSync(join(dir, "README.md"), `${title}: synthetic design gallery check.\n`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  workspaces[id] = { dir, title };
}

const port = await new Promise((done, reject) => {
  const socket = createServer();
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [
    entry,
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
    cwd: scratch,
    env: {
      ...process.env,
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      SPECWEAVE_STUDIO_THREAD_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "";
const credential = new Promise((done, reject) => {
  const timer = setTimeout(() => reject(new Error("server startup timed out")), 90_000);
  const observe = (chunk) => {
    output += chunk.toString();
    const match = output.match(/(?:^|\n)Token: (\S+)/);
    if (match) {
      clearTimeout(timer);
      done(match[1]);
    }
  };
  child.stdout.on("data", observe);
  child.stderr.on("data", observe);
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(
      new Error(
        `server exited ${code}: ${output.replace(/Token: \S+/g, "Token: <omitted>").slice(-2000)}`,
      ),
    );
  });
});

const commit = execFileSync("git", ["rev-parse", "--short=10", "HEAD"], { cwd: root })
  .toString()
  .trim();
const receipt = {
  commit,
  server: entry,
  headless: true,
  checks: [],
  screenshots: [],
  pageErrors: [],
};
const { chromium } = createRequire(join(root, "apps/server/package.json"))("playwright-core");
let browser;
let context;
let failed = null;
const check = async (name, run) => {
  const started = Date.now();
  try {
    const detail = await run();
    receipt.checks.push({
      name,
      ok: true,
      ms: Date.now() - started,
      ...(detail ? { detail } : {}),
    });
    console.log(`ok   ${name}`);
  } catch (error) {
    receipt.checks.push({ name, ok: false, error: String(error?.stack ?? error).slice(0, 2000) });
    for (const page of context.pages()) {
      const slug = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      await page.screenshot({ path: join(out, `fail-${slug}.png`) }).catch(() => {});
      console.log(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 1200),
      );
      await page.close().catch(() => {});
    }
    console.log(`FAIL ${name}\n${error?.stack ?? error}`);
    failed ??= error;
  }
};
const until = async (label, probe, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  const token = await credential;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: "reduce",
  });
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential: token },
    headers: { Origin: origin },
  });
  assert.equal(auth.status(), 200);
  let rpcId = 0;
  const rpc = async (tag, payload) => {
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
    const id = String(++rpcId);
    return new Promise((done, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => (ws.close(), reject(new Error(`RPC timeout ${tag}`))), 20_000);
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        for (const item of [JSON.parse(event.data)].flat())
          if (item._tag === "Exit" && String(item.requestId) === id) {
            clearTimeout(timer);
            ws.close();
            if (item.exit?._tag === "Success") done(item.exit.value);
            else reject(new Error(`RPC ${tag}: ${JSON.stringify(item.exit).slice(0, 800)}`));
          }
      });
    });
  };
  const config = await rpc("server.getConfig", {});
  receipt.version = config.version ?? config.serverVersion ?? null;
  for (const [projectId, { dir, title }] of Object.entries(workspaces))
    await rpc("projects.mutate", {
      type: "project.create",
      commandId: `create-${projectId}`,
      projectId,
      title,
      workspaceRoot: dir,
    });
  const atlas = { kind: "project", projectId: "atlas" };
  const listAll = async () => (await rpc("design.list", { filter: { kind: "all" } })).designs;

  const seed = async (owner, title, color) => {
    const created = await rpc("design.create", { owner, kind: "design", title });
    const designId = created.ref?.designId ?? created.designId;
    const { document } = await rpc("design.get", { owner, designId });
    const page = document.pages[0];
    const frame = page.nodes.find((node) => node.type === "frame");
    await rpc("design.apply", {
      owner,
      designId,
      expectedRevision: document.revision,
      operations: [
        {
          op: "add_node",
          pageId: page.id,
          node: {
            id: "seed_title",
            parentId: frame?.id ?? null,
            type: "text",
            x: 64,
            y: 64,
            width: 640,
            height: 56,
            text: title,
            fontSize: 44,
            fontWeight: 700,
            color,
          },
        },
      ],
    });
    return designId;
  };
  let pricingId;
  let sketchId;
  await check("seed one design per owner through the server", async () => {
    pricingId = await seed(atlas, "Pricing page", "#1f6feb");
    sketchId = await seed({ kind: "playground" }, "Loose sketch", "#8250df");
    const all = await listAll();
    assert.deepEqual(all.map((d) => d.title).toSorted(), ["Loose sketch", "Pricing page"]);
    return { pricingId, sketchId };
  });

  const errors = receipt.pageErrors;
  const newPage = async (theme) => {
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((theme) => {
      // Init scripts run in every frame; sandboxed thumbnails have no storage.
      if (window !== window.top) return;
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z", theme }),
      );
      localStorage.setItem("studio:project-pane-tab:v1", JSON.stringify("library"));
    }, theme);
    return page;
  };
  const shot = async (page, name) => {
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file });
    receipt.screenshots.push(file);
  };
  const cards = (page) => page.getByTestId("design-card");

  for (const theme of ["light", "dark"]) {
    await check(`${theme}: gallery lists both owners with live thumbnails`, async () => {
      const page = await newPage(theme);
      await page.goto(`${origin}/design`);
      await page.getByTestId("design-gallery").waitFor();
      await until("two cards", async () => (await cards(page).count()) === 2);
      // 1046 (#667): All defaults to "Group by project": one section per owner, headed by the
      // owner's name, and the cards in a section drop the owner badge.
      const sections = page.getByTestId("design-section");
      const sectionOwners = await sections.evaluateAll((nodes) =>
        nodes.map((n) => n.dataset.owner),
      );
      assert.deepEqual(sectionOwners.toSorted(), ["atlas", "playground"]);
      const headings = (await sections.locator("h2").allTextContents()).map((t) => t.trim());
      assert.deepEqual(headings.toSorted(), ["Atlas web", "Playground"]);
      assert.equal(
        await page.getByTestId("design-owner").count(),
        0,
        "owner badges inside sections",
      );
      // "Recent first" lists every card with its owner badge, the pre-1046 contract.
      await page.getByTestId("design-grouping").click();
      await page.getByRole("menuitemradio", { name: "Recent first" }).click();
      // The Arrange menu is a radio group and stays open after a pick (Base UI default).
      await page.keyboard.press("Escape");
      await page.getByRole("menuitemradio").first().waitFor({ state: "hidden" });
      await until(
        "owner badges",
        async () => (await page.getByTestId("design-owner").count()) === 2,
      );
      // The badge leads with the project's sidebar icon (initials "AW"); compare its label span.
      const owners = await page
        .getByTestId("design-owner")
        .locator("span.truncate")
        .allTextContents();
      assert.deepEqual(owners.map((t) => t.trim()).toSorted(), ["Atlas web", "Playground"]);
      await shot(page, `gallery-recent-${theme}`);
      await page.getByTestId("design-grouping").click();
      await page.getByRole("menuitemradio", { name: "Group by project" }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("menuitemradio").first().waitFor({ state: "hidden" });
      await until("sections back", async () => (await sections.count()) === 2);
      const edited = await page.getByTestId("design-edited").allTextContents();
      assert.ok(
        edited.every((text) => /Edited/i.test(text)),
        `edited labels: ${edited}`,
      );
      const frames = page.locator("[data-testid=design-card] iframe");
      assert.equal(await frames.count(), 2);
      const sandbox = await frames.first().getAttribute("sandbox");
      assert.ok(sandbox !== null && !sandbox.includes("allow-same-origin"), `sandbox: ${sandbox}`);
      await page.waitForTimeout(600);
      await shot(page, `gallery-${theme}`);
      // 1046: the All / Playground / Projects tabs became scope chips (All, Playground, then
      // one chip per project with designs).
      const chip = (scope) => page.locator(`[data-testid=design-scope][data-scope="${scope}"]`);
      await chip("playground").click();
      await until("playground only", async () => (await cards(page).count()) === 1);
      assert.match(await cards(page).first().innerText(), /Loose sketch/);
      await chip("atlas").click();
      await until("atlas only", async () => (await cards(page).count()) === 1);
      assert.match(await cards(page).first().innerText(), /Pricing page/);
      await chip("all").click();
      await page.getByLabel("Search designs").fill("sketch");
      await until("search", async () => (await cards(page).count()) === 1);
      await page.getByLabel("Search designs").fill("");
      await page.getByLabel("List view").click();
      await page.getByTestId("design-list").first().waitFor();
      await until("two rows", async () => (await page.getByTestId("design-row").count()) === 2);
      await shot(page, `gallery-list-${theme}`);
      await page.getByLabel("Grid view").click();
      await page.close();
    });
  }

  await check("library pane shows the project's Designs group", async () => {
    const page = await newPage("light");
    await page.goto(`${origin}/`);
    await page.getByText("Atlas web", { exact: true }).first().click();
    const labels = page.locator(".sws-library-row .sws-library-label");
    await until("designs group", async () => (await labels.allTextContents()).includes("Designs"));
    const texts = await labels.allTextContents();
    assert.ok(texts.includes("Pricing page"), `library rows: ${texts.slice(0, 8)}`);
    assert.ok(
      !texts.includes("Loose sketch"),
      "playground design must not show in a project library",
    );
    await page.getByRole("button", { name: "Actions for Pricing page" }).click();
    await page.getByRole("menuitem", { name: "Open" }).first().waitFor();
    const items = (await page.getByRole("menuitem").allTextContents()).map((t) => t.trim());
    assert.ok(items.includes("Open") && items.includes("Copy to Playground"), `menu: ${items}`);
    await shot(page, "library-designs-menu");
    await page.keyboard.press("Escape");
    await page.locator(".sws-library-name button", { hasText: "Pricing page" }).click();
    await page.waitForURL(`**/design/p.atlas.${pricingId}`);
    await page.close();
    return { rows: texts.slice(0, 6) };
  });

  await check("copy to project and to Playground from the card menu", async () => {
    const page = await newPage("light");
    await page.goto(`${origin}/design`);
    await until("cards", async () => (await cards(page).count()) === 2);
    const menu = () => page.getByRole("button", { name: "Actions for Pricing page" }).first();
    await menu().click();
    await page.getByRole("menuitem", { name: "Copy to project…" }).click();
    await page.getByRole("menuitem", { name: "Harbor app" }).click();
    await until("harbor copy", async () =>
      (await listAll()).some(
        (d) => d.ref.owner.kind === "project" && d.ref.owner.projectId === "harbor",
      ),
    );
    await menu().click();
    await page.getByRole("menuitem", { name: "Copy to Playground" }).click();
    await until(
      "playground copy",
      async () => (await listAll()).filter((d) => d.ref.owner.kind === "playground").length === 2,
    );
    await until("four cards", async () => (await cards(page).count()) === 4);
    await shot(page, "after-copies");
    const all = await listAll();
    const copies = all.filter(
      (d) => d.title.startsWith("Pricing page") && d.ref.designId !== pricingId,
    );
    assert.equal(copies.length, 2);
    await page.close();
    return {
      copies: copies.map((d) => ({ owner: d.ownerLabel, id: d.ref.designId, title: d.title })),
    };
  });

  await check("delete asks for confirmation and removes the design", async () => {
    const page = await newPage("light");
    await page.goto(`${origin}/design`);
    await page.locator('[data-testid=design-scope][data-scope="playground"]').click();
    await until("playground cards", async () => (await cards(page).count()) === 2);
    await page.getByRole("button", { name: "Actions for Loose sketch" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByTestId("design-delete-confirm").waitFor();
    await shot(page, "delete-confirm");
    await page.getByTestId("design-delete-confirm").click();
    await until("deleted", async () => !(await listAll()).some((d) => d.ref.designId === sketchId));
    await until("one playground card", async () => (await cards(page).count()) === 1);
    await page.close();
  });

  await check("design from code: create, bind, start thread, agent edits", async () => {
    const before = await listAll();
    const page = await newPage("light");
    // The race behind the canvas lane's flake: the page renders projects and providers from the
    // cached shell before its socket connects, so Start design can run with no session. Hold the
    // socket back for a few seconds so that window is always open; the dialog must wait, not fail.
    const connectDelayMs = Number(process.env.DESIGN_CONNECT_DELAY_MS ?? 4000);
    let socketsRefused = 0;
    let openAt = Infinity;
    await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
      if (Date.now() < openAt) {
        socketsRefused += 1;
        socket.close({ code: 4000, reason: "held by the check" });
      } else socket.connectToServer();
    });
    openAt = Date.now() + connectDelayMs;
    await page.goto(`${origin}/design`);
    await page.getByTestId("design-gallery").waitFor();
    await page.locator('[data-testid=design-create][data-kind="design-from-code"]').click();
    await page.getByTestId("design-from-code-dialog").waitFor();
    await page.getByTestId("design-from-code-project").click();
    await page.getByRole("option", { name: "Atlas web" }).click();
    const worker = await until("worker label", async () => {
      const text = await page.getByTestId("design-from-code-worker").innerText();
      return /Starts a thread in Atlas web on .*Design agent/i.test(text) ? text : null;
    });
    await page
      .getByLabel("What should this design show?")
      .fill("A pricing comparison for the Atlas plans.");
    await shot(page, "design-from-code-dialog");
    const connecting = await page.getByTestId("design-from-code-connecting").isVisible();
    // Playwright's click waits for the button to turn on, as a user's second click would.
    await page.getByTestId("design-from-code-start").click({ timeout: connectDelayMs + 20_000 });
    const created = await until("one new design", async () => {
      const alert = page.getByTestId("design-from-code-dialog").getByRole("alert");
      if (await alert.isVisible().catch(() => false))
        throw new Error(`Design from code refused: ${await alert.innerText()}`);
      const after = await listAll();
      const fresh = after.filter((d) => !before.some((b) => b.ref.designId === d.ref.designId));
      return fresh.length === 1 ? fresh[0] : null;
    });
    assert.deepEqual(created.ref.owner.kind, "project");
    assert.equal(created.ref.owner.projectId, "atlas");
    await page.waitForURL(`**/design/p.atlas.${created.ref.designId}`, { timeout: 30_000 });
    const bound = await until("thread binding", async () => {
      const { document } = await rpc("design.get", {
        owner: atlas,
        designId: created.ref.designId,
      });
      return document.thread ?? null;
    });
    const thread = await rpc("orchestration.getThreadProjection", { threadId: bound.threadId });
    const projected = thread.thread ?? thread;
    assert.equal(projected.projectId, "atlas");
    const agent = await until(
      "agent result",
      async () => (existsSync(agentResult) ? JSON.parse(readFileSync(agentResult, "utf8")) : null),
      60_000,
    );
    assert.equal(agent.error ?? null, null, `agent error: ${agent.error}`);
    assert.equal(agent.designId, created.ref.designId);
    assert.ok(
      agent.calls.some((c) => c.name === "design_get" && !c.isError),
      "design_get",
    );
    assert.ok(
      agent.calls.some((c) => c.name === "design_apply" && !c.isError),
      "design_apply",
    );
    assert.match(agent.prompt, new RegExp(`id ${created.ref.designId}, file `));
    const final = await rpc("design.get", { owner: atlas, designId: created.ref.designId });
    assert.ok(final.document.revision > created.revision, "revision advanced");
    assert.equal(agent.revision, final.document.revision);
    assert.ok(
      JSON.stringify(final.document).includes("agent_heading"),
      "agent's node is in the document",
    );
    await page.waitForTimeout(1500);
    await shot(page, "design-from-code-editor");
    await page.close();
    return {
      designId: created.ref.designId,
      threadId: bound.threadId,
      threadTitle: projected.title ?? null,
      model: projected.modelSelection ?? null,
      revision: { created: created.revision, final: final.document.revision },
      agentCalls: agent.calls.map((c) => `${c.name}:${c.isError ? "error" : "ok"}`),
      worker,
      slowConnect: { delayMs: connectDelayMs, socketsRefused, dialogShowedConnecting: connecting },
    };
  });

  await check("no page errors", async () => {
    assert.deepEqual(errors, [], errors.join("\n"));
  });
} catch (error) {
  failed ??= error;
  receipt.fatal = String(error?.stack ?? error).slice(0, 2000);
  console.log(`FATAL ${error?.stack ?? error}`);
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise((done) => (child.exitCode !== null ? done() : child.once("exit", done)));
  receipt.serverLogTail = output.replace(/Token: \S+/g, "Token: <omitted>").slice(-3000);
  receipt.passed = failed === null;
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  if (process.env.KEEP_SCRATCH !== "1") rmSync(scratch, { recursive: true, force: true });
  else console.log(`scratch kept at ${scratch}`);
  console.log(
    `${receipt.checks.filter((c) => c.ok).length}/${receipt.checks.length} checks; receipt ${join(out, "receipt.json")}`,
  );
}
process.exit(failed === null ? 0 : 1);

#!/usr/bin/env node
// Headless end-to-end check of the design editor against a real, isolated server: built
// apps/server/dist and apps/web/dist, a private base dir, every model provider off and one
// model-free ACP agent that edits through design_apply. Writes screenshots, downloads and
// report.json to the report folder.
//
// --no-agent leaves the design agent out, so no provider is ready, and skips the agent check.
// It adds the no-provider checks instead: "Implement this frame" (B-06) and Design from code
// from "Make something new" and from the project board (C-02) must each create one thread
// holding its handoff or brief in the composer, dispatch no message and run no turn, and the
// text must still be there after a reload.
//
// With STUDIO_LIVE_SERVER set (see kit.mjs) it runs against that server and never stops it;
// that mode needs --no-agent. It shares design-agent.mjs with verify-live.mjs.
// Build first: web `vp build`, server `node apps/server/scripts/cli.ts build`.
// Usage: node apps/web/tests/design-workspace/live/verify-canvas.mjs [--no-agent] /absolute/report-dir
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  assert,
  attachedServer,
  checker,
  composerText,
  entrypointSha256,
  exportFromMenu,
  gitHead,
  initRepository,
  launchBrowser,
  repoRoot,
  requireBuild,
  saved as savedState,
  startServer,
  threadActivity,
  waitFor,
  warmExportBrowser,
  watchCommands,
  watchErrors,
} from "./kit.mjs";

if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("Use Node 22");
const args = process.argv.slice(2);
const noAgent = args.includes("--no-agent");
const out = NodePath.resolve(
  args.find((arg) => !arg.startsWith("--")) ?? "/tmp/design-canvas-real",
);
const shots = NodePath.join(out, "screenshots");
const downloads = NodePath.join(out, "downloads");
for (const dir of [out, shots, downloads]) NodeFS.mkdirSync(dir, { recursive: true });
requireBuild();

const attached = attachedServer();
if (attached !== null && !noAgent)
  throw new Error("An attached server has no design agent; pass --no-agent.");
const scratch = NodeFS.mkdtempSync(
  NodePath.join(attached?.scratchRoot ?? NodeOS.tmpdir(), "design-canvas-real-"),
);
const workspace = NodePath.join(scratch, "marina");
const agentResult = NodePath.join(scratch, "agent-result.json");
const results = [];
const errors = [];
const report = {
  source: gitHead(),
  evidenceKind: "real-isolated-server-headless-chromium",
  mode: noAgent ? "no-agent" : "agent",
  attached: attached !== null,
  builtEntrypointSha256: entrypointSha256(),
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  modelTurns: 0,
  results,
  errors,
};
let failureShot = null;
const check = checker(results, { onFailure: (name) => failureShot?.(name) });

initRepository(workspace, { "README.md": "Synthetic design canvas check.\n" });

// Launch the browser first, so a missing browser never leaves a server running.
const browser = await launchBrowser();
const server =
  attached ??
  (await startServer({
    home: NodePath.join(scratch, "data"),
    cwd: scratch,
    logFile: NodePath.join(out, "server.log"),
    label: "Design canvas real-server check",
    extraInstances: noAgent
      ? {}
      : {
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
  }));
const { origin, request, rpc } = server;
report.serverPid = server.pid;

try {
  // ---- seed: a project and one design with a frame, text, a card and an html node ------------
  const projectId = crypto.randomUUID();
  await request("/api/projects/mutate", {
    type: "project.create",
    commandId: crypto.randomUUID(),
    projectId,
    title: "Marina",
    workspaceRoot: workspace,
    // A scratch folder reads as a check's own project, which takes no new designs; the private
    // server's projects are the person's own.
    origin: "user",
    ...(noAgent
      ? {}
      : { defaultModelSelection: { instanceId: "designAgent", model: "design-agent" } }),
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

  // ---- browser -------------------------------------------------------------------------------
  const commandsByPage = new Map();
  async function openPage(context, label, url) {
    const page = await context.newPage();
    watchErrors(page, label, errors);
    commandsByPage.set(page, watchCommands(page));
    await page.goto(url);
    return page;
  }
  async function openEditor(context, label) {
    const page = await openPage(context, label, `${origin}/design/${designKey}`);
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
  const saved = (page) => savedState(page, 6000);
  const box = async (page, id) => {
    const value = await page.locator(`[data-node="${id}"]`).first().boundingBox();
    assert(value !== null, `${id} has no box`);
    return value;
  };
  const focusCanvas = (page) => page.getByTestId("design-canvas").focus();
  const shot = (page, name) => page.screenshot({ path: NodePath.join(shots, `${name}.png`) });

  // The handoff renders the frame; a fresh home installs its export browser on first use.
  if (noAgent)
    await check("the server's export browser renders a frame", () =>
      warmExportBrowser(server, { owner, designId, pageId, frameId }),
    );

  const context = await server.signedInContext(browser, { colorScheme: "light" });
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

  if (!noAgent)
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

  /**
   * The no-provider hold (B-06, C-02): exactly one thread.create and no message.dispatch from
   * the page, a thread with no messages, runs or provider turns, and `text` in its composer,
   * also after a reload of the thread.
   */
  async function heldThread(commands, before) {
    const created = await waitFor(
      () => (commands.threadCreate.length > before.create ? commands.threadCreate.at(-1) : null),
      60000,
      "thread.create",
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const creates = commands.threadCreate.length - before.create;
    const dispatches = commands.messageDispatch.length - before.dispatch;
    assert(creates === 1, `${creates} thread.create commands`);
    assert(dispatches === 0, `${dispatches} message.dispatch commands: a turn was asked for`);
    const threadId = created.threadId;
    assert(threadId, "thread.create named no thread");
    const activity = await threadActivity(server, threadId);
    assert(
      activity.messages === 0 && activity.runs === 0 && activity.providerTurns === 0,
      `the thread ran: ${JSON.stringify(activity)}`,
    );
    return { threadId, creates, dispatches, activity };
  }
  async function composerAfterReload(target, mustContain, label) {
    const read = () =>
      waitFor(
        async () => {
          const text = await composerText(target);
          return mustContain.every((part) => text.includes(part)) ? text : null;
        },
        20000,
        `${label} text in the composer`,
      );
    const first = await read();
    await target.reload();
    const again = await read();
    return { chars: first.length, afterReload: again.length };
  }

  if (noAgent)
    await check(
      "implement this frame without a provider: one thread holds the handoff, no turn runs",
      async () => {
        const commands = commandsByPage.get(page);
        const before = {
          create: commands.threadCreate.length,
          dispatch: commands.messageDispatch.length,
        };
        await focusCanvas(page);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Implement this frame" }).click();
        const dialog = page.getByTestId("implement-frame-dialog");
        await dialog.waitFor();
        const description = await dialog.getByTestId("implement-frame-description").textContent();
        assert(/No provider is ready/.test(description), `dialog says: ${description}`);
        await dialog.getByRole("radio", { name: /New coding thread/ }).click();
        await shot(page, "08-implement-no-provider");
        await dialog.getByRole("button", { name: "Create thread" }).click();
        const held = await heldThread(commands, before);
        await dialog.waitFor({ state: "detached", timeout: 30000 });
        await page
          .getByText(/Created a coding thread for Booking/)
          .first()
          .waitFor({ timeout: 10000 });
        const toast = page.getByText(/no turn has started/).first();
        await toast.waitFor({ timeout: 5000 });
        const toastText = (await toast.textContent()).trim();
        await shot(page, "08b-implement-toast");
        await page.getByRole("button", { name: "Open thread" }).first().click();
        await page.waitForURL(new RegExp(`/${held.threadId}`), { timeout: 15000 });
        const threadUrl = page.url();
        const composer = await composerAfterReload(page, ["Booking", "n_title"], "the handoff");
        await shot(page, "08c-implement-thread-after-reload");
        assert(
          (await threadActivity(server, held.threadId)).messages === 0,
          "the reload sent the handoff",
        );
        assert((await serverDoc()).thread === undefined, "Implement bound the design's thread");
        await page.goto(`${origin}/design/${designKey}`);
        await page.locator(`[data-node="${frameId}"]`).waitFor({ timeout: 30000 });
        await saved(page);
        return { ...held, composer, thread: threadUrl, toast: toastText.slice(0, 300) };
      },
    );

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

  await check("reply to the comment and resolve the thread", async () => {
    const before = (await serverDoc()).comments;
    const root = before.find(
      (comment) => comment.text === "Show tide times under the map." && !comment.parentId,
    );
    assert(root, "no comment to reply to");
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const panel = page.getByTestId("comments-panel");
    const thread = panel.locator(`[data-comment="${root.id}"]`);
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await thread.getByRole("textbox", { name: "Reply" }).fill("Tide times go in the footer.");
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await saved(page);
    const reply = await waitFor(
      async () => {
        const list = (await serverDoc()).comments;
        return list.length === before.length + 1 && list.at(-1).parentId === root.id
          ? list.at(-1)
          : null;
      },
      5000,
      "reply on the server",
    );
    assert(
      reply.nodeId === root.nodeId && reply.x === root.x && reply.y === root.y,
      `reply anchor ${JSON.stringify([reply.nodeId, reply.x, reply.y])}`,
    );
    assert(reply.author?.kind === "user" && !Number.isNaN(Date.parse(reply.createdAt)), "author");
    const pins = await page.locator(`[data-comment-pin="${root.id}"]`).count();
    const replyPins = await page.locator(`[data-comment-pin="${reply.id}"]`).count();
    assert(pins === 1 && replyPins === 0, `pins ${pins}/${replyPins}`);
    const replies = thread.locator('ol[aria-label="Replies"]');
    assert(
      (await replies.textContent()).includes("Tide times go in the footer."),
      "reply not listed under its thread",
    );
    await shot(page, "04b-comment-thread");

    await thread.getByRole("button", { name: "Resolve", exact: true }).click();
    await saved(page);
    await waitFor(
      async () => {
        const list = (await serverDoc()).comments;
        return [root.id, reply.id].every((id) => list.find((c) => c.id === id)?.resolved === true);
      },
      5000,
      "thread resolved on the server",
    );
    await panel.getByText("Show resolved (1)").waitFor({ timeout: 5000 });
    await thread.waitFor({ state: "detached", timeout: 5000 });
    await panel.getByRole("switch", { name: "Show resolved comments" }).click();
    await replies.getByText("Tide times go in the footer.").waitFor({ timeout: 5000 });
    await page.waitForTimeout(300);
    await shot(page, "04c-thread-resolved");
    await page
      .getByRole("button", { name: "Close comments" })
      .click()
      .catch(() => undefined);
    return { root: root.id, reply: reply.id, author: reply.author, pins };
  });

  await check("export PNG, SVG, HTML and PDF from the server", async () => {
    const files = {};
    for (const [item, ext] of [
      [/^PNG of Booking/, "png"],
      ["SVG", "svg"],
      ["Standalone HTML", "html"],
      ["PDF of all frames", "pdf"],
    ]) {
      const file = NodePath.join(downloads, `booking.${ext}`);
      await exportFromMenu(page, item, file, 120000);
      const bytes = NodeFS.readFileSync(file);
      files[ext] = { file, bytes: bytes.length };
      if (ext === "png") assert(bytes.subarray(1, 4).toString() === "PNG", "not a PNG");
      if (ext === "svg") {
        const text = bytes.toString();
        assert(text.includes("<svg") && text.includes("Reserve a slip"), "SVG lacks the headline");
        assert(!text.includes("<foreignObject"), "the SVG embeds HTML instead of drawing text");
      }
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

  /** Design from code with no provider: Create design, a waiting thread, the brief kept. */
  async function designFromCode(url, label, brief, { pickProject }) {
    const before = (await rpc("design.list", { filter: { kind: "all" } })).designs.map(
      (d) => d.ref.designId,
    );
    const gallery = await openPage(context, label, url);
    const commands = commandsByPage.get(gallery);
    try {
      await gallery.getByTestId("design-gallery").waitFor({ timeout: 30000 });
      await gallery.locator('[data-testid=design-create][data-kind="design-from-code"]').click();
      const dialog = gallery.getByTestId("design-from-code-dialog");
      await dialog.waitFor();
      if (pickProject) {
        await dialog.getByTestId("design-from-code-project").click();
        await gallery.getByRole("option", { name: "Marina" }).click();
      }
      const project = (await dialog.getByTestId("design-from-code-project").textContent()).trim();
      assert(project.includes("Marina"), `project ${project}`);
      await dialog.getByLabel("What should this design show?").fill(brief);
      const start = dialog.getByTestId("design-from-code-start");
      await waitFor(async () => !(await start.isDisabled()), 20000, "Create design enabled");
      const label_ = (await start.textContent()).trim();
      assert(label_ === "Create design", `the button reads ${label_}`);
      const footer = (await dialog.textContent()) ?? "";
      await shot(gallery, `09-${label}-dialog`);
      const counts = {
        create: commands.threadCreate.length,
        dispatch: commands.messageDispatch.length,
      };
      await start.click();
      const fresh = await waitFor(
        async () => {
          const alert = dialog.getByRole("alert");
          if (await alert.isVisible().catch(() => false))
            throw new Error(`Design from code refused: ${await alert.innerText()}`);
          const list = (await rpc("design.list", { filter: { kind: "all" } })).designs;
          return list.find((d) => !before.includes(d.ref.designId)) ?? null;
        },
        60000,
        "one new design",
      );
      assert(
        fresh.ref.owner.kind === "project" && fresh.ref.owner.projectId === projectId,
        `owner ${JSON.stringify(fresh.ref.owner)}`,
      );
      await gallery.waitForURL(`**/design/p.${projectId}.${fresh.ref.designId}`, {
        timeout: 30000,
      });
      const held = await heldThread(commands, counts);
      const doc = (await rpc("design.get", { owner, designId: fresh.ref.designId })).document;
      assert(doc.thread?.threadId === held.threadId, `bound ${JSON.stringify(doc.thread)}`);
      const notice = gallery.getByTestId("bound-thread-notice");
      await notice.waitFor({ timeout: 20000 });
      const noticeText = (await notice.textContent()).trim();
      assert(/No provider is ready/.test(noticeText), `notice: ${noticeText}`);
      const pane = gallery.getByTestId("design-thread");
      const composer = await composerAfterReload(gallery, [brief], label);
      await gallery.getByTestId("bound-thread-notice").waitFor({ timeout: 20000 });
      assert((await composerText(pane)).includes(brief), "the brief left the design's composer");
      await gallery.waitForTimeout(500);
      await shot(gallery, `09-${label}-editor-after-reload`);
      return {
        designId: fresh.ref.designId,
        designKey: `p.${projectId}.${fresh.ref.designId}`,
        ...held,
        notice: noticeText,
        composer,
        footer: footer.slice(0, 400),
      };
    } catch (error) {
      await shot(gallery, `fail-${label}`).catch(() => undefined);
      throw error;
    } finally {
      await gallery.close();
    }
  }

  if (noAgent) {
    await check(
      "design from code from Make something new without a provider: thread holds the brief",
      () =>
        designFromCode(`${origin}/design`, "dfc-gallery", "A tide table page for Marina guests.", {
          pickProject: true,
        }),
    );
    await check(
      "design from code from the project board without a provider: thread holds the brief",
      () =>
        designFromCode(
          `${origin}/design?project=${encodeURIComponent(projectId)}`,
          "dfc-board",
          "A berth map with tonight's free slips.",
          { pickProject: false },
        ),
    );
  }

  await check("light: no console errors", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await context.close();

  const dark = await server.signedInContext(browser, { colorScheme: "dark" });
  const darkPage = await openEditor(dark, "dark");
  failureShot = (name) => shot(darkPage, `fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`);
  await check(
    noAgent
      ? "dark theme renders the same design and present mode"
      : "dark theme renders the same design, agent edit and present mode",
    async () => {
      await saved(darkPage);
      if (!noAgent) await darkPage.locator('[data-node="agent_panel"]').waitFor();
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
    },
  );
  await check("dark: no console errors", async () => {
    assert(errors.length === 0, errors.join("\n"));
  });
  await dark.close();
  report.commands = [...commandsByPage.values()].reduce(
    (sum, seen) => ({
      threadCreate: sum.threadCreate + seen.threadCreate.length,
      messageDispatch: sum.messageDispatch + seen.messageDispatch.length,
    }),
    { threadCreate: 0, messageDispatch: 0 },
  );
} catch (error) {
  results.push({ name: "fatal", ok: false, error: String(error?.stack ?? error).slice(0, 4000) });
  console.log(`FATAL ${error?.stack ?? error}`);
} finally {
  await browser.close().catch(() => undefined);
  report.server = await server.stop();
  const passed = results.filter((r) => r.ok).length;
  report.summary = `${passed}/${results.length} checks passed`;
  NodeFS.writeFileSync(NodePath.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(report.summary);
  // An attached server still lists the scratch project; its owner removes the folder.
  if (attached === null) NodeFS.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = passed === results.length ? 0 : 1;
}

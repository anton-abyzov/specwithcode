// Headless interaction check of coordinator follow (0960) and project return (0946)
// on the INSTALLED SpecWithCode build. Runs the app's own bundled server
// (ELECTRON_RUN_AS_NODE) on a private base dir and port. Every provider is disabled
// except claudeAgent, whose binary is fake-claude.mjs: a scripted stand-in with no
// model and no network, so coordinator replies (including streamed ones) are real
// orchestration turns rendered by the installed client. Live app and state untouched.
// Usage: node coordinator-follow-check.mjs <report-dir>
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
  join(homedir(), ".local/share/specwithcode/verification/coordinator-follow");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const state = mkdtempSync(join(privateRoot, "state-"));
mkdirSync(join(state, "userdata"));
const claudeHome = join(state, "claude-home");
// The provider binary is fake-claude.mjs behind a shell wrapper that pins this Node.
const FAKE_CLAUDE = join(state, "claude");
writeFileSync(
  FAKE_CLAUDE,
  `#!/bin/sh\nexec "${process.execPath}" "${join(dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs")}" "$@"\n`,
);
chmodSync(FAKE_CLAUDE, 0o755);
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
      claudeAgent: { enabled: true, binaryPath: FAKE_CLAUDE, homePath: claudeHome },
    },
  }),
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
      FAKE_CLAUDE_LOG: join(out, "fake-claude.log"),
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
  failures: [],
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

  receipt.environment = config.environment ?? null;
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  receipt.console = [];
  page.on("pageerror", (e) => receipt.console.push(String(e).slice(0, 300)));
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  await page.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
    ),
  );
  // A picture that arrives after its message, the way an attachment preview loads.
  let imageCount = 0;
  await page.route("**/late-image/**", async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="#4a6"/></svg>`,
    });
  });
  await page.goto(`${origin}/`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page
    .getByText(/^Automated \(\d+\)$/)
    .first()
    .click();
  const sidebarProject = (title) => page.getByText(title, { exact: true }).first();
  await sidebarProject("Atlas Studio").click();
  const prompt = page.locator("#project-prompt:visible");
  // A loaded machine can answer "busy, your draft is kept": send again until the
  // composer empties, which is when the host has taken the message.
  const send = async (text) => {
    await prompt.click();
    await prompt.fill(text);
    for (let attempt = 0; attempt < 12; attempt++) {
      await page.keyboard.press("Enter");
      const taken = await page
        .waitForFunction(() => document.querySelector("#project-prompt")?.value === "", null, {
          timeout: 5000,
        })
        .then(
          () => true,
          () => false,
        );
      if (taken) return;
      await prompt.click();
    }
    throw new Error(`the host never took the message "${text}"`);
  };

  // History: 14 real coordinator exchanges answered by the scripted binary.
  const EXCHANGES = 14;
  for (let n = 1; n <= EXCHANGES; n++) {
    await send(`Question ${n}: what changed in step ${n}?`);
    await page.getByText(`Reply ${n} paragraph 3`).first().waitFor({ timeout: 60000 });
  }
  const conversation = page.locator('[aria-label="Coordinator conversation"]:visible');
  await conversation.waitFor();
  const latest = page.locator("[data-coordinator-latest] button:visible");
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const measure = () =>
    conversation.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [...el.querySelectorAll("[data-follow-anchor]")].find(
        (r) => r.getBoundingClientRect().bottom > top,
      );
      return {
        fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
        scrollHeight: el.scrollHeight,
        rows: el.querySelectorAll("[data-follow-anchor]").length,
        lastRow:
          [...el.querySelectorAll("[data-follow-anchor]")]
            .at(-1)
            ?.getAttribute("data-follow-anchor")
            ?.slice(-12) ?? null,
        streamed: Math.max(
          0,
          // Paragraph number reached by the newest stream on screen.
          ...[...el.innerText.matchAll(/Reply stream S(\d+) paragraph (\d+)\./g)]
            .map((m) => [Number(m[1]), Number(m[2])])
            .filter(([tag], _, all) => tag === Math.max(...all.map(([t]) => t)))
            .map(([, n]) => n),
        ),
        anchor: row?.getAttribute("data-follow-anchor") ?? null,
        anchorOffset: row ? Math.round(row.getBoundingClientRect().top - top) : null,
      };
    });
  const steps = [];
  receipt.steps = steps;
  const step = async (phase, label) => {
    await frame();
    await frame();
    const at = {
      phase,
      label,
      ...(await measure()),
      button: (await latest.count()) ? await latest.getAttribute("aria-label") : null,
      unseen: (await latest.count()) ? (await latest.getAttribute("data-unseen")) !== null : null,
    };
    steps.push(at);
    return at;
  };
  const check = (condition, message) => {
    if (!condition) receipt.failures.push(message);
  };
  const following = async (phase, label) => {
    const at = await step(phase, label);
    check(at.fromEnd <= 2, `${label}: left the end (${at.fromEnd}px from it)`);
    check(at.button === null, `${label}: offered "${at.button}" while following`);
    return at;
  };
  const reading = async (phase, label, before) => {
    const at = await step(phase, label);
    check(at.fromEnd > 40, `${label}: pulled back to the end`);
    check(at.button !== null, `${label}: no jump control while reading`);
    if (before) {
      check(
        at.anchor === before.anchor,
        `${label}: anchor changed ${before.anchor} -> ${at.anchor}`,
      );
      check(
        Math.abs(at.anchorOffset - before.anchorOffset) <= 4,
        `${label}: anchor moved ${before.anchorOffset} -> ${at.anchorOffset}`,
      );
    }
    return at;
  };
  const lastRow = () =>
    conversation.evaluate((el) =>
      [...el.querySelectorAll("[data-follow-anchor]")].at(-1)?.getAttribute("data-follow-anchor"),
    );
  const lateImage = async (rowId) => {
    imageCount += 1;
    await conversation.evaluate(
      (el, [id, src]) =>
        new Promise((resolve) => {
          const row = el.querySelector(`[data-follow-anchor="${id}"]`);
          const img = document.createElement("img");
          img.style.display = "block";
          img.style.maxWidth = "100%";
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
          img.src = src;
          row.append(img);
        }),
      [rowId, `/late-image/${imageCount}.svg`],
    );
  };
  const center = async () => {
    const box = await conversation.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  const wheel = async (deltaY, times = 1) => {
    await center();
    for (let i = 0; i < times; i++) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(300);
  };
  // Streams `count` paragraphs, one every `pace` ms, as a real coordinator turn.
  let streams = 0;
  const stream = async (count, pace) => {
    streams += 1;
    const tag = `S${streams}`;
    await send(`[[stream:${count}:${pace}]] Stream ${tag}`);
    return { last: page.getByText(`Reply stream ${tag} paragraph ${count}.`).first(), tag };
  };
  // The turn is over once the composer stops showing the coordinator at work.
  const turnEnded = async () => {
    await page.getByText("Replying…").first().waitFor({ state: "hidden", timeout: 30000 });
    await page
      .getByText("Reading the new message…")
      .first()
      .waitFor({ state: "hidden", timeout: 30000 });
    await page.waitForTimeout(500);
  };

  // --- A. At the end, everything that grows the conversation is followed. ---
  await following("A", "history loaded");
  await shot("a-history.png");
  {
    const { last } = await stream(16, 300);
    const grown = [];
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(300);
      grown.push((await following("A", `streaming sample ${i}`)).streamed);
    }
    check(
      grown.at(-1) - grown[0] >= 4,
      `streaming at the end: no paragraphs arrived during the samples (${grown[0]} -> ${grown.at(-1)})`,
    );
    await last.waitFor({ timeout: 30000 });
    await turnEnded();
    await following("A", "end of turn");
  }
  await shot("a-streamed.png");
  await lateImage(await lastRow());
  await following("A", "late image in the last reply");
  await conversation.evaluate((el) => {
    const rows = el.querySelectorAll("[data-follow-anchor]");
    const block = document.createElement("div");
    block.style.height = "260px";
    rows[rows.length - 2].append(block);
  });
  await following("A", "a row above grew");
  await conversation.evaluate((el) => {
    el.scrollTop -= 160;
  });
  await page.waitForTimeout(200);
  await following("A", "scroll the browser made on its own");
  {
    const box = await conversation.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 120);
    await page.waitForTimeout(200);
    await lateImage(await lastRow());
    await following("A", "click on a message, then growth");
  }
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.waitForTimeout(500);
  await following("A", "panel narrowed");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(500);
  await following("A", "panel widened");

  // --- B. The reader's own upward scroll pauses following and keeps the anchor. ---
  {
    const { last } = await stream(30, 300);
    await page.waitForTimeout(900);
    await wheel(-500, 3);
    const held = await reading("B", "wheel up during streaming");
    let lastWhileReading = held;
    for (let i = 1; i <= 6; i++) {
      await page.waitForTimeout(600);
      lastWhileReading = await reading("B", `streaming while reading ${i}`, held);
    }
    check(
      lastWhileReading.rows > held.rows && lastWhileReading.lastRow !== held.lastRow,
      `streaming while reading: no rows arrived (${held.rows} -> ${lastWhileReading.rows})`,
    );
    receipt.streamWhileReading = {
      at: held.lastRow,
      then: lastWhileReading.lastRow,
      heightBefore: held.scrollHeight,
      heightAfter: lastWhileReading.scrollHeight,
    };
    await last.waitFor({ timeout: 30000 });
    await turnEnded();
    const ended = await reading("B", "end of turn while reading", held);
    check(ended.unseen === true, `end of turn while reading: jump not marked New`);
    await shot("b-reading-new.png");
    await lateImage(await lastRow());
    await reading("B", "late image while reading", held);
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(500);
    const narrowed = await reading("B", "panel resized while reading");
    check(
      narrowed.anchor === held.anchor,
      `panel resized while reading: anchor changed ${held.anchor} -> ${narrowed.anchor}`,
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(500);
  }

  // --- C. Back to the end, End, or one Jump resumes following. ---
  await wheel(1500, 12);
  await following("C", "wheeled back to the end");
  await lateImage(await lastRow());
  await following("C", "growth after wheeling back");
  {
    const box = await conversation.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 120);
    await page.keyboard.press("PageUp");
    await page.waitForTimeout(500);
    const paged = await reading("C", "PageUp pauses");
    await lateImage(await lastRow());
    await reading("C", "growth after PageUp", paged);
    await page.keyboard.press("End");
    await page.waitForTimeout(600);
    await following("C", "End resumes");
    await lateImage(await lastRow());
    await following("C", "growth after End");
  }
  await wheel(-600, 3);
  await reading("C", "wheel up before jump");
  await latest.click();
  await page.waitForTimeout(800);
  await following("C", "one Jump to latest");
  {
    const { last } = await stream(8, 250);
    await page.waitForTimeout(600);
    await following("C", "streaming after jump");
    await last.waitFor({ timeout: 30000 });
    await turnEnded();
    await following("C", "end of turn after jump");
  }

  // --- D. Find scrolls for the reader: the match stays, nothing yanks it back. ---
  {
    const box = await conversation.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 120);
    await page.keyboard.press("Meta+f");
    const bar = page.locator("[data-conversation-find-bar] input:visible").first();
    await bar.waitFor({ timeout: 5000 }).catch(() => undefined);
    receipt.findBar = await bar.isVisible().catch(() => false);
    check(receipt.findBar, "find: Cmd+F did not open the find bar");
    if (receipt.findBar) {
      await bar.fill("Reply 2 paragraph 2");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(900);
      const found = await reading("D", "find scrolled to an older match");
      const matchInView = await page
        .getByText("Reply 2 paragraph 2")
        .first()
        .evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight;
        });
      check(matchInView, "find: match not in view");
      await lateImage(await lastRow());
      await reading("D", "growth while on a find match", found);
      await shot("d-find.png");
      await page.keyboard.press("Escape");
    }
  }
  await latest.click().catch(() => undefined);
  await page.waitForTimeout(800);
  await following("D", "jump after find");

  // --- E. A dragged selection that scrolls up pauses following. ---
  {
    const box = await conversation.boundingBox();
    // Press on plain reply text near the bottom (not an image, which would start a drag).
    const start = await conversation.evaluate((el) => {
      const bottom = el.getBoundingClientRect().bottom;
      const p = [...el.querySelectorAll("p")]
        .filter(
          (n) => /^Reply /.test(n.textContent) && n.getBoundingClientRect().bottom < bottom - 20,
        )
        .at(-1);
      const r = p.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + 8 };
    });
    receipt.selectionStart = start;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(start.x, start.y - i * ((start.y - box.y + 30) / 12));
      await page.waitForTimeout(60);
    }
    await page.mouse.move(start.x, box.y - 30);
    await page.waitForTimeout(1200);
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dragged = await reading("E", "selection dragged upward");
    receipt.selection = await page.evaluate(() => String(getSelection()).length);
    await lateImage(await lastRow());
    await reading("E", "growth after selection drag", dragged);
    await page.mouse.click(box.x + 4, box.y + 4).catch(() => undefined);
  }
  await latest.click().catch(() => undefined);
  await page.waitForTimeout(800);
  await following("E", "jump after selection");

  // --- F. Project return. ---
  {
    const { last } = await stream(12, 400);
    await page.waitForTimeout(500);
    await sidebarProject("Beacon").click();
    await page.waitForTimeout(6500);
    await sidebarProject("Atlas Studio").click();
    await conversation.waitFor();
    await page.waitForTimeout(800);
    const back = await following("F", "return after a reply arrived while away");
    // In the viewport, not merely in the DOM.
    receipt.returnLastVisible = await last
      .evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
      })
      .catch(() => false);
    check(receipt.returnLastVisible, "return: newest paragraph not visible");
    check(
      !(await page
        .getByText("Load earlier messages")
        .isVisible()
        .catch(() => false)),
      "return: Load earlier messages shown",
    );
    await shot("f-return-latest.png");
    void back;
  }
  await turnEnded();
  await wheel(-500, 4);
  const away = await reading("F", "reader up before leaving");
  await sidebarProject("Beacon").click();
  await page.waitForTimeout(800);
  await sidebarProject("Atlas Studio").click();
  await conversation.waitFor();
  await page.waitForTimeout(800);
  await reading("F", "return keeps the reading place", away);
  for (let i = 1; i <= 3; i++) {
    await sidebarProject("Beacon").click();
    await page.waitForTimeout(150);
    await sidebarProject("Atlas Studio").click();
    await page.waitForTimeout(150);
  }
  await conversation.waitFor();
  await page.waitForTimeout(800);
  await reading("F", "rapid A-B-A keeps the reading place", away);
  await shot("f-return-reading.png");
  await latest.click();
  await page.waitForTimeout(800);
  await following("F", "jump after return");
  await sidebarProject("Beacon").click();
  await page.waitForTimeout(800);
  await sidebarProject("Atlas Studio").click();
  await conversation.waitFor();
  await page.waitForTimeout(800);
  await following("F", "return after jump lands on the latest");
  receipt.ok = receipt.failures.length === 0 && receipt.console.length === 0;
} catch (error) {
  receipt.failures.push(`aborted: ${String(error).slice(0, 600)}`);
  receipt.ok = false;
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
} finally {
  if (page) {
    const urls = await page
      .evaluate(() =>
        performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => name.endsWith(".js")),
      )
      .catch(() => []);
    receipt.scripts = [...new Set(urls)].map((u) => new URL(u).pathname);
  }
  receipt.serverTail = scrub(output).slice(-3000);
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  if (child.exitCode === null) child.kill("SIGTERM");
  await browser?.close().catch(() => undefined);
}
process.exitCode = receipt.ok ? 0 : 1;
console.log(
  JSON.stringify(
    { ok: receipt.ok, failures: receipt.failures, steps: receipt.steps?.length },
    null,
    2,
  ),
);

// Headless end-to-end check of the Telegram channel against the built server.
//
// Runs the real server in a new private home with STUDIO_TELEGRAM_API_URL
// pointed at a local fake Bot API, creates a Personal project, connects the
// bot from Settings > Messaging, pairs a fake chat with the code the page
// shows, and checks what the bot answers. No real Telegram, provider turn or
// personal browser is involved.
//
// Usage: node scripts/studio-telegram/verify.mjs /absolute/report-dir
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const out = NodePath.resolve(process.argv[2] ?? ".studio-build-evidence/telegram");
NodeFS.mkdirSync(out, { recursive: true });
const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-telegram-"));
NodeFS.mkdirSync(NodePath.join(state, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(state, "userdata/settings.json"),
  JSON.stringify({ providerInstances: {} }),
);

const TOKEN = "123456789:AAEhBP0av28mEaIzFhOxPj8lVk9VerifyToken";
const freePort = () =>
  new Promise((done, reject) => {
    const socket = NodeNet.createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => done(port));
    });
  });

// A fake Bot API: getMe, long-polled getUpdates fed by `pushUpdate`, and a
// sendMessage log the checks read.
const sent = [];
const pendingUpdates = [];
let waitingPoll = null;
let nextUpdateId = 1;
const pushUpdate = (chatId, text) => {
  pendingUpdates.push({
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      chat: { id: chatId, type: "private", first_name: "Verifier" },
      text,
    },
  });
  waitingPoll?.();
};
const waitForSent = async (predicate, label) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    const found = sent.find(predicate);
    if (found) return found;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Bot never sent: ${label}. Sent: ${JSON.stringify(sent)}`);
};
const telegramPort = await freePort();
const telegram = NodeHttp.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const match = /^\/bot([^/]+)\/(\w+)$/u.exec(request.url ?? "");
    const reply = (value) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (!match || match[1] !== TOKEN) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, description: "Unauthorized" }));
      return;
    }
    const input = body ? JSON.parse(body) : {};
    switch (match[2]) {
      case "getMe":
        return reply({
          ok: true,
          result: { id: 4242, username: "studio_verify_bot", first_name: "Studio" },
        });
      case "sendMessage":
        sent.push({ chatId: input.chat_id, text: input.text });
        return reply({ ok: true, result: {} });
      case "sendChatAction":
        return reply({ ok: true, result: true });
      case "getUpdates": {
        const deliver = () => {
          const offset = input.offset ?? 0;
          const ready = pendingUpdates.filter((update) => update.update_id >= offset);
          waitingPoll = null;
          reply({ ok: true, result: ready });
        };
        const offset = input.offset ?? 0;
        if (pendingUpdates.some((update) => update.update_id >= offset)) return deliver();
        const timer = setTimeout(deliver, Math.min(Number(input.timeout ?? 1), 2) * 1000);
        waitingPoll = () => {
          clearTimeout(timer);
          deliver();
        };
        return;
      }
      default:
        return reply({ ok: false, description: "Not Found" });
    }
  });
});
await new Promise((done) => telegram.listen(telegramPort, "127.0.0.1", done));

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
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
    state,
    "--no-browser",
  ],
  {
    cwd: state,
    env: {
      PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: state,
      CODEX_HOME: NodePath.join(state, "codex"),
      CLAUDE_CONFIG_DIR: NodePath.join(state, "claude"),
      XDG_CONFIG_HOME: NodePath.join(state, "config"),
      XDG_CACHE_HOME: NodePath.join(state, "cache"),
      LANG: "en_US.UTF-8",
      STUDIO_TELEGRAM_API_URL: `http://127.0.0.1:${telegramPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
child.stdout.on("data", (chunk) => (serverLog += chunk));
child.stderr.on("data", (chunk) => (serverLog += chunk));

const rpc = async (context, tag, payload = {}) => {
  const response = await context.request.post(origin + "/api/auth/websocket-ticket", {
    headers: { Origin: origin },
  });
  NodeAssert.equal(response.status(), 200);
  const { ticket } = await response.json();
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC timed out: ${tag}`));
    }, 15000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    ws.addEventListener("message", (event) => {
      const items = [JSON.parse(event.data)].flat();
      for (const item of items) {
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        clearTimeout(timer);
        ws.close();
        if (item.exit?._tag === "Success") resolve(item.exit.value);
        else reject(new Error(`RPC failed: ${tag}: ${JSON.stringify(item.exit)}`));
      }
    });
  });
};

let browser;
const receipt = {
  headless: true,
  realBuiltServer: true,
  fakeTelegram: true,
  nativeTurns: 0,
  checks: [],
  screenshots: [],
};
try {
  const credential = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Private server did not become ready")), 45000);
    const observe = () => {
      const match = serverLog.match(/(?:^|\n)Token: ([^\s]+)/);
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
  const { chromium } = NodeModule.createRequire(import.meta.url)(
    NodePath.join(root, "node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core"),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => {
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

  const project = await rpc(context, "projects.createNew", { kind: "personal", name: "Errands" });
  receipt.checks.push({ personalProjectCreated: project.projectId });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/settings/messaging");
  const tokenInput = page.getByLabel("Telegram bot token", { exact: true });
  await tokenInput.waitFor({ timeout: 20000 });
  const shot = async (name) => {
    const file = NodePath.join(out, name);
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    receipt.screenshots.push(file);
  };
  await shot("1-messaging-empty.png");

  // A malformed token is caught before it reaches the host.
  await tokenInput.fill("not-a-token");
  NodeAssert.ok(await page.getByText("does not look like a bot token", { exact: false }).count());
  await tokenInput.fill(TOKEN);
  await page.getByRole("combobox", { name: "Project for the Telegram channel" }).click();
  await page.getByRole("option", { name: /Errands/u }).click();
  await page.getByRole("button", { name: "Connect bot" }).click();
  const codeLine = page.getByText(/^\/start [A-Z2-9]{10}$/u);
  await codeLine.waitFor({ timeout: 15000 });
  const code = (await codeLine.innerText()).replace("/start ", "").trim();
  NodeAssert.match(code, /^[A-Z2-9]{10}$/u);
  NodeAssert.ok(await page.locator('svg[role="img"], svg title').count());
  await shot("2-messaging-pairing-code.png");
  const afterConnect = await rpc(context, "telegramChannel.status");
  NodeAssert.equal(afterConnect.configured, true);
  NodeAssert.equal(afterConnect.botUsername, "studio_verify_bot");
  NodeAssert.equal(
    JSON.stringify(afterConnect).includes(TOKEN),
    false,
    "status never returns the token",
  );
  receipt.checks.push({ connected: true, tokenNotReturned: true });

  // A stranger gets only the hint; the right code pairs and the page updates.
  pushUpdate(7, "hello");
  await waitForSent(
    (message) => message.chatId === 7 && message.text.includes("not paired"),
    "pairing hint",
  );
  pushUpdate(42, `/start ${code}`);
  await waitForSent(
    (message) => message.chatId === 42 && message.text.startsWith("Paired."),
    "paired reply",
  );
  await page.getByText("Paired with", { exact: false }).waitFor({ timeout: 15000 });
  await shot("3-messaging-paired.png");
  receipt.checks.push({ strangerHintOnly: true, paired: true });

  // After pairing, strangers get nothing; the owner's commands and text are handled.
  const before = sent.length;
  pushUpdate(7, "let me in");
  pushUpdate(42, "/status");
  const statusReply = await waitForSent(
    (message) => message.chatId === 42 && message.text.startsWith("Project: Errands"),
    "status reply",
  );
  pushUpdate(42, "Plan my Saturday");
  const forwardReply = await waitForSent(
    (message) =>
      message.chatId === 42 &&
      (message.text.includes("has no coordinator yet") ||
        message.text.startsWith("Queued") ||
        message.text.startsWith("Studio did not take")),
    "forward outcome",
  );
  NodeAssert.equal(
    sent.slice(before).some((message) => message.chatId === 7),
    false,
    "strangers are ignored once paired",
  );
  receipt.checks.push({
    statusReply: statusReply.text,
    forwardOutcome: forwardReply.text,
    strangerIgnored: true,
  });

  await page.getByRole("button", { name: "Unpair chat" }).click();
  await codeLine.waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Connect bot" }).waitFor({ timeout: 15000 });
  const removed = await rpc(context, "telegramChannel.status");
  NodeAssert.equal(removed.configured, false);
  NodeAssert.deepEqual(errors, []);
  receipt.checks.push({ unpaired: true, removed: true, pageErrors: errors });
  NodeAssert.equal(serverLog.includes(TOKEN), false, "the server log never contains the token");
  receipt.checks.push({ tokenNotLogged: true });
  receipt.sent = sent;
} catch (error) {
  NodeFS.writeFileSync(NodePath.join(out, "failure-server-log.txt"), serverLog.slice(-20000));
  throw error;
} finally {
  await browser?.close();
  telegram.close();
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  NodeFS.rmSync(state, { recursive: true, force: true });
  receipt.privateHomeRemoved = true;
}
NodeFS.writeFileSync(
  NodePath.join(out, "telegram-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt.checks));

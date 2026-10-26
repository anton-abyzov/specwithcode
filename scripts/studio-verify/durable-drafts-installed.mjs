// Headless check of unsent drafts on the INSTALLED local service (the port in
// ~/.specwithcode/<identity>/installation.json). Creates its own scratch
// project and thread, types a draft and attaches an image, then checks both
// come back after (1) a page reload, (2) closing and reopening the window on
// the same profile and (3) a fresh profile with nothing stored locally, which
// can only be the host's copy. Removes its draft, thread and project after.
// Never restarts the service and touches no other thread.
// Usage: node scripts/studio-verify/durable-drafts-installed.mjs /absolute/evidence-dir [identity]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const out = resolve(process.argv[2] ?? ".");
mkdirSync(out, { recursive: true });
const studioHome = join(homedir(), ".specwithcode", process.argv[3] ?? "m4");
const installation = JSON.parse(readFileSync(join(studioHome, "installation.json"), "utf8"));
const origin = `http://${installation.host}:${installation.port}`;
const { chromium } = createRequire(join(installation.release, "package.json"))("playwright-core");
const shells = join(homedir(), "Library/Caches/ms-playwright");
const shell = readdirSync(shells)
  .filter((name) => name.startsWith("chromium_headless_shell-"))
  .sort()
  .at(-1);
const executablePath = join(shells, shell, "chrome-headless-shell-mac-arm64/chrome-headless-shell");

// A 24x24 solid PNG, written here so the check needs no fixture.
function png() {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const size = 24;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([240, 90, 90]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const imagePath = join(out, "attached.png");
writeFileSync(imagePath, png());

// A one-time, short-lived pairing token; it never reaches the receipt. A busy
// service can miss the discovery probe, and log lines can precede the JSON.
function mintCredential(attempt = 1) {
  try {
    const output = execFileSync(
      "specweave-studio",
      [
        "pair",
        "--json",
        "--log-level",
        "error",
        "--base-dir",
        studioHome,
        "--ttl",
        "10m",
        "--label",
        "Durable drafts check",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const line = output.split("\n").find((text) => text.startsWith("{"));
    return JSON.parse(line).token;
  } catch (error) {
    if (attempt >= 6) throw new Error(`pair failed: ${String(error.stderr ?? error).slice(-400)}`);
    execFileSync("sleep", ["10"]);
    return mintCredential(attempt + 1);
  }
}

async function signIn(context) {
  const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
    data: { credential: mintCredential() },
    headers: { Origin: origin },
    timeout: 60000,
  });
  assert.equal(auth.status(), 200, "browser session");
}

async function rpc(context, tag, payload = {}) {
  const ticketResponse = await context.request.post(`${origin}/api/auth/websocket-ticket`, {
    headers: { Origin: origin },
    timeout: 60000,
  });
  assert.equal(ticketResponse.status(), 200);
  const { ticket } = await ticketResponse.json();
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((done, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC timeout ${tag}`));
    }, 60000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    ws.addEventListener("message", (event) => {
      for (const item of [JSON.parse(event.data)].flat())
        if (item._tag === "Exit" && String(item.requestId) === "1") {
          clearTimeout(timer);
          ws.close();
          if (item.exit?._tag === "Success") done(item.exit.value);
          else reject(new Error(`RPC failed ${tag}: ${JSON.stringify(item.exit).slice(0, 800)}`));
        }
    });
  });
}

const scratch = join(homedir(), ".local/share/specweave-studio/verification/drafts-installed");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const run = mkdtempSync(join(scratch, "run-"));
const workspaceRoot = join(run, "project");
mkdirSync(workspaceRoot);
const stamp = Date.now().toString(36);
const projectId = `drafts-check-${stamp}`;
const projectTitle = "Drafts check (scratch)";
const threadId = `drafts-check-thread-${stamp}`;
const draftKey = `thread:${threadId}`;
const TEXT = `Installed draft check ${stamp}: émoji 🙂, «quotes», ✓ ≠ ∑ 日本語`;
const receipt = {
  headless: true,
  origin,
  sourceCommit: installation.sourceCommit,
  release: installation.release,
  projectId,
  threadId,
  checks: [],
  screenshots: [],
};

const launch = async (dir) => {
  const context = await chromium.launchPersistentContext(dir, {
    headless: true,
    executablePath,
    viewport: { width: 1440, height: 1000 },
  });
  // A busy host answers slowly; the checks below wait for content, not idle.
  context.setDefaultTimeout(60000);
  context.setDefaultNavigationTimeout(90000);
  await context.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
    ),
  );
  return context;
};
async function shot(page, name) {
  await page.screenshot({ path: join(out, name) });
  receipt.screenshots.push(name);
}
async function expectDraft(page, label) {
  await page.waitForFunction(
    (text) =>
      document.querySelector('[data-testid="composer-editor"]')?.textContent?.includes(text),
    TEXT,
    { timeout: 90000 },
  );
  const image = page.locator('img[src^="blob:"], img[src^="data:"]').first();
  await image.waitFor({ timeout: 90000 });
  const size = await image.evaluate((img) =>
    img.complete ? { width: img.naturalWidth, height: img.naturalHeight } : null,
  );
  assert.deepEqual(size, { width: 24, height: 24 }, `${label}: image`);
  receipt.checks.push({ [label]: { text: true, image: size } });
}

let context;
let fresh;
let page;
try {
  // 1. Type a draft and attach an image in a scratch thread.
  context = await launch(join(run, "profile"));
  await signIn(context);
  const config = await rpc(context, "server.getConfig");
  receipt.version = config.version ?? null;
  const environmentId = config.environment.environmentId;
  await rpc(context, "projects.mutate", {
    type: "project.create",
    commandId: `${projectId}-create`,
    projectId,
    title: projectTitle,
    workspaceRoot,
  });
  await rpc(context, "orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: `${threadId}-create`,
    threadId,
    projectId,
    title: projectTitle,
    createdBy: "user",
    creationSource: "web",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  const threadUrl = `${origin}/${environmentId}/${threadId}`;
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
  const editor = page.locator('[data-testid="composer-editor"]');
  await editor.waitFor({ timeout: 90000 });
  await editor.click();
  await page.keyboard.insertText(TEXT);
  await page.locator('input[type="file"]').last().setInputFiles(imagePath);
  await page.locator('img[src^="blob:"], img[src^="data:"]').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await shot(page, "1-typed-with-image.png");

  // 2. Reload the page.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectDraft(page, "afterReload");
  await shot(page, "2-after-reload.png");

  // 3. Close the window and open it again on the same profile.
  await context.close();
  context = await launch(join(run, "profile"));
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
  await expectDraft(page, "afterWindowReopen");
  await shot(page, "3-after-window-reopen.png");

  // 4. The host's own copy, read directly and through a profile with no local copy.
  const host = await rpc(context, "composerDrafts.get", { key: draftKey });
  const record = host?.draft ?? host?.record ?? host;
  assert.ok(record?.prompt?.includes(TEXT), "host has the draft text");
  assert.ok((record?.attachments?.length ?? 0) >= 1, "host has the image");
  receipt.checks.push({ hostCopy: { text: true, attachments: record.attachments.length } });
  fresh = await launch(join(run, "profile-fresh"));
  await signIn(fresh);
  const freshPage = fresh.pages()[0] ?? (await fresh.newPage());
  await freshPage.goto(threadUrl, { waitUntil: "domcontentloaded" });
  await expectDraft(freshPage, "freshProfileFromHost");
  await shot(freshPage, "4-fresh-profile-from-host.png");
  receipt.ok = true;
} catch (error) {
  receipt.ok = false;
  receipt.failure = String(error?.stack ?? error).slice(0, 2000);
  if (page) await shot(page, "failure.png").catch(() => undefined);
} finally {
  // Remove only what this run created.
  receipt.cleanup = [];
  for (const [tag, payload] of [
    ["composerDrafts.delete", { key: draftKey }],
    [
      "orchestration.dispatchCommand",
      { type: "thread.delete", commandId: `${threadId}-delete`, threadId },
    ],
    [
      "projects.mutate",
      {
        type: "project.delete",
        commandId: `${projectId}-delete`,
        projectId,
        force: true,
        confirmationTitle: projectTitle,
      },
    ],
  ]) {
    const label = `${tag}:${payload.type ?? "draft"}`;
    try {
      await rpc(context, tag, payload);
      receipt.cleanup.push(`${label}:ok`);
    } catch (error) {
      receipt.cleanup.push(`${label}:${String(error).slice(0, 200)}`);
    }
  }
  await fresh?.close().catch(() => undefined);
  await context?.close().catch(() => undefined);
  rmSync(run, { recursive: true, force: true });
  writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.ok ? 0 : 1;
}

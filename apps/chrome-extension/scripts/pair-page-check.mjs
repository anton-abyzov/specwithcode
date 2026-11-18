/**
 * Headless check of the unpacked extension's pairing page in a throwaway profile, against a stub
 * relay on loopback and a synthetic code. Never touches a real Chrome profile.
 *   node apps/chrome-extension/scripts/pair-page-check.mjs <repo root> <evidence dir>
 * Set CHROMIUM_PATH to a Chromium (Chrome for Testing) build; branded Chrome ignores --load-extension.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const [, , repo, out] = process.argv;
const require = createRequire(path.join(repo, "package.json"));
const { chromium } = require(path.join(repo, "node_modules/.pnpm/node_modules/playwright-core"));
const { WebSocketServer } = require(path.join(repo, "node_modules/.pnpm/node_modules/ws"));
const ext = path.join(repo, "apps/chrome-extension");
fs.mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const hellos = [];
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((r) => wss.once("listening", r));
wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.method === "hello" && msg.params.token.startsWith("bad")) {
      socket.close(4401, "pairing code rejected");
    } else if (msg.method === "hello") {
      hellos.push(msg.params.label);
      socket.send(
        JSON.stringify({ method: "welcome", params: { machine: "Test Mac", heartbeat: true } }),
      );
    } else if (msg.method === "ping") socket.send(JSON.stringify({ method: "pong" }));
  });
});
const port = wss.address().port;
const makeCode = (t) =>
  "swc-chrome:1:" +
  Buffer.from(
    JSON.stringify({ u: `ws://127.0.0.1:${port}/api/browser-relay`, t, m: "Test Mac" }),
  ).toString("base64url");
const badCode = makeCode("bad".padEnd(40, "y"));
const code =
  "swc-chrome:1:" +
  Buffer.from(
    JSON.stringify({
      u: `ws://127.0.0.1:${port}/api/browser-relay`,
      t: "x".repeat(40),
      m: "Test Mac",
    }),
  ).toString("base64url");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "swc-1387-chrome-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: "chromium",
  executablePath: process.env.CHROMIUM_PATH,
  viewport: { width: 1100, height: 820 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const pairUrl = `chrome-extension://${id}/src/pair.html`;
  const deadline = Date.now() + 10000;
  let page;
  while (Date.now() < deadline && !page) {
    page = context.pages().find((p) => p.url().startsWith(pairUrl));
    if (!page) await new Promise((r) => setTimeout(r, 200));
  }
  check("first install opens the pairing page by itself", !!page, page?.url());
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);
  const active = await page.evaluate(() => document.activeElement?.id);
  check("code field has focus", active === "code", `activeElement=${active}`);
  const where = await page.locator(".where").textContent();
  check(
    "page says where to copy the code",
    where.trim() === "Copy the code from SpecWithCode: first-run setup, or Settings > Chrome.",
    where.trim(),
  );
  check("name field starts empty", (await page.locator("#label").inputValue()) === "");
  check("Pair is off without a name", await page.locator("#pair-button").isDisabled());
  await page.screenshot({ path: path.join(out, "pair-page-first-install.png") });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/src/popup.html`);
  const pairTabs = () => context.pages().filter((p) => p.url().startsWith(pairUrl)).length;
  const extra = await context.newPage();
  await extra.goto(pairUrl);
  await extra.waitForTimeout(800);
  check(
    "a pairing page opened by hand closes the older one",
    pairTabs() === 1 && page.isClosed(),
    `tabs=${pairTabs()}`,
  );
  page = extra;

  // Paste and Enter with no name moves to the name; a suggestion then lets Enter pair.
  await page.locator("#code").focus();
  await page.locator("#code").fill(code);
  await page.keyboard.press("Enter");
  const afterEnter = await page.evaluate(() => document.activeElement?.id);
  check(
    "Enter without a name moves focus to the name",
    afterEnter === "label" && hellos.length === 0,
    `activeElement=${afterEnter}`,
  );
  check("the name hint shows", await page.locator("#name-hint").isVisible());
  await page.screenshot({ path: path.join(out, "pair-page-needs-name.png") });
  await page.locator('[data-name="Agents"]').click();
  check("Pair turns on once there is a name", !(await page.locator("#pair-button").isDisabled()));
  // A refused code brings the form back with the reason, ready for another code.
  await page.locator("#code").fill(badCode);
  await page.locator("#code").focus();
  await page.keyboard.press("Enter");
  await page.locator("#pair-form:not([hidden])").waitFor({ timeout: 8000 });
  await page.waitForFunction(() => document.getElementById("error").textContent.length > 0, null, {
    timeout: 8000,
  });
  const refusal = (await page.locator("#error").textContent()).trim();
  check("a refused code brings the form back", /did not accept/.test(refusal), refusal);
  await page.locator("#code").fill(code);
  await page.locator("#code").focus();
  await page.keyboard.press("Enter");
  await page.locator("#done-status[data-phase=connected]").waitFor({ timeout: 8000 });
  const done = (await page.locator("#done-detail").textContent()).trim();
  check(
    "pairs and reports the live phase",
    hellos.at(-1) === "Agents",
    `${done}; hello label=${hellos.at(-1)}`,
  );
  await page.screenshot({ path: path.join(out, "pair-page-paired.png") });

  // The popup of a paired profile says what pairing again replaces.
  await popup.reload();
  await popup.waitForTimeout(1200);
  const replaces = (await popup.locator("#replaces").textContent()).trim();
  check(
    "popup warns what pairing again replaces",
    replaces === "This profile is paired with Test Mac. Pairing here replaces that.",
    replaces,
  );
  check(
    "popup label prefilled with the chosen name",
    (await popup.locator("#label").inputValue()) === "Agents",
  );
  await popup.setViewportSize({ width: 372, height: 640 });
  await popup.screenshot({ path: path.join(out, "popup-paired.png") });

  // An old profile named "Chrome" is asked for a name.
  await worker.evaluate(() => chrome.storage.local.set({ label: "Chrome" }));
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: "reconnect" }));
  await popup.reload();
  await popup.waitForTimeout(1500);
  check(
    "a profile named Chrome is asked for a name",
    await popup.locator("#name-needed").isVisible(),
  );
  check(
    "the name field is not prefilled with Chrome",
    (await popup.locator("#label").inputValue()) === "",
  );
  await popup.screenshot({ path: path.join(out, "popup-needs-name.png") });
} finally {
  await context.close();
  wss.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
}
process.exit(results.every((r) => r.ok) ? 0 : 1);

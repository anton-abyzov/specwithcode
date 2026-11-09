import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
await fs.mkdir(output, { recursive: true });
const origin = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const shot = (page, name) =>
  page.screenshot({ path: path.join(output, `1190-${name}.png`), fullPage: false });
const openSettings = async (page) => {
  await page.getByLabel("Project settings", { exact: true }).dispatchEvent("click");
  await page.getByRole("dialog").waitFor();
};

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // A normal project keeps its words and has no Services.
  await page.goto(`${origin}/`);
  await page.getByRole("tab", { name: /Threads/ }).waitFor({ timeout: 90_000 });
  assert.equal(await page.getByRole("tab", { name: /Topics/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Ask Aide for a topic" }).count(), 0);
  await openSettings(page);
  await page.getByRole("dialog").getByRole("heading", { name: "Project settings" }).waitFor();
  assert.equal(await page.locator('button[data-tab="services"]').count(), 0);

  // The assistant says topics.
  await page.goto(`${origin}/?personal`);
  await page.getByRole("tab", { name: /Topics/ }).waitFor({ timeout: 90_000 });
  assert.equal(await page.getByRole("tab", { name: /Threads/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Ask Aide for a topic" }).count(), 1);
  await shot(page, "aide-topics");

  await openSettings(page);
  const dialog = page.getByRole("dialog");
  await dialog.locator('button[data-tab="memory"]').click();
  await dialog.getByRole("heading", { name: "About you" }).waitFor();
  await shot(page, "aide-about-you");

  await dialog.locator('button[data-tab="services"]').click();
  await dialog.getByRole("heading", { name: "Services", exact: true }).waitFor();
  const row = (id) => dialog.locator(`[data-service="${id}"]`);
  // The account granted mail and calendar, so they switch; Drive needs the account first.
  assert.equal(await row("gmail").getByRole("switch").getAttribute("aria-checked"), "true");
  assert.equal(await row("drive").getByRole("link", { name: "Connect" }).count(), 1);
  assert.match(await row("health").innerText(), /No direct connection/);
  assert.match(await row("finances").innerText(), /No direct connection/);
  await shot(page, "aide-services");

  await row("calendar").getByRole("switch").click();
  await page.waitForFunction(() =>
    window.__projectCalls.some(
      (call) => call.command === "googleAccess" && call.args?.input?.services?.includes("calendar"),
    ),
  );

  // A token goes to its own call, never into the saved configuration.
  const notion = row("service-notion");
  await notion.getByRole("button", { name: "Connect", exact: true }).click();
  const token = "synthetic-fixture-value";
  await notion.getByLabel("Notion integration secret").fill(token);
  assert.equal(
    await notion.getByLabel("Notion integration secret").getAttribute("type"),
    "password",
  );
  await shot(page, "aide-service-connect");
  await notion.getByRole("button", { name: "Connect Notion" }).click();
  await notion.getByText("What Aide may use").waitFor();
  const calls = await page.evaluate(() => window.__projectCalls);
  const ofKind = (name) => calls.filter((call) => call.command === name);
  assert.equal(ofKind("connectionCredentialSet").length, 1);
  assert.equal(ofKind("connectionCredentialSet")[0].args.input.envKey, "NOTION_TOKEN");
  assert(!JSON.stringify(ofKind("connectionSave")).includes(token));
  assert(!JSON.stringify(ofKind("connectionCheck")).includes(token));
  assert.deepEqual(ofKind("connectionSave")[0].args.input.allowedTools, []);
  assert.match(await notion.innerText(), /Ready, no tools allowed/);
  assert.equal(await notion.getByRole("checkbox").first().isChecked(), false);
  await shot(page, "aide-service-connected");

  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByRole("heading", { name: "Services", exact: true }).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(page, "aide-services-phone");
  assert.deepEqual(errors, []);
  console.log("aide-topics-check: ok");
} finally {
  await browser.close();
}

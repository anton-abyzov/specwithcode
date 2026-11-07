// Double-clicking the title of a thread on another machine, headless.
import fs from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-remote-rename";
const threadId = process.env.REMOTE_RENAME_THREAD ?? "remote-worker";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 800 },
    deviceScaleFactor: 2,
  });
  await page.goto(`http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5795}/?rows&remote`);
  // Dispatched: real mouse presses hang in this fixture's headless shell.
  await page.locator(`[data-thread-id="${threadId}"] .sws-thread-open`).dispatchEvent("click");
  const header = page.locator(".sws-thread-head");
  await header.waitFor({ timeout: 60000 });
  const title = header.locator("h2");
  const name = await title.innerText();
  await title.dispatchEvent("dblclick");
  await page.waitForTimeout(400);
  const field = page.getByLabel("Thread title", { exact: true });
  const result = {
    headless: true,
    name,
    renameFieldOpened: (await field.count()) === 1,
    toast: await page.locator("[data-slot='toast-title']").allInnerTexts(),
  };
  await header.screenshot({ path: `${output}/remote-header.png` });
  await fs.writeFile(`${output}/receipt.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}

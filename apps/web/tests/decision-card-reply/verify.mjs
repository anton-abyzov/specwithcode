// Build first: vp build --config apps/web/tests/decision-card-reply/vite.config.ts
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE. Always headless.
// Usage: node apps/web/tests/decision-card-reply/verify.mjs [/absolute/evidence-dir]
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/decision-card-reply/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/decision-card-reply/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
// A 1x1 PNG in three colors, so each way in is a distinct file.
const png = (name, color) => ({
  name,
  mimeType: "image/png",
  base64: {
    red: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    green:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    blue: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  }[color],
});
const receipt = { headless: true, checks: [], screenshots: [], videos: [] };
const check = (name, ok, detail) => {
  receipt.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  NodeAssert.ok(ok, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      viewport: { width: 900, height: 820 },
      colorScheme: theme,
      recordVideo: { dir: output, size: { width: 900, height: 820 } },
    });
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const shot = async (name) => {
      const file = NodePath.join(output, `${name}-${theme}.png`);
      await page.screenshot({ path: file });
      receipt.screenshots.push(file);
    };
    const editor = page.locator('[data-chat-composer-form] [contenteditable="true"]').first();
    const draft = () => page.evaluate(() => window.__fixture.threadDraft());
    const thumbnails = page.locator("[data-chat-composer-expanded-image]");

    // AC-04: a card that arrives mid-draft leaves the draft in place.
    await page.goto(`${origin}/?question=off&theme=${theme}`);
    await page.waitForSelector("body[data-fixture-ready]");
    await editor.click();
    await page.keyboard.type("Use the compact layout, like these");
    await page.evaluate(() => window.__fixture.showQuestion(true));
    await page.waitForSelector("[data-question-card]");
    check(
      `${theme}: draft stays visible when the card appears`,
      (await editor.innerText()).includes("Use the compact layout, like these"),
    );
    await shot("card-arrives-mid-draft");

    // AC-03: reply in chat focuses the composer and keeps the draft.
    await page
      .locator("button", { hasText: "Reply" })
      .first()
      .waitFor()
      .catch(() => {});
    await page.click("[data-question-reply-in-chat]");
    check(
      `${theme}: reply in chat focuses the composer`,
      await editor.evaluate(
        (node) => node === document.activeElement || node.contains(document.activeElement),
      ),
    );
    check(
      `${theme}: reply in chat keeps the draft`,
      (await draft())?.prompt.includes("Use the compact layout, like these") === true,
    );

    // AC-01: paste, the attach button and a drop all add visible thumbnails.
    await page.evaluate(
      ({ name, mimeType, base64 }) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], name, { type: mimeType }));
        document.activeElement.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      },
      png("pasted.png", "red"),
    );
    await thumbnails.first().waitFor();
    const picked = png("picked.png", "green");
    await page.locator('[data-chat-composer-form] input[type="file"]').setInputFiles({
      name: picked.name,
      mimeType: picked.mimeType,
      buffer: Buffer.from(picked.base64, "base64"),
    });
    await page.waitForFunction(
      () => document.querySelectorAll("[data-chat-composer-expanded-image]").length >= 2,
    );
    const dropped = png("dropped.png", "blue");
    const dataTransfer = await page.evaluateHandle(({ name, mimeType, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], name, { type: mimeType }));
      return data;
    }, dropped);
    for (const type of ["dragenter", "dragover", "drop"]) {
      await page.dispatchEvent("[data-fixture-drop-target]", type, { dataTransfer });
    }
    await page.waitForFunction(
      () => document.querySelectorAll("[data-chat-composer-expanded-image]").length >= 3,
    );
    check(
      `${theme}: pasted, picked and dropped images show before sending`,
      (await thumbnails.count()) === 3,
      await thumbnails.count(),
    );
    check(
      `${theme}: the files stay in the thread draft with the text`,
      (await draft())?.images === 3,
      await draft(),
    );
    await shot("card-with-images");

    // AC-02: sending answers the card with the text and every image.
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-decision-card]");
    const [response] = await page.evaluate(() => window.__fixture.responses);
    check(
      `${theme}: the answer carries the typed text`,
      response?.answers?.q1 === "Use the compact layout, like these",
      response?.answers,
    );
    check(
      `${theme}: the answer carries every image`,
      response?.attachments?.q1?.length === 3,
      response?.attachments,
    );
    check(`${theme}: the answer is marked as sent from chat`, response?.answeredInChat === true);
    check(
      `${theme}: the card reads Answered in chat`,
      (await page.locator("[data-decision-card]").innerText()).includes("Answered in chat"),
    );
    check(
      `${theme}: the reply stays in the conversation`,
      (await page.locator("[data-fixture-chat-reply] img").count()) === 3,
    );
    check(
      `${theme}: the composer is empty after the answer`,
      (await draft()) === null,
      await draft(),
    );
    await shot("answered-in-chat");
    check(`${theme}: no page errors`, errors.length === 0, errors);
    const video = page.video();
    await context.close();
    if (video) {
      const file = NodePath.join(output, `reply-in-chat-${theme}.webm`);
      await NodeFSP.rename(await video.path(), file);
      receipt.videos.push(file);
    }
  }
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await browser.close();
  server.close();
}
console.log(`${receipt.checks.length} checks passed; evidence in ${output}`);

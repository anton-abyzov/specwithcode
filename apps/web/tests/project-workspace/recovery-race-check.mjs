import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = process.env.UI_EVIDENCE_DIR;
const port = Number(process.env.PROJECT_UI_PORT ?? 5797);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
const results = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    for (const scenario of ["saved", "pending-read", "command-storage-failure"]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      if (scenario === "command-storage-failure")
        await page.addInitScript(() => {
          window.__commandStorageAvailable = false;
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("studio.project-send.v1:") && !window.__commandStorageAvailable)
              throw new Error("command storage unavailable");
            return original.call(this, key, value);
          };
        });
      await page.goto(`http://127.0.0.1:${port}/?recovery=${scenario}&recovery-navigation`);
      await page.waitForLoadState("networkidle");
      const retry = page.getByRole("button", { name: "Retry last message", exact: true });
      await retry.waitFor();
      await page.locator("#project-prompt").fill("Preserve my unsent draft");
      await retry.click();
      if (scenario === "pending-read") {
        await page.waitForFunction(() => window.__recoveryPendingReads.length === 1);
        await page.getByRole("button", { name: "Leave project fixture", exact: true }).click();
        await page.getByRole("button", { name: "Return to project fixture", exact: true }).click();
        await retry.waitFor();
        assert(await retry.isEnabled(), "Navigation stranded persistent composer submission");
        assert.equal(
          await page.locator("#project-prompt").inputValue(),
          "Preserve my unsent draft",
        );
        await retry.click();
        await page.waitForFunction(() => window.__recoveryPendingReads.length === 2);
        await page.evaluate(() => window.__recoveryPendingReads[0]());
        assert(
          await page.getByRole("button", { name: "Retrying…", exact: true }).isDisabled(),
          "Old canceled read cleared the newer retry lock",
        );
        assert.equal(await page.evaluate(() => window.__recoveryUploads.length), 0);
        await page.evaluate(() => window.__recoveryPendingReads[1]());
        await page.waitForFunction(() => window.__recoveryPendingReads.length === 3);
        await page.evaluate(() => window.__recoveryPendingReads[2]());
      } else if (scenario === "command-storage-failure") {
        await page.getByText(/session storage to preserve its command identity/).waitFor();
        assert.equal(
          await page.evaluate(
            () => window.__projectCalls.filter((call) => call.command === "send").length,
          ),
          0,
        );
        assert(await retry.isEnabled(), "Storage failure stranded the send state");
        await page.evaluate(() => {
          window.__commandStorageAvailable = true;
        });
        await retry.click();
      }
      await page.waitForFunction(
        () => window.__projectCalls.filter((call) => call.command === "send").length === 1,
      );
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Retry last message" && !button.disabled,
        ),
      );
      const sends = await page.evaluate(() =>
        window.__projectCalls.filter((call) => call.command === "send"),
      );
      assert.equal(sends[0].args.input.prompt, "Have you resolved this?");
      assert.equal(sends[0].args.input.attachments.length, 2);
      assert.equal(await page.evaluate(() => window.__recoveryUploads.length), 2);
      await retry.click();
      await page.getByText(/This retry was confirmed/).waitFor();
      assert.equal(
        await page.evaluate(
          () => window.__projectCalls.filter((call) => call.command === "send").length,
        ),
        1,
      );
      assert.equal(await page.evaluate(() => window.__recoveryUploads.length), 2);
      assert.equal(await page.locator("#project-prompt").inputValue(), "Preserve my unsent draft");
      await page.screenshot({
        path: path.join(output, `${viewport.width}-${scenario}.png`),
        fullPage: true,
        animations: "disabled",
      });
      if (scenario === "saved") {
        const original = page.url();
        const cached = new URL(original);
        cached.searchParams.set("recovery-failure", "cached-F0");
        await page.goto(cached.href);
        await page.waitForLoadState("networkidle");
        await retry.waitFor();
        await page.goto(original);
        await page.waitForLoadState("networkidle");
        await retry.click();
        await page.getByText(/This retry was confirmed/).waitFor();
        assert.equal(
          await page.evaluate(
            () => window.__projectCalls.filter((call) => call.command === "send").length,
          ),
          0,
          "An older cached failure evicted accepted F1 confirmation",
        );
        const next = new URL(original);
        next.searchParams.set("recovery-failure", "new-F2");
        await page.goto(next.href);
        await page.waitForLoadState("networkidle");
        await retry.click();
        await page.waitForFunction(
          () => window.__projectCalls.filter((call) => call.command === "send").length === 1,
        );
        await page.goto(original);
        await page.waitForLoadState("networkidle");
        await retry.click();
        await page.getByText(/This retry was confirmed/).waitFor();
        assert.equal(
          await page.evaluate(
            () => window.__projectCalls.filter((call) => call.command === "send").length,
          ),
          0,
          "A distinct new failure evicted accepted F1 confirmation",
        );
      }
      await page.reload();
      await page.waitForLoadState("networkidle");
      await retry.click();
      await page.getByText(/This retry was confirmed/).waitFor();
      assert.equal(
        await page.evaluate(
          () => window.__projectCalls.filter((call) => call.command === "send").length,
        ),
        0,
      );
      assert.equal(await page.evaluate(() => window.__recoveryUploads.length), 0);
      assert.equal(await page.evaluate(() => window.__recoveryAssets.length), 0);
      await page.screenshot({
        path: path.join(output, `${viewport.width}-${scenario}-reload.png`),
        fullPage: true,
        animations: "disabled",
      });
      assert.deepEqual(errors, []);
      results.push({
        viewport,
        scenario,
        passed: true,
        sendsBeforeReload: 1,
        sendsAfterReload: 0,
        ...(scenario === "saved"
          ? { oldCacheDidNotEvictConfirmation: true, distinctNewFailureRetries: 1 }
          : {}),
        boundary:
          "Production workspace/recovery/composer/receipt; mocked host, assets and uploads. No provider or live account operations.",
      });
      await context.close();
    }
  }
} finally {
  await fs.writeFile(
    path.join(output, "recovery-race-results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(results));

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright"
);
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/studio-coordinator-recovery";
const port = Number(process.env.PROJECT_UI_PORT ?? 5788);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const results = [];
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    for (const scenario of ["saved", "missing", "upload-failure", "incompatible", "full-access"]) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/?recovery=${scenario}`);
      await page.waitForLoadState("networkidle");
      const retry = page.getByRole("button", { name: "Retry last message", exact: true });
      await retry.waitFor();
      assert(await page.getByText("Have you resolved this?", { exact: true }).isVisible());
      assert(await page.locator("[data-coordinator-folder-guidance]").isVisible());
      assert.equal(
        await page.evaluate(
          () => window.__projectCalls.filter((call) => call.command === "send").length,
        ),
        0,
      );
      if (scenario === "incompatible") {
        assert(await retry.isDisabled());
        assert(
          await page.getByRole("button", { name: "Send to coordinator", exact: true }).isDisabled(),
        );
        const picker = page.getByRole("button", {
          name: /Coordinator model:.*Copilot.*Change model/i,
        });
        assert(await picker.isVisible());
        await picker.click();
        const menu = page.locator("[data-model-picker-content]");
        await page.getByPlaceholder("Search models or providers").waitFor();
        assert.equal(await page.getByRole("option").first().getAttribute("aria-disabled"), "true");
        await page.screenshot({
          path: path.join(output, `${viewport.width}-${scenario}-picker.png`),
          fullPage: true,
          animations: "disabled",
        });
        await menu.getByRole("button", { name: "Codex", exact: true }).click();
        await page.getByRole("option", { name: /GPT-6/ }).click();
        await page
          .getByRole("button", { name: /Coordinator model:.*GPT-6.*Change model/ })
          .waitFor();
        assert(await retry.isEnabled());
        assert.equal(await page.getByText(/Choose one for the coordinator/).count(), 0);
        assert(
          await page
            .getByText("Additional folders are available with Codex, Claude and Muse Code.", {
              exact: true,
            })
            .isVisible(),
        );
        await retry.click();
        await page.waitForFunction(() =>
          window.__projectCalls.some((call) => call.command === "send"),
        );
        assert.equal(
          await page.evaluate(
            () => window.__projectCalls.filter((call) => call.command === "send").length,
          ),
          1,
        );
      } else {
        assert(await retry.isEnabled());
        if (scenario === "full-access") {
          assert(
            await page
              .getByRole("button", { name: /Coordinator model:.*Copilot.*Change model/ })
              .isVisible(),
          );
          assert(
            await page
              .getByText(
                "Project folders use this coordinator’s existing full-access permissions.",
                { exact: true },
              )
              .isVisible(),
          );
          assert.equal(
            await page.getByText(/choose Codex, Claude or Muse Code for the coordinator/).count(),
            0,
          );
        }
        await page.locator("#project-prompt").fill("Keep my separate unsent draft");
        await retry.click();
        if (scenario === "saved" || scenario === "full-access") {
          await page.waitForFunction(() =>
            window.__projectCalls.some((call) => call.command === "send"),
          );
          const calls = await page.evaluate(() =>
            window.__projectCalls.filter((call) => call.command === "send"),
          );
          assert.equal(calls.length, 1);
          assert.equal(calls[0].args.environmentId, "host");
          assert.equal(calls[0].args.input.prompt, "Have you resolved this?");
          assert.deepEqual(
            calls[0].args.input.attachments.map((attachment) => attachment.id),
            ["pending-restored-0", "pending-restored-1"],
          );
          assert.deepEqual(
            calls[0].args.input.attachments.map((attachment) => attachment.name),
            ["restart.png", "notes.txt"],
          );
          const assets = await page.evaluate(() => window.__recoveryAssets);
          assert(assets.every((target) => target.environmentId === "host"));
          assert.deepEqual(
            assets.map((target) => target.input.resource.attachmentId),
            ["captured-shot", "captured-notes"],
          );
        } else {
          await page
            .getByText(
              scenario === "missing"
                ? /Could not restore notes.txt/
                : /Could not restore all message attachments/,
            )
            .waitFor();
          assert.equal(
            await page.evaluate(
              () => window.__projectCalls.filter((call) => call.command === "send").length,
            ),
            0,
          );
          assert(await retry.isEnabled());
        }
        assert.equal(
          await page.locator("#project-prompt").inputValue(),
          "Keep my separate unsent draft",
        );
      }
      const details = page.getByText("Error details", { exact: true });
      await details.click();
      assert(await page.getByText("run-failed", { exact: true }).isVisible());
      await page.screenshot({
        path: path.join(output, `${viewport.width}-${scenario}.png`),
        fullPage: true,
        animations: "disabled",
      });
      const width = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert(width.scroll <= width.viewport + 1, `Overflow: ${JSON.stringify(width)}`);
      assert.deepEqual(errors, []);
      results.push({
        viewport,
        scenario,
        passed: true,
        boundary:
          "Production UI and recovery helper; mocked host/assets/uploads. No provider turn or live settings change.",
      });
      await page.close();
    }
    await context.close();
  }
} finally {
  await fs.writeFile(path.join(output, "recovery-results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results));

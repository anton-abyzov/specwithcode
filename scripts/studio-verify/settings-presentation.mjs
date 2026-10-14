import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
const { chromium } = createRequire(import.meta.url)(
  process.env.PLAYWRIGHT_MODULE ??
    resolve(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = resolve(process.argv[2] ?? ".artifacts/settings-presentation");
mkdirSync(output, { recursive: true });
const origin = process.env.SETTINGS_UI_ORIGIN ?? "http://127.0.0.1:5796";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_TEST_CHROMIUM ? { executablePath: process.env.STUDIO_TEST_CHROMIUM } : {}),
});
const checks = [];
try {
  for (const [width, height] of [
    [1440, 1000],
    [800, 600],
    [390, 844],
    [667, 375],
    [320, 568],
  ]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(origin);
      await page.evaluate(
        (theme) => document.documentElement.classList.toggle("dark", theme === "dark"),
        theme,
      );
      const dialog = page.getByRole("dialog");
      try {
        await dialog.waitFor({ timeout: 30000 });
        const disclosure = dialog.locator(".project-settings-heading details");
        assert.equal(await disclosure.getAttribute("open"), null);
        const headingHeight = await dialog
          .locator("header")
          .evaluate((e) => e.getBoundingClientRect().height);
        assert(headingHeight < 150, `Header inflated: ${headingHeight}`);
        await disclosure.locator("summary").focus();
        await page.keyboard.press("Enter");
        assert.equal(await disclosure.getAttribute("open"), "");
        assert((await disclosure.locator("code").innerText()).includes("handoff-proof"));
        await page.keyboard.press("Enter");
        for (const tab of ["General", "Memory", "Environment", "Usage", "Routines"]) {
          await dialog.getByRole("button", { name: tab, exact: true }).click();
          if (tab === "General")
            await dialog.getByLabel("Name and icon", { exact: true }).fill("Edited project name");
          if (tab === "General") {
            await disclosure.locator("summary").focus();
            await page.keyboard.press("Enter");
            const usableHeight = await dialog.locator(".project-settings-body").evaluate((e) => {
              const style = getComputedStyle(e);
              return (
                e.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
              );
            });
            assert(usableHeight >= 40, `Expanded path leaves only ${usableHeight}px for fields`);
            await page.screenshot({
              path: resolve(output, `${width}x${height}-${theme}-expanded-header.png`),
              animations: "disabled",
            });
            await page.keyboard.press("Enter");
          }
          const layout = await dialog.evaluate((e) => {
            const b = e.getBoundingClientRect();
            const body = e.querySelector(".project-settings-body");
            const footer = e.querySelector(".project-settings-footer").getBoundingClientRect();
            return {
              right: b.right,
              bottom: b.bottom,
              top: b.top,
              bodyWidth: body.clientWidth,
              bodyScrollWidth: body.scrollWidth,
              bodyHeight: body.clientHeight,
              footerBottom: footer.bottom,
            };
          });
          assert(
            layout.right <= width + 1 && layout.bottom <= height + 1 && layout.top >= 0,
            JSON.stringify(layout),
          );
          assert(
            layout.bodyScrollWidth <= layout.bodyWidth + 1,
            `${tab} horizontal overflow ${JSON.stringify(layout)}`,
          );
          assert(layout.bodyHeight > 50, `No scrollable content: ${JSON.stringify(layout)}`);
          assert(layout.footerBottom <= height, `Footer offscreen: ${JSON.stringify(layout)}`);
          if (tab === "Environment") {
            const folder = dialog.locator(".project-environment-entry details").first();
            await folder.locator("summary").click();
            assert(await folder.locator("code").isVisible());
          }
          await page.screenshot({
            path: resolve(output, `${width}x${height}-${theme}-${tab.toLowerCase()}.png`),
            animations: "disabled",
          });
          if (tab === "Environment") {
            await dialog
              .getByRole("heading", { name: "Connections", exact: true })
              .evaluate((e) => e.scrollIntoView({ block: "start" }));
            const controlsFit = await dialog.locator(".project-settings-body").evaluate((body) => {
              const bounds = body.getBoundingClientRect();
              return [...body.querySelectorAll("button,input,textarea,select")]
                .filter((e) => e.getClientRects().length)
                .every((e) => {
                  const box = e.getBoundingClientRect();
                  return box.left >= bounds.left && box.right <= bounds.right;
                });
            });
            assert(controlsFit, "A settings control extends outside the scroll pane");
            await page.screenshot({
              path: resolve(output, `${width}x${height}-${theme}-connections.png`),
              animations: "disabled",
            });
          }
          checks.push({ width, height, theme, tab, ...layout });
        }
        await page.goto(origin + "/?shared");
        await page.evaluate(
          (theme) => document.documentElement.classList.toggle("dark", theme === "dark"),
          theme,
        );
        await page.getByRole("heading", { name: "Project folders" }).waitFor();
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          "Shared settings overflow",
        );
        await page.screenshot({
          path: resolve(output, `${width}x${height}-${theme}-shared.png`),
          animations: "disabled",
          fullPage: true,
        });
        assert.deepEqual(errors, []);
      } catch (error) {
        await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true });
        writeFileSync(
          resolve(output, "failure.txt"),
          String(error) +
            "\n" +
            errors.join("\n") +
            "\n" +
            (await page.locator("body").innerText()),
        );
        throw error;
      } finally {
        await page.close();
      }
    }
  }
  writeFileSync(
    resolve(output, "receipt.json"),
    JSON.stringify({ headless: true, checks, providerTurns: 0, mockedHost: true }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, output }));
} finally {
  await browser.close();
}

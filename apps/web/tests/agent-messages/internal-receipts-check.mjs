// Synthetic coordinator and real worker timeline; no live state or provider turns.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.argv[2];
assert(
  output && path.isAbsolute(output) && process.env.STUDIO_PLAYWRIGHT_MODULE,
  "Provide absolute evidence path and STUDIO_PLAYWRIGHT_MODULE",
);
await fs.mkdir(output, { recursive: false });
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
  timeout: 15000,
});
const checks = [];
try {
  for (const view of ["coordinator", "worker"])
    for (const [theme, width] of [
      ["light", 1280],
      ["dark", 390],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        colorScheme: theme,
      });
      await context.tracing.start({ screenshots: false, snapshots: false, sources: true });
      context.setDefaultTimeout(10000);
      context.setDefaultNavigationTimeout(10000);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        window.__copies = [];
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (t) => window.__copies.push(t),
            write: async () => {
              throw Error("Text-only fixture");
            },
          },
        });
      });
      try {
        for (const detail of ["normal", "concise", "verbose"]) {
          console.log(`${view}/${theme}/${detail}`);
          await page.goto(
            view === "coordinator"
              ? "http://127.0.0.1:5877/?internal-receipts"
              : `http://127.0.0.1:5876/?thread=thread-concise-coordinator&detail=${detail}&theme=${theme}`,
          );
          console.log("loaded");
          await page.waitForLoadState("networkidle");
          console.log("idle");
          await page.waitForFunction(
            () => document.querySelectorAll("[data-relayed-message]").length >= 1,
          );
          console.log("relay count", await page.locator("[data-relayed-message]").count());
          await page.evaluate(
            (dark) => document.documentElement.classList.toggle("dark", dark),
            theme === "dark",
          );
          if (view === "coordinator") {
            console.log("menu");
            await page.locator("[data-timeline-detail]").evaluate((e) => e.click());
            console.log("menu opened");
            const name = { normal: "Folded steps", concise: "Results only", verbose: "Everything" }[
              detail
            ];
            console.log("choose", name);
            await page
              .getByLabel("Show in this thread", { exact: true })
              .getByRole("menuitemradio", { name: new RegExp("^" + name) })
              .evaluate((e) => e.click());
            await page.waitForFunction(
              (level) =>
                document.querySelector("[data-timeline-detail]").dataset.timelineDetail === level,
              detail,
            );
          }
          const actual = await page.evaluate(() => ({
            activation: "DOM click handlers; native pointer dispatch unverified",
            states: [...document.querySelectorAll("[data-relayed-message]")]
              .slice(0, 3)
              .map((e) => e.dataset.relayedMessageState),
            receipts: [...document.querySelectorAll("[data-relayed-message]")]
              .slice(0, 3)
              .map((e) => e.innerText),
            attention: [...document.querySelectorAll("[data-relayed-attention]")].map(
              (e) => e.innerText,
            ),
            metadata: [...document.querySelectorAll("[data-metadata-only-activity]")].map(
              (e) => e.innerText,
            ),
            body: document.body.innerText,
            header: document.querySelector("[data-timeline-detail]").getAttribute("aria-label"),
            overflow: document.documentElement.scrollWidth > innerWidth,
          }));
          assert(!actual.overflow, JSON.stringify(actual));
          assert.equal(actual.states.length, 3);
          assert(
            actual.states.every((s) => s === (detail === "verbose" ? "open" : "folded")),
            JSON.stringify(actual),
          );
          const routine = actual.receipts.join("\n");
          assert.equal(
            routine.includes("8b9b6da6ceccdca502e74454143d114324b36421"),
            detail === "verbose",
          );
          assert.equal(routine.includes("recovery-20261028.json"), detail === "verbose");
          if (view === "coordinator") {
            assert(actual.body.includes("Authentication failed. Please sign in to continue."));
            assert.deepEqual(actual.metadata, ["View activity", "View activity", "View activity"]);
            assert(!actual.body.includes("Worked for"));
            assert.equal(await page.locator(".project-message-assistant").count(), 0);
          } else {
            assert.equal(await page.locator('[data-message-role="assistant"]').count(), 1);
            assert(actual.body.includes("The failing check is preserved."));
          }
          await page.screenshot({
            path: path.join(output, `${view}-${theme}-${detail}.png`),
            fullPage: true,
            timeout: 10000,
          });
          if (detail !== "verbose") {
            const relay = page.locator("[data-relayed-message]").first();
            await relay.locator("h3 button").evaluate((e) => e.click());
            await page.waitForFunction(
              () =>
                document.querySelector("[data-relayed-message]").dataset.relayedMessageState ===
                "open",
            );
            const full = await relay.innerText();
            assert(full.includes("8b9b6da6ceccdca502e74454143d114324b36421"));
            assert(full.includes("No app release dispatch."));
            await relay
              .getByRole("button", { name: "Copy original message", exact: true })
              .evaluate((e) => e.click());
            const copied = await page.evaluate(
              (v) => (v === "coordinator" ? window.__copies : window.__fixture.copies),
              view,
            );
            assert.equal(copied.at(-1), await page.evaluate(() => window.internalReceiptTexts[0]));
            actual.expandedAndCopied = true;
          }
          assert.deepEqual(errors, []);
          checks.push({ view, theme, width, detail, ...actual });
        }
      } catch (error) {
        console.error(error);
        console.error(
          await page.evaluate(() => ({
            url: location.href,
            text: document.body.innerText,
            relays: document.querySelectorAll("[data-relayed-message]").length,
          })),
        );
        throw error;
      } finally {
        await context.tracing.stop({ path: path.join(output, `${view}-${theme}-trace.zip`) });
        await context.close();
      }
    }
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(
      { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never", checks },
      null,
      2,
    ),
  );
}
console.log(`${checks.length}/12 receipt presentation checks passed: ${output}`);

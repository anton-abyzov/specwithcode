import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = resolve(process.argv[2] || ".artifacts/active-project-pickers/evidence");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_TEST_CHROMIUM ? { executablePath: process.env.STUDIO_TEST_CHROMIUM } : {}),
});
const receipts = [];
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"])
      for (const selected of ["", "old", "auto", "scratch", "personal", "inactive-twin"]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const name = `${width}-${theme}-${selected || "active"}`;
        await page.goto(
          `${process.env.PICKER_FIXTURE_URL || "http://127.0.0.1:5873"}/?theme=${theme}&selected=${selected}`,
        );
        if (width > 600)
          await page.getByRole("button", { name: "Filter by project", exact: true }).click();
        else {
          await page.getByRole("button", { name: /^Filters/ }).click();
          await page.getByRole("menuitem", { name: /^Project/ }).click();
        }
        const rows = page.getByRole("menu").last().getByRole("menuitemradio");
        await rows.last().waitFor();
        const labels = await rows.evaluateAll((elements) =>
          elements.map((element) => {
            const copy = element.cloneNode(true);
            copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
            return copy.textContent;
          }),
        );
        console.log(name, JSON.stringify(labels));
        const disabled = await rows.evaluateAll((elements) =>
          elements
            .filter((e) => e.getAttribute("aria-disabled") === "true")
            .map((e) => {
              const copy = e.cloneNode(true);
              copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
              return copy.textContent;
            }),
        );
        const expected = [
          "All projects",
          selected === "inactive-twin" ? "App · Desktop · /work/app" : "App · Desktop",
          "App · Laptop · /work/active",
          "App · Laptop · /work/second",
        ];
        const excludedLabel = {
          old: "Archived",
          auto: "Automated",
          scratch: "No project",
          personal: "Assistant",
          "inactive-twin": "App · Desktop · /work/old",
        }[selected];
        assert.deepEqual(
          labels.map((text) => text.replace(/· Unavailable$/, "").trim()),
          excludedLabel ? [...expected, excludedLabel] : expected,
        );
        assert.equal(disabled.length, selected ? 1 : 0);
        if (selected) {
          assert.ok(disabled[0].startsWith(excludedLabel));
          const before = await page.getByTestId("selected-project").textContent();
          await rows.last().evaluate((element) => element.click());
          assert.equal(await page.getByTestId("selected-project").textContent(), before);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({
          path: resolve(output, `${name}.png`),
          fullPage: true,
          animations: "disabled",
        });
        await page
          .getByRole("menuitemradio", { name: "App · Laptop · /work/second", exact: true })
          .click();
        await page
          .getByTestId("selected-project")
          .filter({ hasText: "machine-a:second" })
          .waitFor();
        assert.deepEqual(errors, []);
        receipts.push({
          name,
          width,
          theme,
          selected,
          labels,
          disabled,
          chose: "machine-a:second",
          screenshot: resolve(output, `${name}.png`),
          pass: true,
        });
        await page.close();
      }
  await writeFile(
    resolve(output, "headless-checks.json"),
    JSON.stringify(
      {
        headless: true,
        PWDEBUG: process.env.PWDEBUG,
        PLAYWRIGHT_HTML_OPEN: process.env.PLAYWRIGHT_HTML_OPEN,
        receipts,
      },
      null,
      2,
    ),
  );
  console.log(`${receipts.length} responsive Code Review picker checks passed`);
} finally {
  await browser.close();
}

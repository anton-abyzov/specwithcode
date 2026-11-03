import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(resolve("apps/server/package.json"));
const { chromium } = require("playwright-core");
const output = resolve(process.argv[2]);
const origin = process.env.FIXTURE_URL ?? "http://127.0.0.1:5892";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1000]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(`${origin}/?theme=${theme}`);
      const updates = page.getByRole("region", { name: "Updates for m1" });
      await updates.getByText("Update permission: Not granted.", { exact: true }).waitFor();
      assert.equal(
        await updates.getByRole("button", { name: "Grant update permission" }).count(),
        0,
      );
      assert.equal(await updates.getByRole("button", { name: "Check for updates" }).count(), 0);
      assert.equal(await page.getByText("Installed unknown", { exact: true }).count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), fullPage: true });
      await updates.getByRole("button", { name: "Refresh status" }).click();
      assert.equal(await page.getByTestId("actions").textContent(), "refresh");
      await page.getByRole("switch", { name: "Connect to m1 from this device" }).click();
      await updates
        .getByText("Machine unreachable. Saved update permission has not changed.", { exact: true })
        .waitFor();
      assert.equal(
        await updates.getByRole("button", { name: "Refresh status" }).isDisabled(),
        true,
      );
      assert.equal(
        await page
          .getByText("Identity verified by the current connection.", { exact: true })
          .count(),
        0,
      );
      checks.push(
        `${theme} ${width}: no overflow; missing permission actions absent; refresh isolated; disconnect removes verification and disables refresh`,
      );
    }
  }
  await page.goto(`${origin}/?theme=dark&approved&admin`);
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  assert.equal(await page.getByTestId("actions").textContent(), "check");
  await page.getByRole("button", { name: "Revoke update permission", exact: true }).click();
  assert.equal(await page.getByTestId("actions").textContent(), "check,revoke");
  await page.goto(`${origin}/?theme=light&admin`);
  await page.getByRole("button", { name: "Grant update permission", exact: true }).click();
  assert.equal(await page.getByTestId("actions").textContent(), "grant");
  assert.equal(
    await page.getByRole("button", { name: "Check for updates", exact: true }).count(),
    0,
  );
  checks.push(
    "Authorized check, revoke and grant actions call only their own handlers; grant does not expose check before enrollment.",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "checks.json"),
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser.close();
}

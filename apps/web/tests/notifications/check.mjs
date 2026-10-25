// Standalone CI entrypoint. Agent verification can use SpecWithCode's headless preview instead.
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/notifications/vite.config.ts
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const require = createRequire(new URL("../../../../apps/desktop/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const out = resolve(process.argv[2] ?? ".artifacts/notifications/evidence");
await mkdir(out, { recursive: true });
const server = spawn(
  "python3",
  [
    "-m",
    "http.server",
    "4397",
    "--bind",
    "127.0.0.1",
    "--directory",
    ".artifacts/notifications/site",
  ],
  { stdio: "ignore" },
);
let browser;
const results = [];
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:4397");
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
      : {}),
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const scenario of ["browser", "denied", "unsupported", "native", "native-refused"]) {
    await page.goto(`http://127.0.0.1:4397/?scenario=${scenario}`);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const connect = page.getByRole("button", { name: "Connect notifications" });
    if (scenario === "unsupported") {
      assert.equal(await connect.isDisabled(), true);
      results.push({ scenario, pass: true });
      continue;
    }
    await connect.click();
    if (scenario === "denied") {
      await page.getByRole("status").filter({ hasText: "Permission blocked" }).waitFor();
      assert.notEqual(
        await page.evaluate(() => localStorage.getItem("specwithcode.notifications.connection.v1")),
        "connected",
      );
    } else {
      await page.getByRole("button", { name: "Disconnect" }).waitFor();
      await page.getByRole("button", { name: "Send test" }).click();
      if (scenario === "native-refused")
        await page.getByRole("status").filter({ hasText: "not accepted" }).waitFor();
      if (scenario === "browser") {
        await page.evaluate(() => window.notificationFixture.revoke());
        assert.equal(await page.getByRole("button", { name: "Send test" }).isDisabled(), true);
      }
      for (const [width, height] of [
        [1440, 900],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        await page.screenshot({ path: resolve(out, `${scenario}-${width}.png`), fullPage: true });
      }
      await page.getByRole("button", { name: "Disconnect" }).click();
      assert.equal(
        await page.evaluate(() => localStorage.getItem("specwithcode.notifications.connection.v1")),
        "disconnected",
      );
    }
    results.push({ scenario, pass: true });
  }
  await writeFile(
    resolve(out, "receipt.json"),
    JSON.stringify({ headless: true, results }, null, 2),
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}

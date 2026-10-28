import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    path.join(
      os.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const site = fileURLToPath(
  new URL("../../../../.artifacts/workspace-lifecycle/site", import.meta.url),
);
const output = path.resolve(process.argv[2]);
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://fixture").pathname;
  const file = path.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${site}${path.sep}`)) return response.writeHead(403).end();
  try {
    const contents = await fs.readFile(file);
    response.writeHead(200, {
      "Content-Type":
        { ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] ?? "text/html",
    });
    response.end(contents);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const receipt = {
  headless: true,
  scope: "Synthetic state with real storage and per-chat controls; fixture-only row layout",
  cases: [],
};
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const theme of ["light", "dark"])
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.getByRole("checkbox", { name: "Use worktree" }).uncheck();
      await page.getByText("Current checkout", { exact: true }).waitFor();
      assert.equal(await page.getByRole("checkbox", { name: "Use worktree" }).isChecked(), false);
      await page.getByRole("combobox", { name: "Worktree storage" }).click();
      await page.getByRole("option", { name: "Inside project", exact: true }).click();
      await page
        .getByRole("option", { name: "Inside project", exact: true })
        .waitFor({ state: "hidden" });
      await page
        .getByText("New worktrees: /Users/example/projects/river/.specwithcode/worktrees", {
          exact: true,
        })
        .waitFor();
      await page.screenshot({
        path: path.join(output, `${theme}-${width}-project.png`),
        fullPage: true,
      });
      await page.getByRole("combobox", { name: "Worktree storage" }).click();
      await page.getByRole("option", { name: "Custom folder", exact: true }).click();
      await page
        .getByRole("textbox", { name: "Worktree location" })
        .fill("/Volumes/Builds/worktrees");
      await page.getByRole("textbox", { name: "Worktree location" }).blur();
      await page.getByText("New worktrees: /Volumes/Builds/worktrees", { exact: true }).waitFor();
      await page.screenshot({
        path: path.join(output, `${theme}-${width}-custom.png`),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      receipt.cases.push({
        theme,
        width,
        optOut: true,
        projectPath: true,
        customPath: true,
        noOverflow: true,
      });
      await page.close();
    }
  const page = await browser.newPage();
  await page.goto(`${origin}/?legacy=1`);
  await page.getByRole("textbox", { name: "Worktree location" }).waitFor();
  assert.equal(
    await page.getByRole("textbox", { name: "Worktree location" }).inputValue(),
    "/Volumes/Workspace/worktrees",
  );
  receipt.legacyCustom = true;
  await page.close();
  await fs.writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

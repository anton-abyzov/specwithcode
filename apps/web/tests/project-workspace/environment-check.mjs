// Actual production components with explicitly mocked host operations. No provider execution.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR;
assert(output, "Use a new explicit evidence directory");
await fs.mkdir(output, { recursive: false });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
const errors = [],
  checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:5788/?personal=1");
  await page.locator(".sws-tag", { hasText: /^Personal assistant:/ }).waitFor();
  checks.push("Personal assistant uses the existing workspace surface");
  await page.getByLabel("Project settings", { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Environment", exact: true }).click();
  await dialog.getByText("Managed project storage", { exact: true }).waitFor();
  assert(await dialog.getByText("/scratch/research", { exact: true }).isVisible());
  assert(
    await dialog.getByText("https://github.com/example/atlas.git", { exact: true }).isVisible(),
  );
  checks.push("Execution storage, approved folder and repository coexist");
  await dialog
    .getByRole("textbox", { name: /^Repository URL/ })
    .fill("https://secret@example.com/team/repo.git");
  assert(await dialog.getByRole("button", { name: "Add URL", exact: true }).isDisabled());
  await dialog
    .getByRole("textbox", { name: /^Repository URL/ })
    .fill("git@github.com:example/research.git");
  await dialog.getByRole("button", { name: "Add URL", exact: true }).click();
  await dialog.getByRole("textbox", { name: /^Folder path/ }).fill("/scratch/notes");
  await dialog.getByRole("button", { name: "Add folder", exact: true }).click();
  assert(
    await dialog
      .getByRole("button", { name: "Prepare checkout", exact: true })
      .first()
      .isDisabled(),
  );
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  const save = (await page.evaluate(() => window.__projectCalls)).find(
    (c) => c.command === "update",
  );
  assert.equal(save.args.environmentId, "host");
  assert.equal(save.args.input.workspaceSettings.expectedRevision, 7);
  assert.deepEqual(save.args.input.workspaceSettings.environment.additionalFolders, [
    "/scratch/research",
    "/scratch/notes",
  ]);
  assert.equal(save.args.input.workspaceSettings.environment.repositories.length, 2);
  checks.push("Invalid URL refused; combined environment draft saves with revision and host");
  await dialog
    .getByRole("button", { name: "Match existing checkout", exact: true })
    .first()
    .click();
  const match = (await page.evaluate(() => window.__projectCalls)).find(
    (c) => c.command === "environmentPrepare",
  );
  assert.equal(match.args.input.mode, "match");
  assert.equal(match.args.input.expectedRevision, 8);
  checks.push("Existing checkout matching is an explicit scoped request");
  await dialog.getByRole("textbox", { name: /^Connection name/ }).fill("Document tools");
  await dialog.getByRole("textbox", { name: /^Executable command/ }).fill("document-mcp");
  await dialog
    .getByRole("textbox", { name: /^Arguments \(one per line\)/ })
    .fill("--stdio\n--readonly");
  await dialog
    .getByRole("textbox", { name: /^Host environment variable names \(one per line\)/ })
    .fill("PROFILE_NAME");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  let calls = await page.evaluate(() => window.__projectCalls);
  assert.equal(calls.filter((c) => c.command === "connectionCheck").length, 0);
  const conn = calls.find((c) => c.command === "connectionSave");
  assert.deepEqual(conn.args.input.config.args, ["--stdio", "--readonly"]);
  assert.deepEqual(conn.args.input.config.envKeys, ["PROFILE_NAME"]);
  checks.push("Connection save persists only named host references and does not launch tools");
  await dialog.getByRole("button", { name: "Check and discover tools", exact: true }).click();
  await dialog.getByText("Status: ready", { exact: false }).waitFor();
  await dialog.getByRole("checkbox", { name: /search_documents/ }).check();
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  calls = await page.evaluate(() => window.__projectCalls);
  assert.deepEqual(
    calls.filter((c) => c.command === "connectionSave").at(-1).args.input.allowedTools,
    ["search_documents"],
  );
  checks.push("Discovered tool access requires an explicit saved allowlist");
  await dialog.getByRole("button", { name: "Revoke connection", exact: true }).click();
  await dialog.getByText("Status: revoked", { exact: false }).waitFor();
  assert(
    await dialog
      .getByRole("button", { name: "Check and discover tools", exact: true })
      .isDisabled(),
  );
  checks.push("Revoked connection disables checks until deliberately reconfigured");
  const screenshots = [];
  for (const width of [1440, 768, 390])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.evaluate(
        (theme) => document.documentElement.classList.toggle("dark", theme === "dark"),
        theme,
      );
      await dialog
        .getByRole("heading", { name: "Environment", exact: true })
        .scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      const bounds = await dialog.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      const filename = `environment-${width}-${theme}.png`;
      await page.screenshot({ path: `${output}/${filename}`, animations: "disabled" });
      screenshots.push(filename);
      await dialog
        .getByRole("heading", { name: "Connections", exact: true })
        .scrollIntoViewIfNeeded();
      const connectionsFile = `connections-${width}-${theme}.png`;
      await page.screenshot({ path: `${output}/${connectionsFile}`, animations: "disabled" });
      screenshots.push(connectionsFile);
      await dialog
        .getByRole("button", { name: "Restore configuration", exact: true })
        .scrollIntoViewIfNeeded();
      const controlsFile = `connection-controls-${width}-${theme}.png`;
      await page.screenshot({ path: `${output}/${controlsFile}`, animations: "disabled" });
      screenshots.push(controlsFile);
    }
  checks.push("390/768/1440 light and dark settings stay within viewport bounds");
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `${output}/receipt.json`,
    JSON.stringify(
      {
        scope: "Production UI and CSS with synthetic host-operation fixtures; no native execution",
        headless: true,
        checks,
        screenshots,
        errors,
        calls: await page.evaluate(() => window.__projectCalls),
      },
      null,
      2,
    ),
  );
  console.log(
    `${checks.length} environment UI checks passed; ${screenshots.length} screenshots saved`,
  );
} finally {
  await browser.close();
}

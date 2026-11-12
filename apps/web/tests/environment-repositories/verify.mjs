// Build with vp build --config apps/web/tests/environment-repositories/vite.config.ts first.
// Usage: node apps/web/tests/environment-repositories/verify.mjs /absolute/owned/report-dir
// Optional STUDIO_PLAYWRIGHT_MODULE and STUDIO_CHROMIUM_EXECUTABLE point at an installed runtime.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const assert = NodeAssert.default;
const fs = NodeFSP;
const http = NodeHttp;
const path = NodePath;
const { createRequire } = NodeModule;
const { pathToFileURL } = NodeURL;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
// playwright-core is a dependency of apps/server, not of the web app.
const require = createRequire(new URL("../../../server/package.json", import.meta.url));
const playwrightEntry = process.env.STUDIO_PLAYWRIGHT_MODULE ?? require.resolve("playwright-core");
const playwright = await import(pathToFileURL(playwrightEntry).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const root = path.resolve(".artifacts/environment-repositories/site");
const output = path.resolve(process.argv[2] ?? ".artifacts/environment-repositories/evidence");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await fs.readFile(file));
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
const receipt = { headless: true, checks: [], screenshots: [] };
const open = async (theme, width, query) => {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?theme=${theme}&${query}`);
  await page.locator("[data-case]").waitFor();
  return { page, errors };
};
const noOverflow = async (page, width, label) => {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scroll <= width, `${label}: no horizontal overflow (${scroll} > ${width})`);
};
const shot = async (page, name) => {
  const file = path.join(output, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  receipt.screenshots.push(file);
};
try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      // The umbrella: a read-only list, the thread and the composer.
      const { page, errors } = await open(theme, width, "case=umbrella");
      const environment = page.locator('[data-section="environment"]');
      const text = (await environment.textContent()) ?? "";
      assert.ok(
        text.includes(
          "This folder holds 7 Git repositories. Threads can use any of them. The agent picks the ones a task changes, and the thread gets its own worktree of only those.",
        ),
      );
      assert.equal(await environment.locator("[data-repository-state]").count(), 7);
      assert.deepEqual(
        [...new Set(await environment.locator(".project-repository-status").allTextContents())],
        ["Available"],
      );
      assert.equal(await environment.locator(".project-repository-tag").count(), 3);
      assert.ok(text.includes("no branch checked out · 2 thread worktrees"));
      assert.ok(text.includes("no remote, so no pull request"));
      assert.ok(text.includes("Skipped: app-studio is a link to app-dev."));
      assert.ok(text.includes("2 saved entries from before are no longer needed"));
      assert.ok(text.includes("Other folders agents can use"));
      assert.ok(text.includes("Already inside the project folder, so this entry does nothing."));
      for (const gone of [
        "workspace",
        "Workspace",
        "Checkout status unknown",
        "Checkout: mismatch",
        "Match existing checkout",
        "Prepare checkout",
        "Preview import",
        "Leave empty for a managed checkout",
      ])
        assert.ok(!text.includes(gone), `"${gone}" is gone from the Environment page`);
      assert.equal(await environment.locator('input[type="checkbox"]').count(), 0);
      // Clone and URL controls are closed until asked for.
      assert.equal(await environment.locator("details.project-repository-add[open]").count(), 0);
      // Removing redundant entries is the person's click.
      await environment.getByRole("button", { name: "Remove both" }).click();
      assert.equal(await environment.locator("[data-redundant-entries]").count(), 0);
      // The thread: count, popover rows and timeline rows.
      const thread = page.locator('[data-section="thread"]');
      assert.equal(
        await thread.locator("[data-thread-label]").textContent(),
        "fix/environment-list · 2 repositories",
      );
      const popover = (await thread.locator("[data-thread-popover]").textContent()) ?? "";
      for (const expected of [
        "worktree from origin/main · dependencies installed",
        "worktree from home-animated-story · dependencies not installed",
        "Changed",
        "No changes",
        "#190",
        "One pull request per repository with commits.",
        "Add repository",
      ])
        assert.ok(popover.includes(expected), `thread popover shows "${expected}"`);
      assert.deepEqual(await thread.locator("[data-thread-timeline] li").allTextContents(), [
        "Started in its own folder with no repository. The agent reads the project folder and adds a repository before changing it.",
        "Agent added app-dev Worktree on fix/environment-list from origin/main. Dependencies installed.",
        "You added cli Worktree on fix/environment-list from home-animated-story. Dependencies not installed.",
      ]);
      await thread.locator("[data-thread-repositories-chip]").click();
      await page.getByRole("button", { name: "Add repository" }).first().waitFor();
      await shot(page, `environment-repositories-thread-${theme}-${width}`);
      await page.keyboard.press("Escape");
      // The composer: the agent decides until a repository is checked.
      const composer = page.locator('[data-section="composer"]');
      const control = composer.locator("[data-composer-repositories]");
      assert.equal((await control.textContent())?.trim(), "Repositories: Agent decides▾");
      await control.click();
      const options = page.getByRole("group", { name: "Repositories" });
      assert.equal(await options.getByRole("checkbox").count(), 7);
      assert.equal(await options.getByRole("combobox").count(), 0);
      await options.getByRole("checkbox", { name: "cli" }).check();
      // Exactly one picked: its branches, starting at its current branch.
      const base = options.getByRole("combobox", { name: "Base branch of cli" });
      assert.equal(await base.inputValue(), "home-animated-story");
      await shot(page, `environment-repositories-composer-${theme}-${width}`);
      await options.getByRole("checkbox", { name: "skills", exact: true }).check();
      assert.equal(await options.getByRole("combobox").count(), 0);
      assert.deepEqual(
        JSON.parse(await composer.locator("[data-pick]").getAttribute("data-pick")),
        {
          repositories: ["repositories/acme/cli", "repositories/acme/skills"],
          baseBranch: null,
        },
      );
      await page.keyboard.press("Escape");
      await noOverflow(page, width, `umbrella ${theme}`);
      assert.deepEqual(errors, []);
      await shot(page, `environment-repositories-${theme}-${width}`);
      await page.close();

      // Where something does need cloning.
      const clone = await open(theme, width, "case=clone&worktrees=off");
      const cloneText =
        (await clone.page.locator('[data-section="environment"]').textContent()) ?? "";
      assert.deepEqual(await clone.page.locator(".project-repository-status").allTextContents(), [
        "Available",
        "Not on this machine",
        "Folder missing",
      ]);
      assert.ok(
        cloneText.includes(
          "SpecWeave lists it at repositories/acme/skills-platform. Clone puts it there.",
        ),
      );
      for (const name of [
        "Clone skills-platform",
        "Clone archive again",
        "Remove archive from project",
      ])
        assert.equal(await clone.page.getByRole("button", { name, exact: true }).count(), 1);
      assert.ok(
        cloneText.includes(
          "Use worktrees is off for this project, so threads work in the project folder.",
        ),
      );
      await clone.page.getByRole("button", { name: "Open General" }).click();
      assert.equal(await clone.page.locator("[data-opened-general]").count(), 1);
      await clone.page.getByText("Add a repository that is not in this folder").click();
      await clone.page.getByLabel("Git URL").fill("https://github.com/acme/tool.git");
      assert.equal(
        await clone.page.getByLabel("Folder", { exact: true }).inputValue(),
        "repositories/acme/tool",
      );
      await noOverflow(clone.page, width, `clone ${theme}`);
      assert.deepEqual(clone.errors, []);
      await shot(clone.page, `environment-repositories-clone-${theme}-${width}`);
      await clone.page.close();

      // One repository, and an older server.
      const single = await open(theme, width, "case=single");
      const singleText =
        (await single.page.locator('[data-section="environment"]').textContent()) ?? "";
      assert.ok(singleText.includes("This project is one Git repository: the project folder."));
      assert.equal(await single.page.locator("[data-repository-state]").count(), 0);
      assert.equal(await single.page.locator("details.project-repository-add[open]").count(), 0);
      await noOverflow(single.page, width, `single ${theme}`);
      await single.page.close();
      const older = await open(theme, width, "case=older");
      assert.ok(
        ((await older.page.locator("[data-older-server]").textContent()) ?? "").includes(
          "Update SpecWithCode on This Mac (M4) to find the repositories in this folder.",
        ),
      );
      await noOverflow(older.page, width, `older ${theme}`);
      await older.page.close();
      receipt.checks.push({ theme, width, pass: true });
    }
  }
} finally {
  await browser.close();
  server.close();
}
await fs.writeFile(
  path.join(output, "environment-repositories-receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
  JSON.stringify({ checks: receipt.checks, screenshots: receipt.screenshots.length }, null, 2),
);

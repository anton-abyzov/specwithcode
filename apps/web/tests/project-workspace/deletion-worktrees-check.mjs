// Run against serve.mjs. The project's worktrees and their removal are in-memory fixtures;
// the real reading and guarded removal are covered by apps/server/src/project/ProjectWorktreeCleanup.test.ts.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
import assert from "node:assert/strict";
import fs from "node:fs/promises";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const output = process.env.UI_EVIDENCE_DIR ?? "/tmp/project-deletion-worktrees";
const port = process.env.PROJECT_UI_PORT ?? "5788";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
try {
  for (const [label, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${port}`);
      await page.waitForLoadState("networkidle");
      if (dark) await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.getByLabel("Project settings", { exact: true }).dispatchEvent("click");
      await page.getByRole("dialog").waitFor();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "General", exact: true })
        .dispatchEvent("click");
      const calls = () => page.evaluate(() => window.__projectCalls);
      assert.equal((await calls()).filter((c) => c.command === "worktreesRead").length, 0);
      const confirmation = page.getByLabel("Confirm project deletion");
      // CDP keyboard and pointer input stall the local headless shell; set the value as React reads it.
      await confirmation.evaluate((node) => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setValue.call(node, "Atlas Studio");
        node.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const section = page.getByTestId("project-deletion-worktrees");
      await section.waitFor();
      const text = await section.innerText();
      assert.match(text, /Also delete 2 worktrees \(12\.0 GB\)/);
      assert.match(text, /1 worktree has commits that exist only on this machine/);
      assert.match(
        text,
        /Also delete 1 worktree \(1\.1 GB\) with uncommitted files\. Those files are lost\./,
      );
      assert.match(text, /1 worktree will be kept/);
      const clean = page.locator(`[role="checkbox"][aria-label="Also delete clean worktrees"]`);
      const dirty = page.locator(
        `[role="checkbox"][aria-label="Also delete worktrees with uncommitted files"]`,
      );
      assert.equal(await clean.getAttribute("aria-checked"), "true");
      assert.equal(await dirty.getAttribute("aria-checked"), "false");
      // Nothing in the section spills past the dialog.
      const overflow = await section.evaluate((node) => {
        const dialog = node.closest('[role="dialog"]').getBoundingClientRect();
        return [...node.querySelectorAll("*")].some((child) => {
          const box = child.getBoundingClientRect();
          return box.width > 0 && (box.left < dialog.left - 1 || box.right > dialog.right + 1);
        });
      });
      assert.equal(overflow, false, "worktree section overflows the dialog");
      await section.evaluate((node) => node.scrollIntoView({ block: "center" }));
      await page.screenshot({
        path: `${output}/deletion-worktrees-${label}-${dark ? "dark" : "light"}.png`,
        animations: "disabled",
      });
      if (label === "desktop" && !dark) {
        await dirty.dispatchEvent("click");
        await page
          .getByRole("button", { name: "Delete project and threads" })
          .dispatchEvent("click");
        await page.waitForFunction(() =>
          window.__projectCalls.some((c) => c.command === "worktreesRemove"),
        );
        const all = await calls();
        const remove = all.find((c) => c.command === "worktreesRemove");
        const deleteIndex = all.findIndex((c) => c.command === "delete");
        assert(deleteIndex >= 0 && deleteIndex < all.indexOf(remove), "removal before delete");
        assert.deepEqual(remove.args.input.discardLocalChanges, [
          "/Users/me/.specwithcode/worktrees/atlas/release-notes",
        ]);
        assert.equal(remove.args.input.paths.length, 3);
        assert(!remove.args.input.paths.some((p) => p.endsWith("shared-docs")));
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  }
  console.log(`deletion worktrees check passed; screenshots in ${output}`);
} finally {
  await browser.close();
}

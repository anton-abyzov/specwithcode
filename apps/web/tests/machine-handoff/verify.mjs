import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const root = NodePath.resolve(
  option(
    "--root",
    NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../.."),
  ),
);
const site = NodePath.join(root, ".artifacts/machine-handoff/site");
const output = NodePath.resolve(
  option("--output", NodePath.join(root, ".artifacts/machine-handoff/evidence")),
);
await NodeFSP.mkdir(output, { recursive: true });
const receiptPath = NodePath.join(output, "receipt.json");
try {
  await NodeFSP.access(receiptPath);
  throw new Error("Evidence exists; select a fresh output directory");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const hash = async (file) =>
  NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(file))
    .digest("hex");
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${site}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime =
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        NodePath.extname(file)
      ] ?? "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const receipt = {
  startedAt: new Date().toISOString(),
  headless: true,
  scope:
    "Actual MachineHandoffDialog in isolated fixture; no providers, live services, or account changes",
  root,
  componentSha256: await hash(
    NodePath.join(root, "apps/web/src/components/studio/MachineHandoffDialog.tsx"),
  ),
  fixtureSha256: await hash(NodePath.join(root, "apps/web/tests/machine-handoff/main.tsx")),
  siteIndexSha256: await hash(NodePath.join(site, "index.html")),
  cases: [],
};
let browser;
let activePage;
let completed = false;
async function layout(page, dialog, label) {
  const observed = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom },
      horizontalPageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      horizontalDialogOverflow: element.scrollWidth > element.clientWidth + 1,
    };
  });
  NodeAssert.equal(observed.horizontalPageOverflow, false, `${label}: page overflow`);
  NodeAssert.equal(observed.horizontalDialogOverflow, false, `${label}: dialog overflow`);
  NodeAssert.ok(
    observed.dialog.x >= -1 && observed.dialog.right <= observed.viewport.width + 1,
    `${label}: horizontal bounds`,
  );
  NodeAssert.ok(
    observed.dialog.y >= -1 && observed.dialog.bottom <= observed.viewport.height + 1,
    `${label}: vertical bounds`,
  );
  return observed;
}
async function screenshot(page, name) {
  const file = NodePath.join(output, `${name}.png`);
  try {
    await NodeFSP.access(file);
    throw new Error(`Screenshot exists: ${name}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });
  for (const [width, height, theme] of [
    [1280, 900, "light"],
    [390, 844, "light"],
    [1280, 900, "dark"],
    [390, 844, "dark"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: "en-US",
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    activePage = page;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin) ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?theme=${theme}`, { waitUntil: "networkidle" });
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    NodeAssert.ok(await dialog.getByRole("heading", { name: "Hand off EasyChamp" }).isVisible());
    NodeAssert.ok(
      await dialog
        .getByText(
          "From MacBook Pro M4 to another machine. Nothing there is replaced without asking.",
        )
        .isVisible(),
    );
    NodeAssert.equal(
      await dialog
        .getByRole("group", { name: "What to do" })
        .locator('button[aria-pressed="true"]')
        .textContent(),
      "Hand off and continue there",
    );
    const m1 = dialog.getByRole("radio", { name: /Mac mini M1/ });
    const m3 = dialog.getByRole("radio", { name: /MacBook Air M3/ });
    const offline = dialog.getByRole("radio", { name: /Offline machine/ });
    NodeAssert.equal(await m1.isChecked(), true);
    NodeAssert.equal(await offline.isDisabled(), true);
    NodeAssert.ok(await dialog.getByText("Connect this machine first.").isVisible());
    await m1.focus();
    await m1.press("ArrowDown");
    NodeAssert.equal(await m3.isChecked(), true, "radio keyboard navigation picks M3");
    await m3.press("ArrowDown");
    NodeAssert.equal(await m1.isChecked(), true, "radio keyboard navigation skips offline target");
    await m3.check();
    NodeAssert.equal(await m3.isChecked(), true);
    const folder = dialog.getByRole("textbox", { name: "Folder on MacBook Air M3" });
    NodeAssert.equal(await folder.inputValue(), "/Users/you/Projects/sw-easychamp");
    NodeAssert.equal(await folder.getAttribute("readonly"), "", "a saved folder is read-only");
    NodeAssert.equal(
      await dialog.getByRole("button", { name: "Cancel", exact: true }).isEnabled(),
      true,
    );
    const layouts = { choose: await layout(page, dialog, "choose") };
    const screenshots = { choose: await screenshot(page, `${width}-${theme}-choose`) };
    await dialog.getByRole("button", { name: "Hand off to MacBook Air M3", exact: true }).focus();
    await page.keyboard.press("Enter");
    const review = dialog.locator('[data-slot="handoff-git-review"]');
    await review.waitFor();
    const continuation = dialog.getByRole("button", {
      name: "Hand off to MacBook Air M3",
      exact: true,
    });
    NodeAssert.equal(await continuation.isDisabled(), true, "publishing needs explicit consent");
    NodeAssert.equal(await m1.count(), 0, "review hides the machine choice");
    NodeAssert.match(await review.innerText(), /MacBook Pro M4\s*MacBook Air M3/);
    NodeAssert.ok(
      await dialog
        .getByText(
          "3 repositories, 18 messages. Committed work only. Uncommitted files, sign-ins and running processes stay here.",
        )
        .isVisible(),
    );
    // Back discards the preview and brings the choices back.
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await m3.waitFor();
    NodeAssert.equal(await m3.isChecked(), true, "Back keeps the chosen machine");
    await dialog.getByRole("button", { name: "Hand off to MacBook Air M3", exact: true }).click();
    await review.waitFor();
    const details = dialog.locator('[data-slot="handoff-commits"]');
    const summary = details.getByRole("button", { name: "Details" });
    NodeAssert.equal(await summary.getAttribute("aria-expanded"), "false");
    layouts.review = await layout(page, dialog, "review");
    screenshots.review = await screenshot(page, `${width}-${theme}-review`);
    await summary.focus();
    await summary.press("Enter");
    NodeAssert.equal(
      await summary.getAttribute("aria-expanded"),
      "true",
      "commit list is keyboard expandable",
    );
    NodeAssert.deepEqual(await details.locator("code").allTextContents(), [
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
      "cccccccccccc",
    ]);
    NodeAssert.ok(
      await details
        .getByText("repositories/anton-abyzov/easychamp-football", { exact: true })
        .isVisible(),
    );
    layouts.expanded = await layout(page, dialog, "expanded");
    await details.scrollIntoViewIfNeeded();
    screenshots.expanded = await screenshot(page, `${width}-${theme}-expanded`);
    const consent = dialog.getByRole("checkbox", {
      name: "Push these commits to their remotes and continue the project on MacBook Air M3.",
    });
    await consent.focus();
    await consent.press("Space");
    NodeAssert.equal(await consent.isChecked(), true);
    NodeAssert.equal(await continuation.isEnabled(), true);
    const focusTrace = [];
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press("Tab");
      // Base UI redirects its temporary focus guards on the next frame.
      await page.waitForFunction(
        () => !!document.activeElement?.closest('[role="dialog"]'),
        undefined,
        { timeout: 1000 },
      );
      const focus = await page.evaluate(() => ({
        insideDialog: !!document.activeElement?.closest('[role="dialog"]'),
        tag: document.activeElement?.tagName,
        label:
          document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.textContent?.trim().slice(0, 80),
      }));
      NodeAssert.equal(focus.insideDialog, true, "keyboard focus remains inside modal");
      focusTrace.push(focus);
    }
    await continuation.focus();
    await page.keyboard.press("Enter");
    await dialog.getByRole("heading", { name: "EasyChamp is on MacBook Air M3" }).waitFor();
    NodeAssert.ok(
      await dialog.getByText("The coordinator now runs on MacBook Air M3.").isVisible(),
    );
    NodeAssert.ok(await dialog.getByRole("status").isVisible());
    NodeAssert.equal(
      await dialog.locator('[data-slot="handoff-remember-machine"]').count(),
      0,
      "the machine is remembered without asking",
    );
    const open = dialog.getByRole("button", {
      name: "Open on MacBook Air M3",
      exact: true,
    });
    NodeAssert.equal(await open.isEnabled(), true);
    layouts.complete = await layout(page, dialog, "complete");
    screenshots.complete = await screenshot(page, `${width}-${theme}-complete`);
    await open.focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("status", { name: "" })
      .filter({ hasText: "Destination coordinator opened" })
      .waitFor();
    await dialog.waitFor({ state: "detached" });
    NodeAssert.equal(await dialog.count(), 0);
    await page.goto(`${origin}/?theme=${theme}&error=1`, { waitUntil: "networkidle" });
    const errorDialog = page.getByRole("dialog");
    const alert = errorDialog.getByRole("alert");
    await alert.scrollIntoViewIfNeeded();
    NodeAssert.equal(
      await alert.innerText(),
      "The destination checkout has local changes. Commit or save them, then try the move again.",
    );
    NodeAssert.equal(
      await alert.evaluate(
        (element) =>
          element.scrollWidth <= element.clientWidth + 1 &&
          element.scrollHeight <= element.clientHeight + 1,
      ),
      true,
      "full error text remains readable",
    );
    layouts.error = await layout(page, errorDialog, "error");
    screenshots.error = await screenshot(page, `${width}-${theme}-error`);
    await page.keyboard.press("Escape");
    await errorDialog.waitFor({ state: "detached" });
    NodeAssert.deepEqual(errors, [], "browser page errors");
    receipt.cases.push({
      width,
      height,
      theme,
      screenshots,
      layouts,
      focusTrace,
      errors,
      checks:
        "Move title and helper, machine keyboard selection, disabled offline target, read-only saved folder, review on its own screen with Back, commit Details disclosure, explicit push consent, modal focus trap, Done title and Open action, full error, viewport bounds, Escape close",
    });
    await context.close();
    activePage = undefined;
  }
  completed = true;
} catch (error) {
  receipt.error = String(error.stack ?? error);
  if (activePage)
    receipt.failureScreenshot = await screenshot(activePage, "failure").catch(() => null);
  throw error;
} finally {
  receipt.completedAt = new Date().toISOString();
  receipt.result = completed ? "passed" : "failed";
  await NodeFSP.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  console.log(
    JSON.stringify({ result: receipt.result, cases: receipt.cases.length, receipt: receiptPath }),
  );
}

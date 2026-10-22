import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = process.cwd();
const site = NodePath.join(root, ".artifacts/folder-copy/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/folder-copy/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const server = NodeHttp.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return response.writeHead(403).end();
    response.writeHead(200, {
      "Content-Type":
        { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
          NodePath.extname(file)
        ] ?? "text/html",
    });
    response.end(await NodeFSP.readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const receipt = {
  headless: true,
  source:
    "Real MachineHandoffDialog and HandoffFolderCopy; synthetic RPC only, not live Ministorm UI or provider activity",
  cases: [],
};
try {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
    { width: 1280, height: 540 },
  ]) {
    for (const theme of ["light", "dark"]) {
      const label = `${theme}-${viewport.width}x${viewport.height}`;
      const page = await browser.newPage({ viewport });
      const errors = [];
      const stages = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const action = (name) => page.getByRole("button", { name, exact: true });
      const assertAction = async (name, disabled = false) => {
        const button = action(name);
        await button.waitFor();
        NodeAssert.equal(await button.count(), 1, `${label}: one ${name} action`);
        const bounds = await button.boundingBox();
        NodeAssert.ok(
          bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
          `${label}: ${name} is visible without scrolling`,
        );
        NodeAssert.ok(
          bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
          `${label}: ${name} fits horizontally`,
        );
        NodeAssert.equal(await button.isDisabled(), disabled, `${label}: ${name} disabled state`);
        NodeAssert.ok(
          await button.evaluate(
            (element) =>
              !!element.closest('[data-slot="dialog-footer"]') &&
              !element.closest('[data-slot="scroll-area-viewport"]'),
          ),
          `${label}: ${name} belongs to the non-scrolling footer`,
        );
        const overflow = await page.locator('[data-slot="dialog-popup"]').evaluate((element) => ({
          page: document.documentElement.scrollWidth > window.innerWidth,
          popup: element.scrollWidth > element.clientWidth,
          footer:
            element.querySelector('[data-slot="dialog-footer"]').scrollWidth >
            element.querySelector('[data-slot="dialog-footer"]').clientWidth,
        }));
        NodeAssert.deepEqual(
          overflow,
          { page: false, popup: false, footer: false },
          `${label}: overflow`,
        );
      };
      const capture = async (stage, name, disabled = false) => {
        await assertAction(name, disabled);
        await page.screenshot({
          path: NodePath.join(output, `${label}-${stage}.png`),
          fullPage: true,
        });
        stages.push({ stage, action: name, disabled, footerVisible: true });
      };
      const pause = (name) =>
        page.evaluate((name) => window.__folderCopyFixture.pauseNext(name), name);
      const release = (name) =>
        page.evaluate((name) => window.__folderCopyFixture.release(name), name);
      await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
      await page.waitForLoadState("networkidle");
      await page.getByRole("textbox", { name: "Folder on ministorm" }).waitFor();
      NodeAssert.equal(
        await page.getByRole("textbox", { name: "Folder on ministorm" }).inputValue(),
        "/home/anton/Projects/github/specweave-umb",
      );
      await capture("setup", "Measure the folder");
      const scopes = page.getByRole("radiogroup", { name: "Source folder" });
      NodeAssert.match(
        await scopes.locator('[aria-checked="true"]').locator("..").locator("..").textContent(),
        /Whole umbrella.*recommended/,
      );
      await scopes.scrollIntoViewIfNeeded();
      await page.getByText("Included repositories (4)", { exact: true }).click();
      await page
        .locator('[data-slot="copy-source-folder"]')
        .evaluate((element) => element.scrollIntoView({ block: "start" }));
      await capture("umbrella-scope", "Measure the folder");
      await scopes.locator("label").filter({ hasText: "This project folder only" }).click();
      NodeAssert.equal(
        await page.getByRole("textbox", { name: "Folder on ministorm" }).inputValue(),
        "/home/anton/Projects/github/specweave-umb/repositories/anton-abyzov/specweave",
      );
      await capture("child-scope", "Measure the folder");
      await scopes.locator("label").filter({ hasText: "Whole umbrella" }).click();
      await page.locator('[data-slot="copy-destination-project"]').scrollIntoViewIfNeeded();
      NodeAssert.match(
        await page.locator('[data-slot="copy-destination-project"]').textContent(),
        /specweave-umb\/repositories\/anton-abyzov\/specweave/,
      );
      await capture("destination-mapping", "Measure the folder");

      const footer = page.locator('[data-slot="dialog-footer"]');
      const beforeScroll = await footer.boundingBox();
      const scroll = await page.locator('[data-slot="dialog-panel"]').evaluate((element) => {
        const viewport = element.parentElement;
        viewport.scrollTop = viewport.scrollHeight;
        return {
          scrollTop: viewport.scrollTop,
          maximum: viewport.scrollHeight - viewport.clientHeight,
        };
      });
      NodeAssert.ok(scroll.maximum > 0 && scroll.scrollTop > 0, `${label}: body really scrolls`);
      await capture("scrolled", "Measure the folder");
      const afterScroll = await footer.boundingBox();
      NodeAssert.equal(afterScroll.y, beforeScroll.y, `${label}: scrolling does not move footer`);
      await page
        .locator("label")
        .filter({ hasText: "Copy and transfer coordinator context" })
        .click();
      await pause("copyOffer");
      await action("Measure the folder").focus();
      await page.keyboard.press("Enter");
      await capture("measuring", "Measuring the folder…", true);
      NodeAssert.ok(await action("Close").isDisabled());
      await page.keyboard.press("Escape");
      await action("Measuring the folder…").evaluate((element) => {
        element.click();
        element.click();
      });
      NodeAssert.equal(
        await page.evaluate(
          () => window.__folderCopyFixture.calls.filter((name) => name === "copyOffer").length,
        ),
        1,
      );
      NodeAssert.equal(
        await page.getByRole("dialog").count(),
        1,
        `${label}: busy Escape keeps dialog open`,
      );
      await release("copyOffer");
      await capture("preview", "Preview on ministorm");
      NodeAssert.match(
        await page.locator('[data-slot="dialog-panel"]').textContent(),
        /You can copy now/,
      );
      await pause("copyStart");
      await action("Preview on ministorm").click();
      await capture("planning", "Comparing folders…", true);
      await release("copyStart");
      await capture("apply", "Copy and transfer context to ministorm");
      NodeAssert.deepEqual(
        await page.evaluate(() => window.__folderCopyFixture.copyRequests.at(-1)),
        {
          copyRoot: "/Users/you/Projects/github/specweave-umb",
          projectRelativePath: "repositories/anton-abyzov/specweave",
          targetFolder: "/home/anton/Projects/github/specweave-umb",
        },
      );
      await page.evaluate(() => {
        window.__folderCopyFixture.failCopy = true;
      });
      await pause("copyApprove");
      await action("Copy and transfer context to ministorm").click();
      await capture("copying", "Copying files…", true);
      await release("copyApprove");
      await capture("failed", "Retry");
      await pause("copyRetry");
      await action("Retry").focus();
      await page.keyboard.press("Space");
      await capture("retrying", "Copying files…", true);
      await release("copyRetry");
      await capture("deferred", "Transfer coordinator context");
      NodeAssert.match(
        await page.locator('[data-slot="copy-done"]').textContent(),
        /files are copied. Work is still running/,
      );
      await page.evaluate(() => {
        window.__folderCopyFixture.transferReady = true;
      });
      await pause("prepare");
      await action("Transfer coordinator context").click();
      await capture("transferring", "Transferring context…", true);
      await release("prepare");
      await capture("done", "Open on ministorm");
      NodeAssert.match(
        await page.locator('[data-slot="copy-done"]').textContent(),
        /The coordinator continues/,
      );
      await action("Start a new copy").click();
      await page.evaluate(() =>
        window.__folderCopyFixture.failNext("copyOffer", "io", "The source folder cannot be read."),
      );
      await action("Measure the folder").click();
      await page.locator('[data-slot="dialog-footer"] [role="alert"]').waitFor();
      await capture("error", "Measure the folder");
      NodeAssert.match(await footer.textContent(), /The source folder cannot be read/);
      await action("Measure the folder").click();
      await assertAction("Preview on ministorm");
      NodeAssert.deepEqual(errors, []);
      receipt.cases.push({
        theme,
        viewport,
        result: "passed",
        horizontalOverflow: false,
        initialPrimaryVisibleWithoutScroll: true,
        footerStableWhileBodyScrolls: true,
        keyboardActivation: ["Enter", "Space"],
        busyEscapePrevented: true,
        duplicateOfferPrevented: true,
        stages,
      });
      await page.close();
    }
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      result: "passed",
      headless: true,
      cases: receipt.cases.length,
      screenshots: receipt.cases.reduce((total, entry) => total + entry.stages.length, 0),
      output,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

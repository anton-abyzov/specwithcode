// Headless screenshots of Add to another machine… (increments 1326, 1372) on the copy flow:
// what the chosen machine holds (the project, the coordinator, several folders, nothing), the
// header naming where the coordinator is, a destination that has the repository as a separate
// project, the plan, and the done screen with "Continue the coordinator on {machine}".
// Build first: node node_modules/vite-plus/bin/vp build --config apps/web/tests/folder-copy/vite.config.ts
// Run from the repository root: node apps/web/tests/folder-copy/send-screens.mjs /absolute/report-dir
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const site = NodePath.join(process.cwd(), ".artifacts/folder-copy/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/folder-copy/send");
await NodeFSP.mkdir(output, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ?? "playwright-core",
);
const shell = () => {
  if (process.env.STUDIO_CHROMIUM_EXECUTABLE) return process.env.STUDIO_CHROMIUM_EXECUTABLE;
  const cache = NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright");
  if (!NodeFS.existsSync(cache)) return undefined;
  for (const dir of NodeFS.readdirSync(cache)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    // One build per machine sits inside: chrome-headless-shell-<platform>-<arch>.
    const build = NodeFS.readdirSync(NodePath.join(cache, dir)).find((name) =>
      name.startsWith("chrome-headless-shell-"),
    );
    const file = build && NodePath.join(cache, dir, build, "chrome-headless-shell");
    if (file && NodeFS.existsSync(file)) return file;
  }
  return undefined;
};
const server = NodeHttp.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return response.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    const type = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
    response.writeHead(200, { "Content-Type": type[NodePath.extname(file)] ?? "text/html" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const executablePath = shell();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
// The done scenes copy into an empty folder, which takes one click in the fixture.
const DONE_HOLDING = "none";
const saved = [];
const shot = async (page, name) => {
  const path = NodePath.join(output, `${name}.png`);
  await page.locator('[data-slot="dialog-popup"]').screenshot({ path, animations: "disabled" });
  saved.push(path);
};
const text = async (page, slot) =>
  (await page.locator(`[data-slot="${slot}"]`).count())
    ? await page.locator(`[data-slot="${slot}"]`).textContent()
    : null;
const UMBRELLA = "~/projects/atlas/repositories/acme/specweave";
try {
  for (const [name, query, width, theme] of [
    ["copy", "holding=copy", 760, "light"],
    ["copy-dark", "holding=copy", 760, "dark"],
    ["copy-390", "holding=copy", 390, "light"],
    ["unlinked", "holding=copy&unlinked=1", 760, "light"],
    ["unlinked-dark", "holding=copy&unlinked=1", 760, "dark"],
    ["move", "holding=copy&move=1", 760, "light"],
    ["main", "holding=main", 760, "light"],
    ["several", "holding=several", 760, "light"],
    ["several-main", "holding=several-main", 760, "light"],
    ["none", "holding=none", 760, "light"],
  ]) {
    // The unlinked scenes are tall enough to show Git only switched off under Details.
    const height = name.startsWith("unlinked") ? 2400 : 1500;
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.goto(
      `${base}?short=1&method=clone&secrets=1&uncommitted=18&theme=${theme}&${query}`,
    );
    await page.locator('[data-slot="send-summary"]').waitFor();
    const dialog = await page.locator('[data-slot="dialog-popup"]').textContent();
    NodeAssert.match(
      dialog,
      name === "move" ? /Continue the coordinator on rackF/ : /Add specweave to rackF/,
    );
    // A folder copy asks nothing about the coordinator.
    NodeAssert.equal(await page.locator('[data-slot="handoff-coordinator"]').count(), 0);
    NodeAssert.doesNotMatch(dialog, /Copy or move/);
    const header = await text(page, "dialog-description");
    // The folder is the existing copy's checkout, never a second one beside it.
    if (name !== "several" && name !== "none")
      NodeAssert.match(
        await page.locator('input[aria-label="Folder on rackF"]').inputValue(),
        name === "several-main" ? /^\/Users\/you\/work\/atlas$/ : /^\/Users\/you\/projects\/atlas$/,
      );
    if (name === "move") {
      await page.getByRole("button", { name: "Copy and move to rackF", exact: true }).waitFor();
      NodeAssert.match(header, /^From laptopE\. The coordinator continues on rackF\./);
      NodeAssert.equal(
        await text(page, "send-plan"),
        `Copy 18 changed local files into ${UMBRELLA} on rackF, then continue the coordinator there. The coordinator continues on rackF.`,
      );
    }
    if (name.startsWith("copy")) {
      NodeAssert.equal(
        header,
        "From laptopE. The coordinator stays on laptopE. Nothing on rackF is replaced without asking.",
      );
      NodeAssert.equal(
        await text(page, "send-plan"),
        `Copy 18 changed local files into ${UMBRELLA} on rackF. The coordinator stays on laptopE.`,
      );
      await page.getByRole("button", { name: "Copy to rackF", exact: true }).waitFor();
    }
    if (name.startsWith("unlinked")) {
      NodeAssert.equal(
        header,
        "From deskB. rackF has this repository as a separate project (coordinator on laptopE). Nothing on rackF is replaced without asking.",
      );
      NodeAssert.equal(
        await text(page, "send-unlinked"),
        "Only files go into rackF's folder. Its coordinator stays on laptopE. To make them one project, link deskB to it from the machine menu.",
      );
      NodeAssert.match(await text(page, "send-plan"), /The coordinator stays on laptopE\.$/);
      // The Git handoff would move deskB's coordinator into that project: it is not on offer.
      const details = page.getByRole("button", { name: "Details" });
      if (await details.isVisible()) await details.click();
      await page.locator('[data-slot="handoff-method"]').waitFor();
      NodeAssert.equal(
        await page.getByRole("radio", { name: /Continue the coordinator here/ }).count(),
        0,
      );
    }
    if (name === "main") {
      NodeAssert.match(await text(page, "send-existing-copy"), /rackF already has the coordinator/);
      NodeAssert.match(header, /^From laptopE\. The coordinator stays on rackF\./);
      NodeAssert.match(await text(page, "send-plan"), /The coordinator stays on rackF\.$/);
    }
    if (name === "several") {
      NodeAssert.match(
        await text(page, "send-existing-copy"),
        /rackF has this project in 2 folders/,
      );
      NodeAssert.equal(await text(page, "send-plan"), null);
      NodeAssert.equal(
        await page.getByRole("button", { name: "Copy to rackF", exact: true }).isDisabled(),
        true,
      );
    }
    if (name === "several-main")
      NodeAssert.match(await text(page, "send-plan"), /The coordinator stays on rackF\.$/);
    if (name === "none")
      NodeAssert.equal(
        await text(page, "send-plan"),
        "Copy the folder to rackF. The coordinator stays on laptopE.",
      );
    await shot(page, `copy-dialog-${name}`);
    await page.close();
  }
  // The done screen: a copy into a linked copy offers the switch; another project's copy does not.
  for (const [name, query, theme] of [
    ["done-make-main", "makemain=1", "light"],
    ["done-make-main-dark", "makemain=1", "dark"],
    ["done-make-main-blocked", "makemain=blocked", "light"],
    ["done-unlinked", "makemain=1&unlinked=1", "light"],
  ]) {
    const page = await browser.newPage({
      viewport: { width: 760, height: 1500 },
      deviceScaleFactor: 2,
    });
    await page.goto(`${base}?short=1&method=clone&theme=${theme}&holding=${DONE_HOLDING}&${query}`);
    const footer = page.locator('[data-slot="dialog-footer"]');
    await footer.getByRole("button", { name: "Copy to rackF", exact: true }).click();
    await footer.getByRole("button", { name: "Open on rackF", exact: true }).waitFor();
    const makeMain = page.locator('[data-slot="copy-make-main"]');
    if (name === "done-unlinked") {
      NodeAssert.equal(await makeMain.count(), 0, "no switch into a project it is not linked to");
      NodeAssert.match(
        await text(page, "copy-not-linked"),
        /^rackF has this repository as a separate project whose coordinator is on laptopE\. Nothing was linked\./,
      );
    } else {
      NodeAssert.equal((await makeMain.textContent()).trim(), "Continue the coordinator on rackF");
      NodeAssert.equal(await makeMain.isDisabled(), name === "done-make-main-blocked");
      NodeAssert.match(
        await page.locator('[data-slot="dialog-popup"]').textContent(),
        /SpecWeave is on rackF\. The coordinator stays on laptopE\./,
      );
    }
    await shot(page, `copy-dialog-${name}`);
    if (name === "done-make-main") {
      // The switch opens the move to that copy: its setup, not the finished copy again.
      await makeMain.click();
      await page
        .getByRole("heading", { name: "Continue the coordinator on rackF", exact: true })
        .waitFor();
      NodeAssert.equal(await page.evaluate(() => document.body.dataset.madeMain), "rackF:rackF");
      await footer.getByRole("button", { name: "Copy and move to rackF", exact: true }).waitFor();
      NodeAssert.equal(await page.locator('[data-slot="copy-make-main"]').count(), 0);
      await shot(page, "copy-dialog-after-make-main");
    }
    await page.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "send-screens.json"),
    JSON.stringify({ headless: true, saved, base: "synthetic fixture, no live state" }, null, 2),
  );
  console.log(saved.join("\n"));
} finally {
  await browser.close();
  server.close();
}

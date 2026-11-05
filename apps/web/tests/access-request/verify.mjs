// Build with vp build --config apps/web/tests/access-request/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
// Usage: node apps/web/tests/access-request/verify.mjs [report-dir]
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/access-request/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/access-request/evidence");
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
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
const VIEWPORTS = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };

async function open(query, viewport) {
  const page = await browser.newPage({ viewport });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?${query}`);
  await page.locator("[data-access-request-card]").first().waitFor();
  return { page, errors };
}

async function checkPendingCard(card, label) {
  NodeAssert.ok(await card.locator("[data-access-card-tile]").isVisible(), `${label}: tile`);
  NodeAssert.ok(await card.locator("[data-access-request-title]").isVisible(), `${label}: title`);
  for (const decision of ["deny", "allow", "allow-machine"]) {
    const button = card.locator(`[data-access-decision="${decision}"]`);
    NodeAssert.ok(await button.isVisible(), `${label}: ${decision} visible`);
    NodeAssert.ok(await button.isEnabled(), `${label}: ${decision} enabled`);
    NodeAssert.equal(await button.getAttribute("type"), "button", `${label}: never submits`);
  }
  const deny = await card.locator('[data-access-decision="deny"]').boundingBox();
  const allow = await card.locator('[data-access-decision="allow"]').boundingBox();
  // Compact buttons: regular height, sized to their text, left-aligned.
  NodeAssert.ok(deny.height <= 34 && allow.height <= 34, `${label}: regular button height`);
  const cardBox = await card.boundingBox();
  NodeAssert.ok(deny.x - cardBox.x < 24, `${label}: buttons start at the left`);
  NodeAssert.ok(allow.width < cardBox.width / 2, `${label}: not full-width halves`);
  return { deny, allow };
}

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 390]) {
      const { page, errors } = await open(`theme=${theme}`, VIEWPORTS[width]);
      const card = page.locator('[data-case="pending-apps"] [data-access-request-card]');
      const { deny, allow } = await checkPendingCard(card, `thread ${theme} ${width}`);
      NodeAssert.ok(Math.abs(deny.y - allow.y) < 1, "Deny and Allow share a row");
      NodeAssert.equal(
        await card.locator("[data-access-request-title]").innerText(),
        "Claude wants to use Notes",
      );
      NodeAssert.match(await card.innerText(), /Notes\s*All/);

      // The card sits directly above the composer.
      const cardBox = await card.boundingBox();
      const composerBox = await page.locator("[data-fake-composer]").boundingBox();
      const gap = composerBox.y - (cardBox.y + cardBox.height);
      NodeAssert.ok(gap >= 0 && gap <= 16, `card right above the composer (gap ${gap})`);

      const answered = await page.locator('[data-case="answered"]').innerText();
      for (const line of [
        "Allowed for this session: Use Notes and Activity Monitor",
        "Allowed on this machine: Use Notes and Activity Monitor",
        "Denied: Control M1 iPhone Duo",
        "Request ended: Control M1 iPhone Duo",
        "Waiting for an answer in the original thread: Control M1 iPhone Duo",
        "Waiting for your answer: Claude wants to use Notes",
      ]) {
        NodeAssert.ok(answered.includes(line), `timeline row: ${line}`);
      }
      NodeAssert.equal(
        await page.locator('[data-case="answered"] [data-access-decision]').count(),
        0,
        "the timeline offers no answers",
      );
      NodeAssert.ok(!(await page.locator("body").innerText()).includes("Studio"), "no Studio");
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      NodeAssert.ok(overflow.scroll <= overflow.client, `no horizontal overflow at ${width}`);

      const file = NodePath.join(output, `part1-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: true });
      receipt.screenshots.push(file);

      // Answering disables the card while the answer is in flight.
      await card.locator('[data-access-decision="allow"]').click();
      NodeAssert.equal(await card.locator('[data-access-decision="deny"]').isDisabled(), true);
      await page.waitForTimeout(600);
      NodeAssert.equal(await card.locator('[data-access-decision="deny"]').isEnabled(), true);
      NodeAssert.deepEqual(errors, []);
      await page.close();

      // More cards: two apps with a real icon, a device, and the macOS permission card.
      const gallery = await open(`theme=${theme}&view=gallery`, VIEWPORTS[width]);
      const two = gallery.page.locator('[data-case="pending-two-apps"]');
      await checkPendingCard(two.locator("[data-access-request-card]"), "two apps");
      NodeAssert.equal(await two.locator("[data-access-subject]").count(), 2);
      NodeAssert.equal(await two.locator("[data-access-subject] img").count(), 1, "one real icon");
      NodeAssert.ok(
        (await two.locator("[data-access-subject] img").evaluate((img) => img.naturalWidth)) > 0,
        "icon decodes",
      );
      const deviceText = await gallery.page.locator('[data-case="pending-device"]').innerText();
      NodeAssert.match(deviceText, /The agent wants to control iPhone Duo/);
      NodeAssert.match(deviceText, /iPhone Duo\s*on M1/);
      // A device or folder shows its detail under its name; an app keeps it as the tooltip.
      NodeAssert.equal(
        await gallery.page
          .locator('[data-case="pending-device"] [data-access-subject-detail]')
          .innerText(),
        "See its screen, tap and type",
      );
      const folderCase = gallery.page.locator('[data-case="pending-folder"]');
      const folderDetail = folderCase.locator("[data-access-subject-detail]");
      NodeAssert.ok(await folderDetail.isVisible(), "folder detail visible");
      NodeAssert.equal(
        await folderDetail.innerText(),
        "~/Projects/specwithcode/docs/release-notes",
      );
      NodeAssert.equal(
        await two.locator("[data-access-subject-detail]").count(),
        0,
        "apps: tooltip",
      );
      NodeAssert.equal(
        await two.locator('[data-access-subject="app:activity monitor"]').getAttribute("title"),
        "See and control its windows, including quitting processes",
      );
      // A labelled region, announced politely, with the Always grant described.
      const region = gallery.page.getByRole("region", {
        name: "Codex wants to use Notes and Activity Monitor",
      });
      NodeAssert.equal(await region.count(), 1, "card is a named region");
      NodeAssert.equal(
        await region.locator('[role="status"][aria-live="polite"]').innerText(),
        "Access request: Codex wants to use Notes and Activity Monitor",
      );
      NodeAssert.equal(
        await region
          .locator('[data-access-decision="allow-machine"]')
          .getAttribute("aria-description"),
        "You can take back an Always grant in Settings → Integrations.",
      );
      // A viewer who cannot operate the thread sees the card with its answers off.
      const readOnly = gallery.page.locator('[data-case="read-only"]');
      for (const decision of ["deny", "allow", "allow-machine"]) {
        NodeAssert.ok(
          await readOnly.locator(`[data-access-decision="${decision}"]`).isDisabled(),
          `read-only: ${decision} disabled`,
        );
      }
      const perm = gallery.page.locator('[data-testid="computer-use-permission-card"]');
      await perm.waitFor();
      NodeAssert.match(await perm.innerText(), /Computer use needs Screen Recording/);
      NodeAssert.ok(await perm.locator("button", { hasText: "Allow" }).isVisible(), "perm Allow");
      const galleryShot = NodePath.join(output, `gallery-${theme}-${width}.png`);
      await gallery.page.screenshot({ path: galleryShot, fullPage: true });
      receipt.screenshots.push(galleryShot);
      if (width === 1440) {
        const permShot = NodePath.join(output, `perm-${theme}-1440.png`);
        await perm.screenshot({ path: permShot });
        receipt.screenshots.push(permShot);
      }
      NodeAssert.deepEqual(gallery.errors, []);
      await gallery.page.close();
      receipt.checks.push({ theme, width, ok: true });
    }
  }
  // The error line, as a failed answer shows it.
  const { page } = await open("theme=light&fail=1", VIEWPORTS[390]);
  const card = page.locator('[data-case="pending-apps"] [data-access-request-card]');
  await card.locator('[data-access-decision="deny"]').click();
  await card.getByRole("alert").waitFor();
  NodeAssert.equal(
    await card.getByRole("alert").innerText(),
    "This access request was already answered.",
  );
  const errorShot = NodePath.join(output, "access-request-error-light-390.png");
  await card.screenshot({ path: errorShot });
  receipt.screenshots.push(errorShot);
  await page.close();
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(
  NodePath.join(output, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(
  JSON.stringify({ checks: receipt.checks.length, screenshots: receipt.screenshots }, null, 2),
);

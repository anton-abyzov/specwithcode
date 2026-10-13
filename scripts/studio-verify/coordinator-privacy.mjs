import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Exercise the actual settings page and exact consent-bound download in an owned test server. */
export async function verifyPrivacyPage({ page, origin, out, receipt }) {
  let diagnosticsRequests = 0;
  const externalRequests = [];
  const recordSocket = (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (/traceDiagnostics|trace\.diagnostics|getTraceDiagnostics/i.test(String(payload)))
        diagnosticsRequests++;
    });
  const recordRequest = (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== origin) externalRequests.push(url.origin);
  };
  page.on("websocket", recordSocket);
  page.on("request", recordRequest);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/settings/privacy`, { waitUntil: "networkidle" });
  const section = page.locator("[data-privacy-settings]");
  await section.waitFor();
  assert.equal(await page.locator("[data-privacy-report]").count(), 0);
  assert.equal(await section.getByRole("button", { name: "Save report", exact: true }).count(), 0);
  assert.equal(diagnosticsRequests, 0, "Opening privacy settings must not collect a report");
  await section.getByRole("button", { name: "Preview diagnostic report", exact: true }).click();
  const preview = section.locator("[data-privacy-report]");
  await preview.waitFor();
  assert.ok(diagnosticsRequests > 0, "Explicit preview must request selected-host diagnostics");
  const text = await preview.innerText();
  const report = JSON.parse(text);
  assert.ok(report && typeof report === "object");
  const save = section.getByRole("button", { name: "Save report", exact: true });
  assert.equal(await save.isDisabled(), true, "Download needs consent for this report");
  writeFileSync(
    join(out, "privacy-controls.json"),
    JSON.stringify(
      await section
        .locator('[data-slot="checkbox"], input[type="checkbox"]')
        .evaluateAll((nodes) => nodes.map((node) => node.outerHTML)),
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await section.getByRole("checkbox", { name: /I reviewed this report/ }).click();
  assert.equal(await save.isEnabled(), true);
  const downloading = page.waitForEvent("download");
  await save.click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), "specwithcode-diagnostics.json");
  const path = join(out, "specwithcode-diagnostics.json");
  await download.saveAs(path);
  assert.equal(readFileSync(path, "utf8"), text, "Saved report must equal its exact preview");
  await section.getByRole("button", { name: "Preview diagnostic report", exact: true }).click();
  await page.waitForFunction(() => {
    const checkbox = document.querySelector('[aria-label="I reviewed this report"]');
    return checkbox?.getAttribute("aria-checked") === "false";
  });
  assert.equal(await save.isDisabled(), true, "Refreshed report needs fresh consent");
  for (const [width, theme] of [
    [1440, "light"],
    [390, "dark"],
  ]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ colorScheme: theme });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    const screenshot = join(out, `privacy-${width}-${theme}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    receipt.screenshots.push(screenshot);
    await save.scrollIntoViewIfNeeded();
    const reportScreenshot = join(out, `privacy-report-${width}-${theme}.png`);
    await page.screenshot({ path: reportScreenshot, fullPage: true });
    receipt.screenshots.push(reportScreenshot);
  }
  assert.deepEqual(
    externalRequests,
    [],
    "Preview and save must not upload to an external destination",
  );
  page.off("websocket", recordSocket);
  page.off("request", recordRequest);
  receipt.checks.push({
    privacyNoAutomaticReport: true,
    privacyExplicitPreview: true,
    privacyExactDownload: true,
    privacyConsentReset: true,
    privacyNoExternalRequests: true,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.versions.node.startsWith("22."), "Use Node 22 for candidate acceptance");
  const out = resolve(
    process.argv[2] ??
      join(homedir(), ".local/share/specweave-studio/verification/0909", `run-${Date.now()}`),
  );
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), "coordinator-routing.mjs"), out],
    {
      env: {
        ...process.env,
        STUDIO_TEST_INCLUDE_PRIVACY: "1",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      stdio: "inherit",
    },
  );
  const code = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  assert.equal(code, 0, "Coordinator/privacy browser acceptance failed");
  const receipt = JSON.parse(readFileSync(join(out, "receipt.json"), "utf8"));
  assert.ok(
    receipt.checks.some((check) => check.privacyExactDownload === true),
    "Privacy verification did not run",
  );
  assert.equal(receipt.candidateStopped, true);
  console.log(
    JSON.stringify({
      passed: true,
      receipt: join(out, "receipt.json"),
      screenshots: receipt.screenshots.length,
    }),
  );
}

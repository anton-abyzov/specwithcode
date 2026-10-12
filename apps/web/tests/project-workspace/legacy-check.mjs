// A project from before projects had settings names the model its coordinator will run
// on, and never asks for one just because the host's providers have not arrived yet.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output = process.env.PROJECT_UI_OUTPUT ?? "/tmp/studio-project-ui";
await NodeFSP.mkdir(output, { recursive: true });
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const shot = (page, name) =>
  page.screenshot({ path: NodePath.join(output, `legacy-${name}.png`), fullPage: true });
const choosePrompt = /Choose (coordinator )?model|Choose a coordinator model/;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Providers are here: the picker names this host's default, ready to change.
  await page.goto("http://127.0.0.1:5788/?legacy");
  await page.waitForLoadState("networkidle");
  const picker = page.locator(".sws-composer .sws-model-pick");
  await picker.waitFor();
  NodeAssert.match(await picker.innerText(), /Opus 5\.5/);
  NodeAssert.ok(
    await page
      .getByRole("button", { name: /^Coordinator model: .*Opus 5\.5\. Change model$/ })
      .isVisible(),
  );
  NodeAssert.doesNotMatch(await page.locator("body").innerText(), choosePrompt);
  NodeAssert.equal(await page.locator(".sws-model-pick-empty, .sws-model-pick-unset").count(), 0);
  await shot(page, "providers-ready");

  // Providers still on their way, or sent but not checked yet: say so, and do not ask
  // for a choice.
  for (const variant of ["loading", "checking"]) {
    await page.goto(`http://127.0.0.1:5788/?legacy=${variant}`);
    await page.waitForLoadState("networkidle");
    const loading = page.locator(".sws-composer .sws-model-pick-loading");
    await loading.waitFor();
    NodeAssert.equal(await loading.getAttribute("role"), "status");
    NodeAssert.equal(
      (await loading.textContent()).replace(/\s+/g, " ").trim(),
      "Loading models for the coordinator",
    );
    NodeAssert.doesNotMatch(await page.locator("body").innerText(), choosePrompt);
    NodeAssert.equal(
      (await page.locator(".sws-starter-note").first().innerText()).trim(),
      "Models are still loading from this host.",
    );
    await shot(page, `providers-${variant}`);
  }

  NodeAssert.deepEqual(errors, []);
  console.log("legacy project checks passed");
} finally {
  await browser.close();
}

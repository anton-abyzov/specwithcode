// Fixture-only: never connects to Studio or invokes a provider.
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
if (!process.env.STUDIO_PLAYWRIGHT_MODULE)
  throw new Error("Set STUDIO_PLAYWRIGHT_MODULE to an existing Playwright installation");
const playwright = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const { chromium } = playwright.default ?? playwright;
const root = path.resolve(".artifacts/provider-device-auth/site");
const output = path.resolve(".artifacts/provider-device-auth/evidence");
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) return res.writeHead(403).end();
    const data = await fs.readFile(file);
    res
      .writeHead(200, {
        "Content-Type": file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      })
      .end(data);
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
const errors = [];
const checks = [];
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  const panel = (environment) =>
    page.getByRole("region", { name: `${environment.toUpperCase()} provider`, exact: true });
  const card = (environment) =>
    panel(environment).getByRole("region", {
      name: `Device sign-in for ${environment.toUpperCase()}`,
      exact: true,
    });
  const fixture = (fn, arg) => page.evaluate(fn, arg);
  const calls = () => fixture(() => window.__deviceAuthFixture.calls);
  await page.goto(origin);
  await panel("m1").getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.deepEqual(await calls(), []);
  for (const environment of ["m1", "m3"]) {
    await panel(environment).getByRole("button", { name: "Sign in", exact: true }).click();
    await card(environment).waitFor();
  }
  assert.deepEqual(await calls(), [
    { command: "start", environmentId: "m1", input: { instanceId: "copilot-work" } },
    { command: "start", environmentId: "m3", input: { instanceId: "copilot-work" } },
  ]);
  assert.match(await card("m1").textContent(), /MONE-1111/);
  assert.match(await card("m3").textContent(), /MTHR-3333/);
  assert.doesNotMatch(await card("m1").textContent(), /MTHR-3333/);
  assert.doesNotMatch(await card("m3").textContent(), /MONE-1111/);
  checks.push(
    "Concurrent M1/M3 sign-ins sharing an instance ID bind exact environment and flow; no automatic browser or auth action",
  );

  await card("m1").getByRole("button", { name: "Copy code", exact: true }).click();
  await card("m1").getByRole("status").filter({ hasText: "Code copied" }).waitFor();
  await panel("m3").getByRole("button", { name: "Open browser", exact: true }).focus();
  await page.keyboard.press("Enter");
  await panel("m3").getByRole("button", { name: "Copy sign-in link", exact: true }).click();
  assert.deepEqual((await calls()).slice(2), [
    { command: "clipboard", client: "m4", value: "MONE-1111", label: "Provider sign-in code" },
    { command: "openExternal", client: "m4", url: "https://github.com/login/device" },
    {
      command: "clipboard",
      client: "m4",
      value: "https://github.com/login/device",
      label: "Provider sign-in link",
    },
  ]);
  checks.push("Copy code/link and keyboard Open browser use controlling-client APIs only");

  const flowBeforeReconnect = await fixture(() => window.__deviceAuthFixture.states.m3.flowId);
  const beforeReconnect = await calls();
  await fixture(() => window.__deviceAuthFixture.connection(false));
  await page.getByText("Disconnected fixture panels").waitFor();
  await fixture(() => window.__deviceAuthFixture.connection(true));
  await card("m3").waitFor();
  assert.equal(
    await fixture(() => window.__deviceAuthFixture.states.m3.flowId),
    flowBeforeReconnect,
  );
  assert.deepEqual(await calls(), beforeReconnect);
  checks.push(
    "Remounted panels restore server-owned code and flow without restarting or opening a browser",
  );

  await panel("m1")
    .getByRole("button", { name: "Confirm credential storage", exact: true })
    .click();
  assert.deepEqual((await calls()).at(-1), {
    command: "respond",
    environmentId: "m1",
    input: {
      instanceId: "copilot-work",
      flowId: "flow-m1-1",
      interactionId: "interaction-m1",
      response: { type: "terminal", data: "y\r" },
    },
  });
  checks.push(
    "Terminal device code retains destination-bound native credential-confirmation input",
  );

  await panel("m1").getByRole("button", { name: "Cancel sign-in", exact: true }).click();
  await panel("m1").getByRole("button", { name: "Retry sign-in", exact: true }).waitFor();
  assert.equal(await card("m1").count(), 0);
  assert.equal(
    await panel("m1").getByRole("button", { name: "Open browser", exact: true }).count(),
    0,
  );
  assert.deepEqual((await calls()).at(-1), {
    command: "cancel",
    environmentId: "m1",
    input: { instanceId: "copilot-work", flowId: "flow-m1-1" },
  });
  assert.equal(
    await fixture(() => window.__deviceAuthFixture.states.m3.flowId),
    flowBeforeReconnect,
  );
  await card("m3").waitFor();
  await panel("m1").getByRole("button", { name: "Retry sign-in", exact: true }).click();
  await card("m1").waitFor();
  assert.notEqual(await fixture(() => window.__deviceAuthFixture.states.m1.flowId), "flow-m1-1");
  checks.push(
    "Cancellation and retry target one flow, hide stale codes/links and preserve the other environment",
  );

  await fixture(() =>
    window.__deviceAuthFixture.phase(
      "m3",
      "failed",
      "Sign-in expired. Start again to get a new code.",
    ),
  );
  await panel("m3").getByText("Sign-in expired. Start again to get a new code.").waitFor();
  assert.equal(await card("m3").count(), 0);
  assert.equal(
    await panel("m3").getByRole("button", { name: "Open browser", exact: true }).count(),
    0,
  );
  await panel("m3").getByRole("button", { name: "Retry sign-in", exact: true }).click();
  await card("m3").waitFor();
  await fixture(() =>
    window.__deviceAuthFixture.phase(
      "m3",
      "failed",
      "Copilot must be updated to support device sign-in.",
    ),
  );
  await panel("m3").getByText("Copilot must be updated to support device sign-in.").waitFor();
  assert.equal(await panel("m3").getByText("Signed in.", { exact: true }).count(), 0);
  checks.push(
    "Expired and unsupported-CLI failures stay actionable and never report authenticated",
  );

  await fixture(() => window.__deviceAuthFixture.wait("m3", "deviceCode"));
  await card("m3").waitFor();
  assert.equal(
    await panel("m3").getByRole("button", { name: "Confirm credential storage" }).count(),
    0,
  );
  await card("m3").getByRole("button", { name: "Copy code", exact: true }).click();
  assert.equal((await calls()).at(-1).value, "MTHR-3333");
  checks.push("Existing standalone deviceCode providers retain code/link UI without a terminal");

  await fixture(() => window.__deviceAuthFixture.readonly(true));
  const beforeReadonly = await calls();
  for (const environment of ["m1", "m3"])
    for (const label of ["Open browser", "Copy sign-in link", "Copy code", "Cancel sign-in"])
      assert.equal(
        await panel(environment).getByRole("button", { name: label, exact: true }).isDisabled(),
        true,
      );
  // The simulated terminal still emits input; the production parent must block it.
  await panel("m1").getByRole("button", { name: "Confirm credential storage" }).click();
  assert.deepEqual(await calls(), beforeReadonly);
  await fixture(() => window.__deviceAuthFixture.readonly(false));
  checks.push("Read-only panels disable browser/copy/cancel and reject terminal responses");

  await fixture(() => window.__deviceAuthFixture.failures(true, true));
  await card("m1").getByRole("button", { name: "Copy code", exact: true }).click();
  await panel("m1")
    .getByRole("alert")
    .filter({ hasText: "Could not copy the sign-in code." })
    .waitFor();
  await panel("m1").getByRole("button", { name: "Open browser", exact: true }).click();
  await panel("m1")
    .getByRole("alert")
    .filter({ hasText: "Could not open the sign-in page." })
    .waitFor();
  await fixture(() => window.__deviceAuthFixture.failures(false, false));
  await card("m1").getByRole("button", { name: "Copy code", exact: true }).click();
  assert.equal(await panel("m1").getByRole("alert").count(), 0);
  checks.push(
    "Client copy/browser failures are visible and recover without restarting provider auth",
  );

  await fixture(() => window.__deviceAuthFixture.phase("m3", "verifying"));
  await panel("m3").getByText("Checking your account…").waitFor();
  assert.equal(await panel("m3").getByText("Signed in.", { exact: true }).count(), 0);
  await fixture(() => window.__deviceAuthFixture.phase("m3", "succeeded"));
  await panel("m3").getByText("Signed in.", { exact: true }).waitFor();
  assert.equal(await card("m3").count(), 0);
  assert.equal(
    await panel("m3").getByRole("button", { name: "Open browser", exact: true }).count(),
    0,
  );
  checks.push(
    "Verification remains pending until server success; completed codes and links disappear",
  );

  for (const width of [320, 390, 1440])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      await panel("m1").getByRole("button", { name: "Sign in", exact: true }).waitFor();
      await fixture(() => {
        window.__deviceAuthFixture.wait("m1");
        window.__deviceAuthFixture.wait("m3");
      });
      await card("m1").waitFor();
      await panel("m3").getByRole("button", { name: "Confirm credential storage" }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      assert.ok(
        (await card("m1").getByRole("button", { name: "Copy code", exact: true }).boundingBox())
          .height >= 24,
      );
      await page.screenshot({ path: path.join(output, `${width}-${theme}.png`), fullPage: true });
      checks.push(
        `${width}-${theme}: two destination-labelled device sign-in cards without horizontal overflow`,
      );
    }
  assert.deepEqual(errors, []);
  const receipt = {
    type: "isolated-production-component-fixture",
    headless: true,
    providerCalls: 0,
    installations: 0,
    externalRequestsAllowed: false,
    mockedBoundaries: [
      "environment RPC/hooks",
      "local browser/clipboard",
      "settings scope row",
      "terminal surface only",
    ],
    checks,
    errors,
    screenshotDirectory: output,
  };
  await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

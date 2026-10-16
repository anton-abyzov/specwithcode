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
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE ?? undefined;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});
const base = `http://127.0.0.1:${process.env.PROJECT_UI_PORT ?? 5788}/`;
// `?fallback`: a project on another machine whose coordinator the usage-limit rule
// moved from Claude to Codex. Machine, provider and model must read plainly everywhere.
try {
  const results = {};
  for (const [width, scheme] of [
    [1440, "dark"],
    [1440, "light"],
    [1000, "light"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    await page.goto(`${base}?fallback`);
    await page.locator("p[data-model-fallback]").waitFor();
    const read = {
      fallback: await page.locator("p[data-model-fallback]").innerText(),
      machine: await page.locator("[data-project-machine]").innerText(),
      host: await page.locator(".sws-host-name").first().innerText(),
      notes: await page.locator(".project-inline-notice").allInnerTexts(),
      userBubbles: await page.locator(".project-message-user").count(),
      headers: await page.locator("[data-request-execution]").allInnerTexts(),
      usage: await page.locator(".sws-composer-meta").innerText(),
    };
    NodeAssert.match(read.fallback, /Claude Code limit reached/);
    NodeAssert.match(read.fallback, /running on Codex · GPT-6\.1 Sol/);
    NodeAssert.match(read.fallback, /Switch back/);
    NodeAssert.ok(read.machine.trim(), "the header names the machine that runs the project");
    NodeAssert.ok(read.host.trim(), "the composer names the machine, not just a dot");
    NodeAssert.deepEqual(read.notes, [
      "Claude Code limit reached · continued on Codex · GPT-6.1 Sol",
    ]);
    NodeAssert.equal(read.userBubbles, 1, "the resent request is a note, not a second bubble");
    for (const header of read.headers)
      NodeAssert.doesNotMatch(header, /claudeAgent|claude-opus|gpt-6\.1-sol/, "friendly names");
    await page.screenshot({ path: NodePath.join(output, `run-identity-${width}-${scheme}.png`) });
    results[`${width}-${scheme}`] = read;
    await page.close();
  }
  await NodeFSP.writeFile(
    NodePath.join(output, "run-identity.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(`run identity ok; evidence in ${output}`);
} finally {
  await browser.close();
}

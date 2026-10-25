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
// moved from Claude to Codex. `?fallback=gemini` is the October 22 live case: Claude
// reads as having room, yet the coordinator runs on Gemini. Either way the composer must
// name the model it is on first, then the saved pick, never the pick alone.
try {
  const results = {};
  for (const [variant, now] of [
    ["fallback", /^Now on Codex · GPT-6\.1 Sol\.$/],
    ["fallback=gemini", /^Now on Gemini · Default\.$/],
  ])
    for (const [width, scheme] of [
      [1440, "dark"],
      [1440, "light"],
      [1000, "light"],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
      await page.goto(`${base}?${variant}`);
      await page.locator("p[data-model-fallback]").waitFor();
      const read = {
        line: await page.locator("p[data-model-fallback]").innerText(),
        chip: await page.locator("[data-coordinator-model-controls]").first().innerText(),
        tag: await page
          .locator("[data-coordinator-model-controls] .sws-model-state[data-model-state=fallback]")
          .first()
          .innerText(),
        machine: await page.locator("[data-project-machine]").innerText(),
        host: await page.locator(".sws-host-name").first().innerText(),
        notes: await page.locator(".project-inline-notice").allInnerTexts(),
        userBubbles: await page.locator(".project-message-user").count(),
        headers: await page.locator("[data-request-execution]").allInnerTexts(),
      };
      // The chip itself names the model that runs, then the pick it stands in for.
      const chipModel = read.chip.split("\n").slice(0, 3).join(" ");
      NodeAssert.match(`Now on ${chipModel}.`, now);
      NodeAssert.match(read.tag, /fallback for Claude Code · Opus 5\.5/);
      NodeAssert.match(read.line, /Your pick, Claude Code · Opus 5\.5, has room again\./);
      NodeAssert.match(read.line, /Switch back/);
      NodeAssert.ok(read.machine.trim(), "the header names the machine that runs the project");
      NodeAssert.ok(read.host.trim(), "the composer names the machine, not just a dot");
      NodeAssert.equal(read.userBubbles, 1, "the resent request is a note, not a second bubble");
      for (const header of read.headers)
        NodeAssert.doesNotMatch(header, /claudeAgent|claude-opus|gpt-6\.1-sol/, "friendly names");
      const name = `run-identity-${variant.replace("=", "-")}-${width}-${scheme}`;
      await page.screenshot({ path: NodePath.join(output, `${name}.png`) });
      const composer = page.locator(".sws-composer").first();
      if (await composer.count())
        await composer.screenshot({ path: NodePath.join(output, `${name}-composer.png`) });
      results[name] = read;
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

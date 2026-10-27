// Headless check of the skill rows in the `/` menu and the typed-slash send rule. Build first:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/skill-commands/vite.config.ts
// then: PW=<playwright-core/index.mjs> node apps/web/tests/skill-commands/verify.mjs <out-dir>
// Always headless; writes screenshots and checks.json to the out dir and exits 1 on a failed check.
// LIVE_HARNESSES=<file> adds one screenshot per harness from catalogs captured on a real machine
// (a JSON array of { id, label, driverKind, skills }).
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.PW).href);
const root = NodeURL.fileURLToPath(
  new URL("../../../../.artifacts/skill-commands/site", import.meta.url),
);
const out = process.argv[2];
if (!out) throw new Error("Pass an output directory.");
await NodeFSP.mkdir(out, { recursive: true });

const server = NodeHttp.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, "http://x").pathname;
    const file =
      p === "/live-harnesses.json" && process.env.LIVE_HARNESSES
        ? process.env.LIVE_HARNESSES
        : NodePath.resolve(root, `.${p === "/" ? "/index.html" : p}`);
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".woff2")
          ? "font/woff2"
          : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const report = [];
const errors = [];
const check = (name, ok, detail) => {
  report.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
};
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["dark", "light"]) {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 760 },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(`${theme}/${width}: ${error}`));
      for (const q of ["sw", "continue", "grill"]) {
        const name = `${q}-${theme}-${width}`;
        await page.goto(`${origin}/?${new URLSearchParams({ q, theme })}`);
        await page.locator("[data-menu]").waitFor();
        await page.waitForTimeout(150);
        const rows = await page
          .locator("[data-composer-item-id]")
          .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
        await page.screenshot({ path: NodePath.join(out, `${name}.png`), fullPage: true });
        check(
          `${name}: no /skill: label`,
          rows.every((r) => !r.includes("/skill:")),
          rows.join(" | "),
        );
        if (q === "sw") {
          const skills = rows.filter((r) => r.startsWith("$sw:"));
          const personal = rows.find((r) => r.startsWith("$asc-whats-new-writer"));
          check(`${name}: plugin rows lead with $sw:`, skills.length === 7, skills.join(" | "));
          check(
            `${name}: plugin badge`,
            skills.every((r) => r.includes("Plugin")),
            skills.join(" | "),
          );
          check(
            `${name}: personal skill by its id`,
            personal?.includes("Personal") === true,
            String(personal),
          );
          check(
            `${name}: display name follows the id`,
            skills.some((r) => r.startsWith("$sw:do") && r.includes("SpecWeave Do")),
            skills.join(" | "),
          );
        }
        if (q === "continue") {
          check(
            `${name}: app commands first`,
            rows[0]?.startsWith("/continue") === true,
            rows.join(" | "),
          );
          check(
            `${name}: no sw-do match on continue`,
            rows.every((r) => !r.startsWith("$sw:do")),
            rows.join(" | "),
          );
        }
        if (q === "grill") {
          check(
            `${name}: grill-me listed`,
            rows[0]?.startsWith("$sw:grill-me") === true,
            rows.join(" | "),
          );
        }
      }
      const sent = await page
        .locator("[data-typed]")
        .evaluateAll((els) =>
          Object.fromEntries(els.map((el) => [el.dataset.typed, el.dataset.sent])),
        );
      check(
        `send-${theme}-${width}`,
        sent["/sw:do 0042"] === "$sw:do 0042" &&
          sent["/sw:grill-me the pricing plan"] === "$sw:grill-me the pricing plan" &&
          sent["/continue"] === "/continue" &&
          sent["/sw-do 0042"] === "/sw-do 0042" &&
          sent["please /sw:do"] === "please /sw:do",
        JSON.stringify(sent),
      );
      await context.close();
    }
  }
  // One coordinator `/` menu per harness: only that harness's skills, and typed `/name`
  // sent as `$name` only for a skill it runs (expectations come from CoordinatorHarnesses.testkit.ts).
  const fixtureIds = ["claude", "codex", "copilot", "antigravity"];
  const live = process.env.LIVE_HARNESSES
    ? JSON.parse(await NodeFSP.readFile(process.env.LIVE_HARNESSES, "utf8"))
    : [];
  const runs = [
    ...fixtureIds.flatMap((id) => [
      { id, data: "fixture", theme: "dark", width: 1280, q: "" },
      { id, data: "fixture", theme: "light", width: 390, q: "" },
    ]),
    ...live.flatMap((entry) => [
      { id: entry.id, data: "live", theme: "dark", width: 1280, q: "" },
      { id: entry.id, data: "live", theme: "dark", width: 1280, q: "sw" },
    ]),
  ];
  for (const run of runs) {
    const context = await browser.newContext({
      viewport: { width: run.width, height: 900 },
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const name = `harness-${run.id}-${run.data}${run.q ? `-q-${run.q}` : ""}-${run.theme}-${run.width}`;
    page.on("pageerror", (error) => errors.push(`${name}: ${error}`));
    await page.goto(
      `${origin}/?${new URLSearchParams({ harness: run.id, data: run.data, theme: run.theme, q: run.q })}`,
    );
    await page.locator("[data-menu]").waitFor();
    await page.waitForTimeout(150);
    // Skill rows carry `skill:<driver>:<name>`; their visible label must be `$<name>`.
    const skillRows = await page.locator('[data-composer-item-id^="skill:"]').evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute("data-composer-item-id").split(":").slice(2).join(":"),
        text: el.textContent ?? "",
      })),
    );
    await page.screenshot({ path: NodePath.join(out, `${name}.png`), fullPage: true });
    check(
      `${name}: rows lead with $name`,
      skillRows.every((row) => row.text.startsWith(`$${row.name}`)),
      skillRows.map((row) => row.text.slice(0, 40)).join(" | "),
    );
    const listed = skillRows.map((row) => `$${row.name}`);
    if (run.data === "fixture") {
      const own = JSON.parse(await page.locator("[data-own]").getAttribute("data-own"));
      check(
        `${name}: only its own skills`,
        listed.length === own.length && own.every((id) => listed.includes(id)),
        listed.join(" "),
      );
      const sent = await page
        .locator("[data-typed]")
        .evaluateAll((els) =>
          els.map((el) => [el.dataset.typed, el.dataset.sent, el.dataset.expected]),
        );
      check(
        `${name}: typed /name sent per harness`,
        sent.length > 0 && sent.every(([, got, expected]) => got === expected),
        JSON.stringify(sent),
      );
    } else {
      const entry = live.find((candidate) => candidate.id === run.id);
      const names = new Set(entry.skills.map((skill) => `$${skill.name}`));
      check(
        `${name}: every row is a skill this harness lists`,
        listed.length > 0 && listed.every((id) => names.has(id)),
        `${listed.length} rows, harness lists ${names.size}: ${listed.slice(0, 8).join(" ")}`,
      );
      if (run.q === "sw") {
        const listsSpecWeave = [...names].some((id) => /^\$sw[:-]/.test(id));
        check(
          `${name}: SpecWeave rows exactly when this harness loads SpecWeave`,
          listed.some((id) => /^\$sw[:-]/.test(id)) === listsSpecWeave,
          `harness loads SpecWeave: ${listsSpecWeave}; rows: ${listed.join(" ")}`,
        );
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
check("no page errors", errors.length === 0, errors.join("\n"));
await NodeFSP.writeFile(
  NodePath.join(out, "checks.json"),
  JSON.stringify({ failures, report }, null, 2),
);
console.log(failures.length ? `FAIL\n${failures.join("\n")}` : `PASS ${report.length} checks`);
process.exit(failures.length ? 1 : 0);

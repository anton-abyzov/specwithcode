// Headless shots of the Send to another machine… dialog (`?scene=send`): a machine with a
// copy (Copy, then Move), with Main, with several copies, with none, and with its default
// folder taken. Usage: node apps/web/tests/machines-page/shoot-send.mjs <outDir>
import * as NodeFs from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createServer } from "vite";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const here = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const out = NodePath.resolve(process.argv[2] ?? NodePath.join(here, "../../../../.artifacts/send"));
NodeFs.mkdirSync(out, { recursive: true });
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const server = await createServer({
  configFile: NodePath.join(here, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  channel: process.env.STUDIO_PLAYWRIGHT_CHANNEL || "chrome",
});
const failures = [];
const shots = [
  ["copy", "", 1100, "light"],
  ["copy", "", 1100, "dark"],
  ["copy", "", 390, "light"],
  ["move", "", 1100, "light"],
  ["main", "", 1100, "light"],
  ["several", "", 1100, "light"],
  ["none", "", 1100, "light"],
  ["none", "taken", 1100, "light"],
];
for (const [state, folder, width, theme] of shots) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`${state}: ${error.message}`));
  await page.goto(`${url}?theme=${theme}&scene=send&state=${state}&folder=${folder || "free"}`, {
    timeout: 240_000,
  });
  const plan = page.locator('[data-slot="send-plan"]');
  await plan.waitFor({ timeout: 60_000 });
  if (state === "move") await page.locator('[data-send-choice="move"] [role="radio"]').click();
  if (state === "none")
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-slot="send-plan"]')?.textContent?.includes("a new folder"),
    );
  await page.waitForTimeout(300);
  const name = `send-dialog-${state}${folder ? `-${folder}` : ""}-${width}-${theme}.png`;
  await page.screenshot({ path: NodePath.join(out, name) });
  console.log(`${name}: ${await plan.textContent()}`);
  await context.close();
}
await browser.close();
await server.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

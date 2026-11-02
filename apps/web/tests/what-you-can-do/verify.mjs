import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createServer } from "vite";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = NodeModule.createRequire(import.meta.url)(
  process.env.STUDIO_PLAYWRIGHT_MODULE ||
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
);
const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const out = process.argv[2] ?? NodePath.join(here, "../../../../.artifacts/what-you-can-do");
const server = await createServer({
  configFile: NodePath.join(here, "vite.config.ts"),
  server: { port: 0, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  channel: process.env.STUDIO_PLAYWRIGHT_CHANNEL || "chrome",
});
const failures = [];
for (const [width, theme] of [
  [1100, "light"],
  [1100, "dark"],
  [390, "dark"],
]) {
  const page = await browser.newPage({ viewport: { width, height: 500 } });
  await page.goto(`${url}?theme=${theme}`, { timeout: 240_000 });
  await page.getByRole("heading", { name: "What you can do" }).waitFor();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 0) failures.push(`${width}px overflows by ${overflow}px`);
  await page.screenshot({ path: NodePath.join(out, `checklist-${width}-${theme}.png`) });
  await page.close();
}
await browser.close();
await server.close();
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: ${out}`);

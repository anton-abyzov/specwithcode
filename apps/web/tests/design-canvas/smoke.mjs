// Quick headless look at the fixture: one screenshot per theme plus console errors.
// Usage: node apps/web/tests/design-canvas/smoke.mjs /absolute/report-dir [query]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { launch, serveSite } from "./serve.mjs";

const out = NodePath.resolve(process.argv[2] ?? "/tmp/design-canvas-smoke");
const query = process.argv[3] ?? "";
NodeFS.mkdirSync(out, { recursive: true });
const site = await serveSite();
const browser = await launch();
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 960 },
      colorScheme: theme,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.goto(`${site.url}?theme=${theme}&${query}`);
    await page.waitForSelector("[data-testid=design-canvas]");
    await page.waitForTimeout(600);
    await page.screenshot({ path: NodePath.join(out, `smoke-${theme}.png`) });
    console.log(theme, errors.length === 0 ? "no errors" : errors.join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
  await site.close();
}

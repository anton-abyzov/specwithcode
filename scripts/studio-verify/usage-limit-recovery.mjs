import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = resolve(process.argv[2] ?? ".studio-build-evidence/recovery");
mkdirSync(out, { recursive: true, mode: 0o700 });
const fixture = mkdtempSync(join(out, "fixture-"));
symlinkSync(join(root, "apps/web/node_modules"), join(fixture, "node_modules"), "dir");
const web = join(root, "apps/web/src"),
  req = createRequire(join(root, "apps/web/package.json"));
const put = (name, value) => writeFileSync(join(fixture, name), value, { mode: 0o600 });
put(
  "index.html",
  '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"/><body><div id="root"></div><script type="module" src="/app.tsx"></script></body></html>',
);
put(
  "fixture.css",
  `@import ${JSON.stringify(join(web, "index.css"))};\n@source ${JSON.stringify(web)};`,
);
put(
  "app.tsx",
  `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import './fixture.css';
import {usageLimitRecoveryBannerItem} from ${JSON.stringify(join(web, "components/chat/UsageLimitRecoveryBanner.tsx"))};
import {TooltipProvider} from ${JSON.stringify(join(web, "components/ui/tooltip.tsx"))};
window.fixture={commands:[],nativeTurns:0};
function Card({title,resetAt,initial}){const [recovery,setRecovery]=useState(initial); const item=usageLimitRecoveryBannerItem({canCheck:true,runId:'run-fixture',resetAt,stoppedAt:'2026-10-08T12:00:00.000Z',snoozedUntil:null,recovery,onChange:async change=>{window.fixture.commands.push(change);setRecovery({...recovery,...change,requestId:'fixture-choice'});}});return <section className="space-y-3 rounded-xl border border-border bg-card p-4"><h2 className="font-medium">{title}</h2><div className="flex items-center gap-2 text-amber-600">{item.icon}<strong>{item.title}</strong></div><p className="text-sm text-muted-foreground">{item.description}</p>{item.actions}</section>}
const resetAt='2099-10-15T18:00:00.000Z',base={runId:'run-fixture',resetAt,autoResume:true,explicitArm:true},observed=status=>({...base,availability:{status,checkedAt:new Date().toISOString(),retryAt:new Date(Date.now()+300000).toISOString(),threadUpdatedAt:new Date().toISOString()}});
function App(){return <TooltipProvider><main className="mx-auto max-w-3xl space-y-5 p-5 text-foreground"><header><p className="text-xs text-muted-foreground">SpecWithCode · isolated component fixture</p><h1 className="mt-2 text-2xl font-semibold">Usage recovery</h1></header><p className="text-sm text-muted-foreground">Recovery checks ordinary usage permission for this profile. A check alone does not start work.</p><Card title="Waiting for permission" resetAt={resetAt} initial={observed('denied')}/><Card title="No reset time reported" resetAt={null} initial={null}/><Card title="Account changed" resetAt={resetAt} initial={observed('changed')}/><Card title="Permission checked, resume optional" resetAt={resetAt} initial={{...observed('allowed'),autoResume:false}}/></main></TooltipProvider>}createRoot(document.getElementById('root')).render(<App/>);`,
);
const { createServer } = await import(req.resolve("vite"));
const { default: tailwind } = await import(req.resolve("@tailwindcss/vite"));
const server = await createServer({
  configFile: false,
  root: fixture,
  cacheDir: join(fixture, ".vite"),
  plugins: [tailwind()],
  resolve: { alias: { "~": web } },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime"] },
  oxc: { jsx: { runtime: "automatic" } },
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: true,
    fs: {
      allow: [
        root,
        fixture,
        resolve(root, "../specweave-studio"),
        resolve(root, "../0885-studio-integrated"),
      ],
    },
  },
});
const { chromium } = createRequire(import.meta.url)(
  join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  ),
);
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const receipt = {
  scope:
    "Actual imported recovery banner; fixture callbacks only, no native inference or installed acceptance",
  headless: true,
  nativeTurns: 0,
  liveServicesChanged: false,
  screenshots: [],
  checks: [],
};
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const [width, theme] of [
    [1440, "dark"],
    [390, "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 1050 },
      colorScheme: theme,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, {
      waitUntil: "networkidle",
    });
    if (theme === "dark") await page.evaluate(() => document.documentElement.classList.add("dark"));
    const section = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "No reset time reported", exact: true }) });
    await section.getByRole("button", { name: "Check now", exact: true }).click();
    await section.getByRole("button", { name: "Check requested", exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.commands), [
      { runId: "run-fixture", resetAt: null, checkNow: true },
    ]);
    await section.getByRole("button", { name: "Resume when available", exact: true }).click();
    await section.getByRole("button", { name: "Cancel auto-resume", exact: true }).waitFor();
    await section.getByRole("button", { name: "Cancel auto-resume", exact: true }).click();
    assert.equal((await page.evaluate(() => window.fixture.commands)).at(-1).autoResume, false);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
    const screenshot = join(out, `recovery-${width}-${theme}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    receipt.screenshots.push(screenshot);
    receipt.checks.push({
      width,
      theme,
      checkOnly: true,
      explicitArmCancel: true,
      noHorizontalOverflow: true,
      pageErrors: errors,
    });
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
writeFileSync(join(out, "browser-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify(receipt));

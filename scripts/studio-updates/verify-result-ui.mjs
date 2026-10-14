// Render the real completion policy and toast in a headless, isolated browser fixture.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.resolve(process.argv[2] ?? ".artifacts/updater-result-ui");
await fs.mkdir(out, { recursive: true });
const fixtures = path.join(root, ".artifacts");
await fs.mkdir(fixtures, { recursive: true });
const fixture = await fs.mkdtemp(path.join(fixtures, "updater-result-"));
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "apps/web/dist/.vite/manifest.json"), "utf8"),
);
const css = manifest["src/main.tsx"]?.css;
assert.ok(css?.length, "Build the production web CSS before running this check");
await fs.writeFile(
  path.join(fixture, "index.html"),
  `<!doctype html><html><head>${css.map((file) => `<link rel="stylesheet" href="/apps/web/dist/${file}">`).join("")}</head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>`,
);
await fs.writeFile(
  path.join(fixture, "main.tsx"),
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { ToastProvider, toastManager, stackedThreadToast } from '/apps/web/src/components/ui/toast';
import { startServiceUpdateProgress, advanceServiceUpdateProgress, serviceUpdateToast } from '/apps/web/src/components/sidebar/SidebarRestartToUpdate.logic';
const waiting = { status:'downloaded', identity:'fixture', installedVersion:'1.0.16', availableVersion:'1.0.17', downloadedVersion:'1.0.17', checkedAt:null, quietSince:null, message:null, lastInstall:null };
let toastId;
window.showResult = (status, result = 'updated') => {
  if (toastId) toastManager.close(toastId);
  const progress = { ...startServiceUpdateProgress(waiting), phase:'requesting', requestedAt:1000 };
  const state = { ...waiting, status, installedVersion:'1.0.17', availableVersion:null, downloadedVersion:null,
    updatedAt:new Date(3000).toISOString(), message:'Could not check the release feed.',
    lastInstall:{version:'1.0.17', result, at:new Date(2000).toISOString()} };
  const next = advanceServiceUpdateProgress(progress, state, 3000);
  const view = serviceUpdateToast(next, false);
  toastId = toastManager.add(stackedThreadToast({ type:view.type, title:view.title, description:view.description, timeout:0,
    ...(view.action === 'retry' ? {actionProps:{children:'Try again'}} : {}) }));
  return {phase:next.phase, title:view.title, action:view.action};
};
function App() { return <ToastProvider><main style={{padding:40}}><h1>Update result verification</h1><p>Isolated fixture using the application’s completion policy and toast component.</p></main></ToastProvider>; }
const route = createRootRoute({component:App});
createRoot(document.getElementById('root')).render(<RouterProvider router={createRouter({routeTree:route})} />);
`,
);
let server, browser;
try {
  server = await createServer({
    configFile: false,
    root,
    resolve: { alias: { "~": path.join(root, "apps/web/src") }, dedupe: ["react", "react-dom"] },
    oxc: { jsx: { runtime: "automatic" } },
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const { chromium } = createRequire(path.join(root, "apps/server/package.json"))(
    "playwright-core",
  );
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.STUDIO_TEST_CHROMIUM ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 720 },
    reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/${path.relative(root, fixture)}/index.html`,
  );
  await page.waitForLoadState("networkidle");
  await page.getByRole("heading", { name: "Update result verification" }).waitFor();
  const settle = async () => {
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
    const bounds = await page.locator('[data-slot="toast-title"]').last().boundingBox();
    assert.ok(
      bounds && bounds.x >= 0 && bounds.x + bounds.width <= 1100,
      "Toast must be fully in view",
    );
  };
  const cases = [];
  for (const status of ["error", "manual-required"]) {
    const result = await page.evaluate((status) => window.showResult(status), status);
    assert.equal(result.phase, "restarting");
    assert.equal(result.action, null);
    assert.equal(
      await page
        .locator('[data-slot="toast-viewport"]')
        .evaluate((el) => getComputedStyle(el).position),
      "fixed",
    );
    await page.getByText("Updated to SpecWithCode 1.0.17", { exact: true }).last().waitFor();
    assert.ok(
      (await page.locator("body").innerText()).includes(
        "Installed successfully. The updater also reported: Could not check the release feed.",
      ),
    );
    assert.equal(await page.getByRole("button", { name: "Try again", exact: true }).count(), 0);
    await settle();
    await page.screenshot({ path: path.join(out, `${status}-after-success.png`), fullPage: true });
    cases.push({ status, ...result });
  }
  const failed = await page.evaluate(() => window.showResult("error", "failed"));
  assert.equal(failed.phase, "failed");
  assert.equal(failed.action, "retry");
  await page.getByText("Could not install SpecWithCode 1.0.17", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
  await settle();
  await page.screenshot({ path: path.join(out, "real-install-failure.png"), fullPage: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(out, "browser.json"),
    JSON.stringify(
      {
        headless: true,
        cases,
        failed,
        pageErrors: errors,
        scope: "Real completion policy and toast; synthetic updater state, no live services",
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Headless completion/toast checks passed (3 cases)");
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(fixture, { recursive: true, force: true });
}

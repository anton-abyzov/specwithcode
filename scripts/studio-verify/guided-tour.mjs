// Headless walk of the guided tour (1486 AC-08) against a real built server on a
// scratch home: no projects, one machine, no agents. Starts the tour from Quick
// guides on Overview, walks every step at 1440x900 dark and 390x844 light, saves
// one screenshot per step and viewport, and fails on a missing required target at
// desktop width, sideways scroll, a page error, a click reaching the page, or Skip
// not returning to Overview. Also checks Back, Esc and the Settings entry.
//
// Build web and server first. Usage:
//   node scripts/studio-verify/guided-tour.mjs /absolute/owned/report-dir
// Optional: STUDIO_PLAYWRIGHT_MODULE (a playwright or playwright-core entry), STUDIO_TEST_CHROMIUM.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

NodeAssert.ok(process.versions.node.startsWith("22."), "Run with Node 22");
process.env.PWDEBUG = "0";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const out = NodePath.resolve(process.argv[2] ?? ".studio-build-evidence/guided-tour");
NodeFS.mkdirSync(out, { recursive: true });
const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-guided-tour-"));
NodeFS.mkdirSync(NodePath.join(state, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(state, "userdata/settings.json"),
  JSON.stringify({ providerInstances: {} }),
);

const port = await new Promise((done, reject) => {
  const socket = NodeNet.createServer();
  socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const { port } = socket.address();
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(root, "apps/server/dist/bin.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
    "--no-browser",
  ],
  {
    cwd: state,
    env: {
      PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: state,
      CODEX_HOME: NodePath.join(state, "codex"),
      CLAUDE_CONFIG_DIR: NodePath.join(state, "claude"),
      XDG_CONFIG_HOME: NodePath.join(state, "config"),
      XDG_CACHE_HOME: NodePath.join(state, "cache"),
      LANG: "en_US.UTF-8",
      PWDEBUG: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const playwrightEntry =
  process.env.STUDIO_PLAYWRIGHT_MODULE ??
  NodePath.join(
    NodeOS.homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
const { chromium } = NodeModule.createRequire(import.meta.url)(playwrightEntry);

const receipt = {
  headless: true,
  realBuiltServer: true,
  scratchHome: true,
  machines: 1,
  projects: 0,
  startedAt: new Date().toISOString(),
  viewports: [],
  checks: [],
};
const check = (name, ok, detail) => {
  receipt.checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new Error(`${name}${detail ? `: ${JSON.stringify(detail)}` : ""}`);
};

let browser;
try {
  const credential = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Scratch server did not become ready")), 45000);
    const observe = (chunk) => {
      output += chunk;
      const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Scratch server exited: ${code}`));
    });
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  let authenticated;
  for (const [name, width, height, theme, desktop] of [
    ["desktop-dark", 1440, 900, "dark", true],
    ["phone-light", 390, 844, "light", false],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      reducedMotion: "reduce",
      storageState: authenticated,
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem("studio:client-settings:v1"))
        localStorage.setItem(
          "studio:client-settings:v1",
          JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
        );
    });
    if (!authenticated) {
      const auth = await context.request.post(`${origin}/api/auth/browser-session`, {
        data: { credential },
        headers: { Origin: origin },
      });
      NodeAssert.equal(auth.status(), 200);
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const view = { name, width, height, theme, steps: [] };
    receipt.viewports.push(view);
    try {
      await page.goto(`${origin}/`);
      const guides = page.getByRole("button", { name: "Quick guides", exact: true });
      await guides.waitFor({ timeout: 20000 });
      await guides.click();
      await page.getByRole("button", { name: "Take the tour", exact: true }).click();
      const overlay = page.locator("[data-guided-tour-overlay]");
      await overlay.waitFor({ timeout: 5000 });
      check(
        `${name}: Quick guides closes before the tour`,
        (await page.getByText("Plan an increment").count()) === 0,
      );

      const total = 14;
      for (let at = 0; at < total; at++) {
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-guided-tour-overlay]")
              ?.getAttribute("data-tour-target") !== "waiting",
          null,
          { timeout: 6000 },
        );
        await page.waitForTimeout(250);
        const info = await page.evaluate(() => {
          const node = document.querySelector("[data-guided-tour-overlay]");
          const card = document.querySelector("[data-guided-tour-card]");
          const ring = document.querySelector("[data-guided-tour-spotlight]");
          const box = card?.getBoundingClientRect();
          const ringBox = ring?.getBoundingClientRect();
          // What a click in the middle of the spotlit target would hit.
          const hit = ringBox
            ? document.elementFromPoint(
                ringBox.left + ringBox.width / 2,
                ringBox.top + ringBox.height / 2,
              )
            : null;
          return {
            step: node?.getAttribute("data-tour-step"),
            target: node?.getAttribute("data-tour-target"),
            path: location.pathname,
            counter: card?.querySelector("p")?.textContent,
            title: card?.querySelector("h2")?.textContent,
            body: card?.querySelector("h2 + p")?.textContent,
            side: card?.getAttribute("data-side"),
            focused: document.activeElement?.textContent?.trim(),
            cardInside:
              !!box &&
              box.left >= 0 &&
              box.top >= 0 &&
              box.right <= innerWidth + 0.5 &&
              box.bottom <= innerHeight + 0.5,
            sideways: document.documentElement.scrollWidth > innerWidth + 1,
            clickReachesPage: hit !== null && !hit.closest("[data-guided-tour-overlay]"),
          };
        });
        const file = `${String(at + 1).padStart(2, "0")}-${info.step}-${name}.png`;
        await page.screenshot({ path: NodePath.join(out, file), animations: "disabled" });
        view.steps.push({ ...info, screenshot: file });
        check(
          `${name} step ${at + 1}: counter`,
          info.counter === `Step ${at + 1} of ${total}`,
          info.counter,
        );
        check(
          `${name} step ${at + 1}: focus on Next`,
          info.focused === (at === total - 1 ? "Done" : "Next"),
          info.focused,
        );
        check(`${name} step ${at + 1}: card on screen`, info.cardInside);
        check(`${name} step ${at + 1}: no sideways scroll`, !info.sideways);
        check(`${name} step ${at + 1}: page clicks blocked`, !info.clickReachesPage);
        if (desktop)
          check(
            `${name} step ${at + 1} (${info.step}): required target found`,
            info.target !== "missing",
            info,
          );
        if (at === 2) {
          // Back returns to the previous step's page and target, then Next comes back.
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await page.waitForFunction(
            () =>
              document
                .querySelector("[data-guided-tour-overlay]")
                ?.getAttribute("data-tour-step") === "projects",
          );
          check(
            `${name}: Back opens the previous step's page`,
            new URL(page.url()).pathname === "/",
          );
          await page.keyboard.press("ArrowRight");
          await page.waitForFunction(
            () =>
              document
                .querySelector("[data-guided-tour-overlay]")
                ?.getAttribute("data-tour-step") === "project-settings",
          );
          await page.waitForFunction(
            () =>
              document
                .querySelector("[data-guided-tour-overlay]")
                ?.getAttribute("data-tour-target") !== "waiting",
          );
        }
        if (at < total - 1) await page.getByRole("button", { name: "Next", exact: true }).click();
      }
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await overlay.waitFor({ state: "detached", timeout: 5000 });
      await page.waitForURL(`${origin}/`, { timeout: 5000 });
      check(`${name}: Done returns to Overview`, new URL(page.url()).pathname === "/");

      // Skip from the middle also returns to where the tour started.
      await page.getByRole("button", { name: "Quick guides", exact: true }).click();
      await page.getByRole("button", { name: "Take the tour", exact: true }).click();
      for (let at = 0; at < 5; at++)
        await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Skip tour", exact: true }).click();
      await overlay.waitFor({ state: "detached", timeout: 5000 });
      await page.waitForURL(`${origin}/`, { timeout: 5000 });
      check(`${name}: Skip returns to Overview`, new URL(page.url()).pathname === "/");

      // Settings > General > Guided tour starts it again; Esc ends it there.
      await page.goto(`${origin}/settings/general`);
      const again = page.locator("#guided-tour [data-guided-tour-start]");
      await again.waitFor({ timeout: 15000 });
      await again.click();
      await overlay.waitFor({ timeout: 5000 });
      await page.keyboard.press("Escape");
      await overlay.waitFor({ state: "detached", timeout: 5000 });
      check(
        `${name}: Esc ends the tour and stays in Settings`,
        new URL(page.url()).pathname === "/settings/general",
      );
      check(`${name}: no page errors`, errors.length === 0, errors);
      authenticated ??= await context.storageState();
    } catch (error) {
      await page
        .screenshot({ path: NodePath.join(out, `failure-${name}.png`), animations: "disabled" })
        .catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  receipt.ok = true;
} catch (error) {
  receipt.ok = false;
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  NodeFS.writeFileSync(NodePath.join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await browser?.close().catch(() => {});
  child.kill("SIGTERM");
  NodeFS.rmSync(state, { recursive: true, force: true });
  console.log(receipt.ok ? `guided tour: ok, ${out}` : `guided tour: FAILED ${receipt.error}`);
}

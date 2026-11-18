#!/usr/bin/env node
// Headless crawler that opens every popup it can reach in the real app and shoots it.
// Private server from a built dist, throwaway HOME and base dir, disabled providers, a synthetic
// project, no provider turns, no paired machines. Never touches real user data.
// Usage (from the repository root):
//   node apps/web/tests/popup-standard/capture-app.mjs /absolute/out-dir \
//     [--dist apps/server/dist] [--label before|after] [--views name,name] [--sizes 840,2000]
//     [--list 1]   (print the triggers each view would click, click nothing)
// Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's playwright-core;
// STUDIO_CHROMIUM_EXECUTABLE picks a browser binary. Writes <out>/<label>/capture.json and
// shots named <label>/<view>__<trigger>__<width>-<theme>.png. CAPTURE_DUMP=1 logs each
// view's buttons, for finding triggers the generic rules miss.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the project's Node 22 runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const opts = {};
const positional = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith("--")) opts[arg.slice(2)] = process.argv[++i];
  else positional.push(arg);
}
const dist = resolve(opts.dist ?? "apps/server/dist");
const label = opts.label ?? "before";
assert.ok(["before", "after"].includes(label), "--label must be before or after");
assert.ok(existsSync(join(dist, "bin.mjs")), `No bin.mjs in ${dist}`);
assert.ok(positional[0], "Pass an absolute output directory");
const outRoot = resolve(positional[0]);
const out = join(outRoot, label);
// The label folder is this script's own output: a rerun replaces it whole.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const ONLY_VIEWS = (opts.views ?? "").split(",").filter(Boolean);
const SIZE_FILTER = (opts.sizes ?? "").split(",").filter(Boolean);

const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(resolve("apps/server/package.json"))("playwright-core");

const SIZES = [
  { width: 840, height: 720 },
  { width: 2000, height: 1200 },
].filter((s) => !SIZE_FILTER.length || SIZE_FILTER.includes(String(s.width)));
const THEMES = ["light", "dark"];
const MARGIN = 8;
const POPUP =
  '[data-slot$="-popup"]:not([data-slot="tooltip-popup"]), [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';
// Destructive or outward names. Never clicked, not even to see a popup.
const UNSAFE =
  /delete|remove|sign out|log ?out|reset|uninstall|send|publish|release|pay|quit|update now|archive|discard|revoke|disconnect|stop|kill|wipe|erase/i;
// Buttons without popup markup that usually open one: clicked as probes. A probe that opens
// nothing is listed apart from real failures.
const PROBE =
  /^(add|new|edit|choose|pick|change|configure|customi[sz]e|rename|manage|filter|sort|search|find|project settings|show where|more)\b/i;
// Probes that could start work, spawn a login, touch the file system or leave the app.
const PROBE_UNSAFE =
  /connect|sign ?in|log ?in|install|open|reveal|launch|run|start|test|retry|refresh|sync|import|export|copy|download|upload|pair|approve|allow|deny|enable|disable|restart|attach|new chat|new thread|new session|copilot|github|find agents|detect|scan/i;
const SETTINGS = [
  "general",
  "appearance",
  "agents",
  "providers",
  "connections",
  "projects",
  "archived",
  "source-control",
  "keybindings",
  "privacy",
  "storage",
  "diagnostics",
  "scheduled-tasks",
  "skills",
  "messaging",
  "integrations",
];
// Settings pages the contrast audit does not list; cheap to visit too.
const EXTRA_SETTINGS = ["machines", "models", "mods", "design-systems", "google", "chrome"];

const scratch = mkdtempSync(join(tmpdir(), "popup-capture-"));
const data = join(scratch, "data");
const workspace = join(scratch, "workspace");
mkdirSync(join(data, "userdata"), { recursive: true });
mkdirSync(workspace);
writeFileSync(join(workspace, "README.md"), "Synthetic popup fixture.\n");
const drivers = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
writeFileSync(
  join(data, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: Object.fromEntries(
      drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
    ),
  }),
);

const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => done(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [
    join(dist, "bin.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    data,
    "--no-browser",
  ],
  {
    cwd: scratch,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: scratch,
      LANG: "en_US.UTF-8",
      STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

// Interrupted: stop the private server and drop the scratch folder anyway.
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
    process.exit(130);
  });

const slug = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unnamed";

// In-page: find visible popup triggers outside open menus, tag them, return their signatures.
function findTriggers({ unsafeSource, probeSource, probeUnsafeSource, probeAllowSource, scope }) {
  const unsafe = new RegExp(unsafeSource, "i");
  const probeAllow = probeAllowSource ? new RegExp(probeAllowSource) : null;
  const probe = new RegExp(probeSource, "i");
  const probeUnsafe = new RegExp(probeUnsafeSource, "i");
  const menuish =
    '[role="menu"], [role="listbox"], [data-slot="menu-popup"], [data-slot="select-popup"], [data-slot="popover-popup"], [data-slot="combobox-popup"]';
  const selector = [
    "[aria-haspopup]",
    '[data-slot="menu-trigger"]',
    '[data-slot="popover-trigger"]',
    '[data-slot="select-trigger"]',
    '[data-slot="combobox-trigger"]',
    "button",
    '[role="button"]',
    '[role="combobox"]',
  ].join(",");
  const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const nameOf = (el) => {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const joined = labelled
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .join(" ")
        .trim();
      if (joined) return joined;
    }
    return (
      el.getAttribute("aria-label")?.trim() ||
      text(el) ||
      el.getAttribute("title")?.trim() ||
      el.getAttribute("placeholder")?.trim() ||
      el.querySelector("[aria-label]")?.getAttribute("aria-label")?.trim() ||
      ""
    ).slice(0, 80);
  };
  const root = scope ? (document.querySelector(scope) ?? document) : document;
  document.querySelectorAll("[data-cap-id]").forEach((el) => el.removeAttribute("data-cap-id"));
  const found = [];
  const seen = new Set();
  // Rows of the same control (a shortcut list): at most two per stem, such as "Edit shortcut".
  const stems = new Map();
  for (const el of root.querySelectorAll(selector)) {
    if (el.closest(menuish)) continue;
    if (el.closest('[aria-hidden="true"], [inert]')) continue;
    if (el.getAttribute("role") === "tab") continue;
    // Text fields with role=combobox (search, composer) open on typing, not on a click.
    if (el.matches("input, textarea, [contenteditable=true]")) continue;
    const rect = el.getBoundingClientRect();
    // Below the fold counts too: the click scrolls the trigger into view.
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none")
      continue;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, visibilityProperty: true }))
      continue;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    const name = nameOf(el);
    if (!name || unsafe.test(name)) continue;
    const haspopup = el.getAttribute("aria-haspopup");
    const dataSlot = el.getAttribute("data-slot") ?? "";
    const marked =
      (haspopup && haspopup !== "false") ||
      /^(menu|popover|select|combobox)-trigger$/.test(dataSlot) ||
      el.getAttribute("role") === "combobox";
    // Matched by name only: the probe safety list applies, as it does to probes.
    const named = !marked && (/(…|\.\.\.)$/.test(name) || /\bMore\b/.test(name));
    if (named && probeUnsafe.test(name)) continue;
    const isProbe =
      !marked &&
      !named &&
      probe.test(name) &&
      !probeUnsafe.test(name) &&
      (!probeAllow || probeAllow.test(name));
    if (!marked && !named && !isProbe) continue;
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const sig = `${role}|${name}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const stem = name
      .split(/ for |:/)[0]
      .trim()
      .toLowerCase();
    if ((stems.get(stem) ?? 0) >= 2) continue;
    stems.set(stem, (stems.get(stem) ?? 0) + 1);
    const id = String(found.length);
    el.setAttribute("data-cap-id", id);
    const shell = Boolean(el.closest('[data-sidebar="sidebar"], .sws-sidebar'));
    found.push({ id, sig, role, name, probe: isProbe, shell });
  }
  return found;
}

// In-page: tag the visible popups already open so a new one can be told apart.
function markPopups({ popupSelector }) {
  document.querySelectorAll("[data-cap-pre]").forEach((el) => el.removeAttribute("data-cap-pre"));
  for (const el of document.querySelectorAll(popupSelector)) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) el.setAttribute("data-cap-pre", "1");
  }
}

// In-page: the outermost visible popup not tagged before the click.
function newPopup({ popupSelector }) {
  const fresh = [...document.querySelectorAll(popupSelector)].filter((el) => {
    if (el.hasAttribute("data-cap-pre")) return false;
    if (el.closest('[data-slot="tooltip-popup"]')) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
  const outer = fresh.filter((el) => !fresh.some((other) => other !== el && other.contains(el)));
  if (!outer.length) return null;
  const el = outer[0];
  const rect = el.getBoundingClientRect();
  const inner = el.querySelector(
    '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
  );
  return {
    slot: el.getAttribute("data-slot"),
    role: el.getAttribute("role") ?? inner?.getAttribute("role") ?? null,
    box: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

// The first line of a Playwright error plus the line that says what blocked the click.
const whyFailed = (error) => {
  const lines = String(error?.message ?? error).split("\n");
  const cause = lines.find((l) =>
    /intercepts pointer|not visible|outside of the viewport|not stable|detached/.test(l),
  );
  return [lines[0], cause?.trim()].filter(Boolean).join(" / ").slice(0, 300);
};

const kindOf = (popup) => {
  if (popup.slot) return popup.slot.replace(/-popup$/, "");
  return (
    { menu: "menu", listbox: "listbox", dialog: "dialog", alertdialog: "alert-dialog" }[
      popup.role
    ] ?? "unknown"
  );
};
// The standard's largest width per kind (docs/studio/design-guidelines.md, Popups): menus up to
// their xl token, lists their trigger's width or 24rem, whichever is wider.
const capOf = (kind, triggerWidth = 0) =>
  /select|combobox|listbox/.test(kind) ? Math.max(384, Math.ceil(triggerWidth)) : 512;

const results = [];
const failed = [];
const probesWithoutPopup = [];
const skipped = [
  {
    view: "thread",
    combo: "all",
    reason:
      "A real thread needs thread.create over the WebSocket RPC with a provider model, and its timeline needs a provider turn; providers are disabled, so draft-thread (/draft/...) stands in.",
  },
];
// One file name per (view, role, trigger); a slug clash (long or same-name labels) gets -2, -3.
const shotBases = new Map();
const shotBase = (view, trigger) => {
  const key = `${view}|${trigger.sig}`;
  if (!shotBases.has(key)) {
    const taken = new Set(shotBases.values());
    let base = `${view}__${slug(trigger.name)}`;
    for (let n = 2; taken.has(base); n += 1) base = `${view}__${slug(trigger.name)}-${n}`;
    shotBases.set(key, base);
  }
  return shotBases.get(key);
};
// Native <select> menus are drawn by the OS, so no screenshot can show them: listed, not opened.
const nativeSelects = new Map();
let browser;
try {
  const credential = await new Promise((done, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Private server did not become ready")), 45000);
    const observe = (chunk) => {
      buffer = (buffer + chunk).slice(-65536);
      const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => reject(new Error(`Private server exited: ${code}`)));
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
      : {}),
  });

  const projectId = randomUUID();
  const projectTitle = "popup-fixture";
  let storageState;
  {
    const context = await browser.newContext();
    const auth = await context.request.post(origin + "/api/auth/browser-session", {
      data: { credential },
      headers: { Origin: origin },
    });
    assert.equal(auth.status(), 200, "browser-session sign-in failed");
    const created = await context.request.post(origin + "/api/projects/mutate", {
      data: {
        type: "project.create",
        commandId: randomUUID(),
        projectId,
        title: projectTitle,
        workspaceRoot: workspace,
        // The private server is throwaway; "user" keeps the temp-folder project in the main list.
        origin: "user",
      },
      headers: { Origin: origin },
    });
    assert.equal(created.status(), 200, `project.create failed: ${await created.text()}`);
    storageState = await context.storageState();
    await context.close();
  }

  const settle = async (page) => {
    await page.waitForSelector("main, [role=main], h1, h2", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(900);
  };
  const goto = async (page, path) => {
    await page.goto(origin + path, { waitUntil: "load" }).catch(() => {});
    await settle(page);
  };
  let projectPath = null;
  const openProject = async (page) => {
    if (projectPath) await goto(page, projectPath);
    else {
      await goto(page, "/");
      await page.getByText(projectTitle).first().click({ timeout: 15000 });
      await settle(page);
      projectPath = new URL(page.url()).pathname;
    }
    await page.getByRole("button", { name: "Project settings" }).waitFor({ timeout: 15000 });
  };
  const ensureOverviewShown = async (page) => {
    const toggle = page.getByRole("button", { name: "Overview", exact: true }).first();
    if ((await toggle.getAttribute("aria-pressed").catch(() => null)) === "false")
      await toggle.click().catch(() => {});
  };
  const projectTab = (tab) => async (page) => {
    await openProject(page);
    await ensureOverviewShown(page);
    await page.locator(`[role="tab"][data-tab="${tab}"]`).click({ timeout: 8000 });
    await page.waitForTimeout(800);
  };
  const DIALOG = '[role="dialog"]';
  const settingsTab = (tab) => async (page) => {
    await openProject(page);
    await page.getByRole("button", { name: "Project settings" }).click();
    await page.locator(DIALOG).first().waitFor({ timeout: 10000 });
    if (tab) {
      const button = page.locator(DIALOG).getByRole("button", { name: tab, exact: true }).first();
      if (!(await button.isVisible().catch(() => false)))
        throw new Error(`No ${tab} tab in Project settings`);
      await button.click();
    }
    await page.waitForTimeout(700);
  };
  const dialogReady = (page) =>
    page
      .locator(DIALOG)
      .first()
      .isVisible()
      .catch(() => false);

  // Each view: how to open it, an optional scope for its triggers, and a check it is still open.
  const VIEWS = [
    { name: "root", open: (page) => goto(page, "/") },
    {
      name: "project",
      open: async (page) => {
        await openProject(page);
        await ensureOverviewShown(page);
      },
    },
    ...["designs", "board", "library", "prs", "scheduled"].map((tab) => ({
      name: `project-${tab}`,
      open: projectTab(tab),
      scope: "#sws-pane-" + tab,
    })),
    {
      name: "project-coordinator",
      family: "project",
      // The coordinator alone, the overview panel hidden.
      open: async (page) => {
        await openProject(page);
        const toggle = page.getByRole("button", { name: "Overview", exact: true }).first();
        if ((await toggle.getAttribute("aria-pressed")) !== "false") await toggle.click();
        await page.waitForTimeout(700);
      },
      after: ensureOverviewShown,
    },
    ...[null, "Memory", "Environment", "Usage", "Routines"].map((tab) => ({
      name: tab ? `project-settings-${tab.toLowerCase()}` : "project-settings",
      family: "project-settings",
      open: settingsTab(tab),
      scope: DIALOG,
      ready: dialogReady,
    })),
    {
      name: "draft-thread",
      open: async (page) => {
        await openProject(page);
        await page.locator(".sws-side-row", { hasText: "New chat" }).first().click();
        await page.waitForURL(/\/draft\//, { timeout: 10000 });
        await settle(page);
      },
    },
    ...[...SETTINGS, ...EXTRA_SETTINGS].map((s) => ({
      name: `settings-${s}`,
      open: (page) => goto(page, `/settings/${s}`),
      // Featured providers' "Add <name>" and "Manage <name>" install or configure an agent:
      // on this page only the probes known to open a dialog are clicked.
      ...(s === "providers"
        ? { probeAllow: /^(Add provider|Add variable|Add custom model|Add hub)$/ }
        : {}),
    })),
    { name: "usage", open: (page) => goto(page, "/usage") },
    { name: "pull-requests", open: (page) => goto(page, "/pull-requests") },
    { name: "design", open: (page) => goto(page, "/design") },
  ].filter((v) => !ONLY_VIEWS.length || ONLY_VIEWS.includes(v.name));

  const openPopup = (page) => page.evaluate(newPopup, { popupSelector: POPUP }).catch(() => null);
  const closePopups = async (page) => {
    for (let i = 0; i < 3; i += 1) {
      if (!(await openPopup(page))) return true;
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(250);
    }
    if (!(await openPopup(page))) return true;
    await page.mouse.click(4, page.viewportSize().height - 4).catch(() => {});
    await page.waitForTimeout(250);
    return !(await openPopup(page));
  };

  for (const size of SIZES) {
    for (const theme of THEMES) {
      const combo = `${size.width}-${theme}`;
      const context = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: "reduce",
        storageState,
      });
      await context.addInitScript(() => {
        if (!localStorage.getItem("studio:client-settings:v1"))
          localStorage.setItem(
            "studio:client-settings:v1",
            JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
          );
      });
      // Never follow the app out: new windows close, file pickers and alerts are dismissed.
      const page = await context.newPage();
      context.on("page", (other) => other !== page && other.close().catch(() => {}));
      page.on("dialog", (d) => d.dismiss().catch(() => {}));
      page.on("filechooser", () => {});
      const shellDone = new Set();
      // Triggers already shot on an earlier view of the same family (the shared project header).
      const familyDone = new Map();
      // A route that redirects to one already crawled (settings/machines → connections).
      const crawledPaths = new Map();
      for (const view of VIEWS) {
        const openView = async () => {
          await view.open(page);
          // Collapsed sections (<details>, as in Settings) hide their controls: open them all.
          const opened = await page.evaluate(() => {
            const closed = [...document.querySelectorAll("details:not([open])")];
            closed.forEach((d) => (d.open = true));
            return closed.length;
          });
          if (opened) await page.waitForTimeout(400);
          await page.evaluate(markPopups, { popupSelector: POPUP });
          return new URL(page.url()).pathname;
        };
        let viewPath;
        try {
          viewPath = await openView();
        } catch (error) {
          skipped.push({
            view: view.name,
            combo,
            reason: String(error.message ?? error).split("\n")[0],
          });
          continue;
        }
        if (!view.scope && !view.family && crawledPaths.has(viewPath)) {
          skipped.push({
            view: view.name,
            combo,
            reason: `same page as ${crawledPaths.get(viewPath)} (${viewPath})`,
          });
          continue;
        }
        if (!view.scope && !view.family) crawledPaths.set(viewPath, view.name);
        const finder = {
          unsafeSource: UNSAFE.source,
          probeSource: PROBE.source,
          probeUnsafeSource: PROBE_UNSAFE.source,
          scope: view.scope ?? null,
          probeAllowSource: view.probeAllow?.source ?? null,
        };
        if (process.env.CAPTURE_DUMP)
          console.log(
            view.name,
            await page.evaluate(() =>
              [...document.querySelectorAll("button, [role=button], [role=combobox]")]
                .filter((el) => el.getBoundingClientRect().width > 0)
                .map((el) => el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "").slice(0, 220))
                .join("\n"),
            ),
          );
        // The sidebar is on every page: its triggers are captured once, on the first view.
        const family = familyDone.get(view.family ?? view.name) ?? new Set();
        const triggers = (await page.evaluate(findTriggers, finder)).filter(
          (t) => !(t.shell && shellDone.has(t.sig)) && !family.has(t.sig),
        );
        triggers.forEach((t) => family.add(t.sig));
        familyDone.set(view.family ?? view.name, family);
        triggers.filter((t) => t.shell).forEach((t) => shellDone.add(t.sig));
        for (const name of await page.evaluate((scope) => {
          const root = scope ? (document.querySelector(scope) ?? document) : document;
          return [...root.querySelectorAll("select")]
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map(
              (el) =>
                el.getAttribute("aria-label") ||
                el.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim() ||
                el.name ||
                "unnamed select",
            );
        }, view.scope ?? null))
          nativeSelects.set(`${view.name} | ${name}`, true);
        let shots = 0;
        // --list: print what would be clicked and click nothing (vets names before a run).
        if (opts.list !== undefined) {
          console.log(
            `${combo} ${view.name}: ${triggers.map((t) => `${t.probe ? "?" : ""}${t.name}`).join(" | ")}`,
          );
          continue;
        }
        for (const trigger of triggers) {
          const record = { view: view.name, trigger: trigger.name, width: size.width, theme };
          try {
            // Re-find by signature: the page may have re-rendered or been reloaded.
            const match = (await page.evaluate(findTriggers, finder)).find(
              (t) => t.sig === trigger.sig,
            );
            if (!match) {
              failed.push({ ...record, reason: "trigger not found after reset" });
              continue;
            }
            await page.evaluate(markPopups, { popupSelector: POPUP });
            const triggerBox = await page.locator(`[data-cap-id="${match.id}"]`).boundingBox();
            await page.locator(`[data-cap-id="${match.id}"]`).click({ timeout: 4000 });
            const popup = await page
              .waitForFunction(newPopup, { popupSelector: POPUP }, { timeout: 2500 })
              .then((h) => h.jsonValue())
              .catch(() => null);
            if (!popup) {
              (trigger.probe ? probesWithoutPopup : failed).push({
                ...record,
                reason: "no popup appeared",
              });
            } else {
              await page.waitForTimeout(300);
              const final = (await openPopup(page)) ?? popup;
              const kind = kindOf(final);
              const { box } = final;
              const inside =
                box.x >= MARGIN &&
                box.y >= MARGIN &&
                box.x + box.width <= size.width - MARGIN &&
                box.y + box.height <= size.height - MARGIN;
              const base = shotBase(view.name, trigger);
              const shot = join(label, `${base}__${combo}.png`);
              await page.screenshot({ path: join(outRoot, shot), animations: "disabled" });
              shots += 1;
              results.push({
                view: view.name,
                trigger: trigger.name,
                triggerRole: trigger.role,
                probe: trigger.probe,
                kind,
                role: final.role,
                width: size.width,
                theme,
                viewport: size,
                box,
                inside,
                triggerWidth: triggerBox ? Math.round(triggerBox.width) : null,
                overCap: box.width > capOf(kind, triggerBox?.width) + 1,
                shot,
              });
            }
          } catch (error) {
            failed.push({ ...record, reason: whyFailed(error) });
          }
          // Reset: close what opened, then make sure the view is still the same.
          const closed = await closePopups(page);
          const moved = new URL(page.url()).pathname !== viewPath;
          const ready = view.ready ? await view.ready(page) : true;
          if (!closed || moved || !ready) {
            try {
              await openView();
            } catch (error) {
              skipped.push({ view: view.name, combo, reason: `reopen failed: ${error.message}` });
              break;
            }
          } else {
            await page.evaluate(markPopups, { popupSelector: POPUP });
          }
        }
        await view.after?.(page).catch(() => {});
        console.log(`${combo} ${view.name}: ${triggers.length} triggers, ${shots} shots`);
      }
      await context.close();
    }
  }
} finally {
  const distinct = new Map();
  for (const r of results) {
    const key = `${r.view}|${r.triggerRole}|${r.trigger}`;
    if (!distinct.has(key)) distinct.set(key, r.kind);
  }
  const totals = {};
  for (const kind of distinct.values()) totals[kind] = (totals[kind] ?? 0) + 1;
  const opened = (f) => results.some((r) => r.view === f.view && r.trigger === f.trigger);
  const unique = (list) => [
    ...new Map(
      list
        .filter((f) => !opened(f))
        .map((f) => [
          `${f.view}|${f.trigger}`,
          { view: f.view, trigger: f.trigger, reason: f.reason },
        ]),
    ).values(),
  ];
  const widest = [...results]
    .filter((r) => r.width === 2000)
    .sort((a, b) => b.box.width - a.box.width)
    .filter((r, i, all) => all.findIndex((o) => o.view === r.view && o.trigger === r.trigger) === i)
    .slice(0, 10)
    .map((r) => ({ view: r.view, trigger: r.trigger, kind: r.kind, px: r.box.width }));
  const capture = {
    label,
    dist,
    headless: true,
    providerTurns: 0,
    sizes: SIZES,
    themes: THEMES,
    margin: MARGIN,
    caps: {
      menu: 512,
      popover: 512,
      select: "max(384, trigger)",
      combobox: "max(384, trigger)",
      listbox: "max(384, trigger)",
      dialog: 512,
    },
    distinctPopups: distinct.size,
    totalsByKind: totals,
    overCapAt2000: [
      ...new Set(
        results.filter((r) => r.width === 2000 && r.overCap).map((r) => `${r.view} | ${r.trigger}`),
      ),
    ],
    outsideViewport: [
      ...new Set(
        results.filter((r) => !r.inside).map((r) => `${r.view} | ${r.trigger} | ${r.width}`),
      ),
    ],
    widestAt2000: widest,
    failedToOpen: unique(failed),
    nativeSelects: [...nativeSelects.keys()],
    probesWithoutPopup: unique(probesWithoutPopup),
    skippedViews: [...new Map(skipped.map((s) => [`${s.view}|${s.reason}`, s])).values()],
    failures: failed,
    results,
  };
  writeFileSync(join(out, "capture.json"), JSON.stringify(capture, null, 2) + "\n");
  await browser?.close().catch(() => {});
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((done) => setTimeout(done, 5000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  rmSync(scratch, { recursive: true, force: true });
  console.log(`Distinct popups: ${distinct.size} ${JSON.stringify(totals)}`);
  console.log(`Capture: ${join(out, "capture.json")}`);
}

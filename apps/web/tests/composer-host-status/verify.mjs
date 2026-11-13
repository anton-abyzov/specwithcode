// Build first: vp build --config apps/web/tests/composer-host-status/vite.config.ts
// Usage: node apps/web/tests/composer-host-status/verify.mjs [/absolute/evidence-dir] [--before]
// Always headless. Playwright comes from STUDIO_PLAYWRIGHT_MODULE, else apps/server's
// playwright-core; STUDIO_CHROMIUM_EXECUTABLE picks a browser binary.
// --before only measures and shoots (the old composer fails these checks on purpose).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : createRequire(path.resolve("apps/server/package.json"))("playwright-core");
const args = process.argv.slice(2);
const before = args.includes("--before");
const label = before ? "before" : "after";
const output = path.resolve(
  args.find((a) => !a.startsWith("--")) ?? ".artifacts/composer-host-status/evidence",
);
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/composer-host-status/site");
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    assert(file.startsWith(root + path.sep));
    res.setHeader(
      "Content-Type",
      { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" }[
        path.extname(file)
      ] ?? "text/html",
    );
    res.end(await fs.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});

const LONG = "build-server-for-the-specwithcode-release-train-and-nightly-e2e-01";
const CJK = "東京オフィスの開発用マシン二号機";
const EMOJI = "🚀 Rocket Mac 🍎";
const OFFLINE_STATES = [
  "offline",
  "reconnecting",
  "connecting",
  "signed-out",
  "this-device",
  "this-device-stopped",
];
/** Everything this runner looks at in one composer, measured in the page. */
async function measure(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const hit = (a, b) =>
      a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const form = document.querySelector(".sws-composer");
    const input = document.querySelector("#project-prompt");
    const card = document.querySelector(".sws-composer-card");
    // Text cut off without an ellipsis and a full-text title is clipped.
    const clipped = [];
    for (const el of form.querySelectorAll("*")) {
      if (!visible(el) || el.closest("textarea") || el.closest(".sr-only")) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      const s = getComputedStyle(el);
      if (s.overflowX === "visible" && s.overflow === "visible") continue;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      const ellipsis = s.textOverflow === "ellipsis";
      // A cut-off machine name gets its full name as a title on hover (checked below).
      const titled =
        el.closest("[title]")?.getAttribute("title")?.length > 0 ||
        el.matches("[data-machine-name]");
      if (own && ellipsis && titled) continue;
      if (!own && !el.textContent.trim()) continue;
      clipped.push({
        text: el.textContent.trim().slice(0, 80),
        cls: String(el.className).slice(0, 60),
      });
    }
    // Each status line the composer shows: the new one, or the old banner and chip text.
    const statuses = [
      ...form.querySelectorAll("[data-host-status], [role=status], [data-orchestrator-status]"),
    ]
      .filter(visible)
      .filter((el) => !el.closest(".sr-only"))
      .filter((el) => el.innerText.trim())
      .filter((el) => !el.parentElement?.closest("[data-host-status], [role=status]"));
    const popups = [
      ...document.querySelectorAll(
        '[data-slot="tooltip-popup"], [role="tooltip"], [data-host-status-detail]',
      ),
    ].filter(visible);
    const inputBox = box(card ?? input);
    const covering = popups.filter((p) => !card.contains(p) && hit(box(p), inputBox));
    const send = document.querySelector(".sws-send");
    return {
      scrollFits: document.documentElement.scrollWidth <= innerWidth,
      clipped,
      statusTexts: statuses.map((el) => el.innerText.trim().replace(/\s+/g, " ")),
      statusOverInput: statuses.some((el) => !card.contains(el) && hit(box(el), inputBox)),
      covering: covering.map((p) => p.textContent.trim().slice(0, 80)),
      sendDisabled: send?.disabled ?? null,
      sendText: send ? getComputedStyle(send, "::after").content : null,
      placeholder: input.getAttribute("placeholder"),
      formRight: box(form).right,
      innerWidth,
    };
  });
}

const receipt = { label, headless: true, scenarios: [] };
const failures = [];
function check(name, ok, detail) {
  receipt.scenarios.at(-1).checks.push({ name, ok, detail });
  if (!ok) failures.push(`${receipt.scenarios.at(-1).id}: ${name} ${JSON.stringify(detail)}`);
}

async function scenario({ id, query, width = 1100, theme = "light", expectOffline, act }) {
  const page = await browser.newPage({ viewport: { width, height: 760 }, colorScheme: theme });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${origin}/?theme=${theme}&${query}`);
  await page.locator("#project-prompt").waitFor();
  await page.waitForTimeout(120);
  receipt.scenarios.push({ id, query, width, theme, checks: [] });
  if (act) await act(page);
  const m = await measure(page);
  const shot = path.join(output, `${label}-${id}.png`);
  await page.screenshot({ path: shot, animations: "disabled" });
  // Hover and focus the Runs on chip: nothing it opens may sit on the message box.
  const chip = page.locator("[data-coordinator-machine]");
  let hovered = { covering: [] };
  if (await chip.count()) {
    await chip.hover();
    await page.waitForTimeout(900);
    hovered = await measure(page);
    await page.screenshot({
      path: path.join(output, `${label}-${id}-hover.png`),
      animations: "disabled",
    });
    await page.mouse.move(0, 0);
  }
  Object.assign(receipt.scenarios.at(-1), { measured: m, hoverCovering: hovered.covering, shot });
  const name = page.locator("[data-machine-name]");
  if ((await name.count()) && (await name.evaluate((el) => el.scrollWidth > el.clientWidth))) {
    await name.hover();
    check(
      "a cut-off name shows in full on hover",
      (await name.getAttribute("title")) === (await name.textContent()),
      await name.getAttribute("title"),
    );
    await page.mouse.move(0, 0);
  }
  check("no page errors", errors.length === 0, errors);
  check("no horizontal page scroll", m.scrollFits, { innerWidth: m.innerWidth });
  check("no clipped text", m.clipped.length === 0, m.clipped);
  check("nothing covers the message box on hover", hovered.covering.length === 0, hovered.covering);
  check("status never sits on the message box", !m.statusOverInput, m.statusTexts);
  if (expectOffline && !before) {
    const toggle = page.locator(".sws-host-status-toggle");
    if (await toggle.count()) {
      await toggle.click();
      await page.locator("[data-host-status-detail]").waitFor();
      const opened = await measure(page);
      await page.screenshot({
        path: path.join(output, `${label}-${id}-details.png`),
        animations: "disabled",
      });
      check(
        "details open in place, over nothing",
        opened.covering.length === 0 && !opened.statusOverInput,
        opened.covering,
      );
      check(
        "details clip nothing",
        opened.clipped.length === 0 && opened.scrollFits,
        opened.clipped,
      );
      check("details keep one status", opened.statusTexts.length === 1, opened.statusTexts);
      check(
        "details have no em dash",
        !(await page.locator("[data-host-status-detail]").textContent()).includes("\u2014"),
        null,
      );
      await toggle.click();
    }
  }
  if (expectOffline) {
    check("exactly one status message", m.statusTexts.length === 1, m.statusTexts);
    check("send disabled", m.sendDisabled === true, m.sendDisabled);
    check(
      "send names no machine while offline",
      m.sendText === "none" || m.sendText === "normal",
      m.sendText,
    );
  } else {
    check("no status message while online", m.statusTexts.length === 0, m.statusTexts);
  }
  await page.close();
  return m;
}

try {
  // States x widths x themes.
  for (const theme of ["light", "dark"])
    for (const width of [1100, 600, 390])
      for (const state of ["online", ...OFFLINE_STATES])
        await scenario({
          id: `${state}-${width}-${theme}`,
          query: `state=${state}&synced=0`,
          width,
          theme,
          expectOffline: state !== "online",
        });
  // Names that break layouts.
  for (const [key, name] of [
    ["long", LONG],
    ["cjk", CJK],
    ["emoji", EMOJI],
  ])
    for (const width of [1100, 390])
      await scenario({
        id: `name-${key}-${width}-dark`,
        query: `state=reconnecting&synced=12&name=${encodeURIComponent(name)}`,
        width,
        theme: "dark",
        expectOffline: true,
      });
  // Every shipped language, reconnecting with an hours-old sync.
  for (const lang of ["es", "de", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"])
    for (const width of [600, 390])
      await scenario({
        id: `lang-${lang}-${width}`,
        query: `state=reconnecting&synced=190&lang=${lang}`,
        width,
        theme: lang === "de" || lang === "ru" ? "dark" : "light",
        expectOffline: true,
      });
  // The longest headlines, with no machine name to give way, at phone width.
  for (const lang of ["de", "ru", "fr", "pt-BR"])
    for (const state of ["this-device", "this-device-stopped", "signed-out"])
      await scenario({
        id: `lang-${lang}-${state}-390`,
        query: `state=${state}&lang=${lang}`,
        width: 390,
        theme: "dark",
        expectOffline: true,
      });
  // Never synced.
  await scenario({
    id: "never-synced-600",
    query: "state=offline&synced=unknown",
    width: 600,
    expectOffline: true,
  });
  // Runs on switched to this device's own copy: connected, so no status.
  for (const width of [1100, 390])
    await scenario({
      id: `runs-on-this-mac-${width}`,
      query: "view=this-mac",
      width,
      expectOffline: false,
    });
  // Typing while offline: the draft stays, Enter sends nothing.
  await scenario({
    id: "offline-typing-600",
    query: "state=offline&synced=3",
    width: 600,
    expectOffline: true,
    act: async (page) => {
      await page.locator("#project-prompt").fill("Ship the release notes");
      await page.locator("#project-prompt").press("Enter");
      const sent = await page.evaluate(() => window.__sent ?? []);
      check("offline Enter sends nothing", sent.length === 0, sent);
      check(
        "draft kept",
        (await page.locator("#project-prompt").inputValue()) === "Ship the release notes",
        null,
      );
    },
  });
  // Flapping: 40 state changes in about a second, then settle on each state.
  for (const end of ["reconnecting", "online"])
    await scenario({
      id: `flap-to-${end}-600`,
      query: "state=offline&synced=0",
      width: 600,
      expectOffline: end !== "online",
      act: async (page) => {
        await page.locator("#project-prompt").fill("Draft during flapping");
        const states = ["offline", "online", "reconnecting", "connecting", "online", "offline"];
        const seen = new Set();
        for (let i = 0; i < 40; i++) {
          await page.evaluate((s) => window.__setState(s), states[i % states.length]);
          await page.waitForTimeout(25);
          const m = await measure(page);
          if (m.statusTexts.length > 1) seen.add(m.statusTexts.join(" | "));
        }
        await page.evaluate((s) => window.__setState(s), end);
        await page.waitForTimeout(150);
        check("never two statuses while flapping", seen.size === 0, [...seen]);
        check(
          "draft survives flapping",
          (await page.locator("#project-prompt").inputValue()) === "Draft during flapping",
          null,
        );
        const enabled = !(await page.locator(".sws-send").isDisabled());
        check(
          `send ${end === "online" ? "enabled" : "disabled"} after settling`,
          enabled === (end === "online"),
          enabled,
        );
        if (end === "online") {
          await page.locator("#project-prompt").press("Enter");
          await page.waitForTimeout(100);
          const sent = await page.evaluate(() => window.__sent ?? []);
          check("reconnected Enter sends", sent.length === 1, sent);
        }
      },
    });
} finally {
  await browser.close();
  server.close();
  const total = receipt.scenarios.length;
  const failed = new Set(failures.map((f) => f.split(":")[0])).size;
  receipt.summary = { total, passed: total - failed, failed };
  await fs.writeFile(path.join(output, `${label}-receipt.json`), JSON.stringify(receipt, null, 2));
  console.log(`${label}: ${total - failed}/${total} scenarios pass`);
  for (const f of failures.slice(0, 60)) console.log("  FAIL", f.slice(0, 300));
}
if (!before && failures.length) process.exit(1);

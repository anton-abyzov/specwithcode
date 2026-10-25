import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const output = path.resolve(process.argv[2] ?? ".artifacts/fallback-composer/evidence");
await fs.mkdir(output, { recursive: true });
const root = path.resolve(".artifacts/fallback-composer/site");
const server = http.createServer(async (req, res) => {
  try {
    const file = path.resolve(
      root,
      "." + new URL(req.url, "http://localhost").pathname.replace(/\/$/, "/index.html"),
    );
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
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE,
});
const receipt = { headless: true, checks: [], screenshots: [] };
try {
  for (const theme of ["light", "dark"])
    for (const width of [360, 520, 900])
      for (const scenario of ["fallback", "fallback-room", "running", "same", "twin"]) {
        const page = await browser.newPage({
          viewport: { width: 1100, height: 750 },
          colorScheme: theme,
        });
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(
          `http://127.0.0.1:${server.address().port}/?width=${width}&theme=${theme}&case=${scenario}`,
        );
        await page.locator('[data-fixture-ready="true"]').waitFor();
        await page.waitForTimeout(150);
        const result = await page.evaluate(() => {
          const trigger = document.querySelector("[data-chat-provider-model-picker]");
          const name = trigger.querySelector("[data-picker-model]");
          const state = trigger.querySelector(".sws-model-state");
          const rect = trigger.getBoundingClientRect();
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d");
          const luminance = (color) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const values = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
              v /= 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
          };
          const foreground = state ? luminance(getComputedStyle(state).color) : null;
          const background = luminance(getComputedStyle(document.body).backgroundColor);
          const banner = document.querySelector("[data-composer-banner-row]");

          return {
            contrast:
              foreground === null
                ? null
                : (Math.max(foreground, background) + 0.05) /
                  (Math.min(foreground, background) + 0.05),
            bannerHeight: banner?.getBoundingClientRect().height ?? null,
            containers: (() => {
              const values = [];
              for (let node = trigger.parentElement; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.containerName !== "none")
                  values.push({ name: style.containerName, width: node.clientWidth });
              }
              return values;
            })(),
            name: name
              ? {
                  scroll: name.scrollWidth,
                  client: name.clientWidth,
                  text: name.textContent,
                  right: name.getBoundingClientRect().right,
                }
              : null,
            triggerParts: [...trigger.firstElementChild.children]
              .filter((x) => x.getBoundingClientRect().width > 0)
              .map((x) => {
                const box = x.getBoundingClientRect();
                return { left: box.left, right: box.right };
              }),
            aria: trigger.getAttribute("aria-label"),
            state: !!state,
            glyph: !!state?.querySelector("[data-fallback-glyph]"),
            // The glyph keeps the suffix's warning color; the trigger mutes plain icons.
            glyphTinted: state?.querySelector("[data-fallback-glyph]")
              ? getComputedStyle(state.querySelector("[data-fallback-glyph]")).color ===
                getComputedStyle(state).color
              : null,
            // A fallback renders no words at all; other states hide them by width.
            full: state?.querySelector(".sws-model-state-full")
              ? getComputedStyle(state.querySelector(".sws-model-state-full")).display
              : "none",
            short: state?.querySelector(".sws-model-state-short")
              ? getComputedStyle(state.querySelector(".sws-model-state-short")).display
              : "none",
            outside: [...document.querySelectorAll(".sws-model-state")].some(
              (x) => !trigger.contains(x),
            ),
            rect: { x: rect.x, right: rect.right },
            surface: document.querySelector("[data-fixture-composer]").getBoundingClientRect()
              .right,
            text: document.body.innerText,
          };
        });
        assert.equal(errors.length, 0, errors.join("\n"));
        assert(result.name, `${scenario} model parts`);
        assert(
          result.name.scroll <= result.name.client + 1,
          `${width} ${scenario}: model clipped ${JSON.stringify(result)}`,
        );
        assert(
          result.name.right <= result.rect.right - 12,
          `${width} ${scenario} name outside trigger`,
        );
        for (const item of result.triggerParts)
          assert(
            item.right <= result.rect.right - 8,
            `${width} ${scenario}: trigger child outside`,
          );
        for (let i = 1; i < result.triggerParts.length; i++)
          assert(
            result.triggerParts[i].left >= result.triggerParts[i - 1].right - 0.5,
            `${width} ${scenario}: trigger children overlap`,
          );
        assert(!result.outside);
        assert(result.rect.right <= result.surface + 1);
        assert(!result.text.includes("Continuing on"));
        if (scenario.startsWith("fallback")) {
          assert(result.state);
          assert(result.contrast >= 4.5, `${theme} ${width}: suffix contrast ${result.contrast}`);
          // The detour glyph alone at every width: the model keeps the room.
          assert(result.glyph, `${theme} ${width}: fallback glyph`);
          assert(result.glyphTinted, `${theme} ${width}: fallback glyph is muted`);
          assert.equal(result.full, "none");
          assert.equal(result.short, "none");
          assert(result.aria.includes("fallback for Claude Code · Opus 5.5"));
        }
        if (scenario === "twin") {
          // Same model name on another provider: a glyph, and the pick named with its provider.
          assert(result.state && result.glyph, `${theme} ${width}: twin glyph`);
          assert.equal(result.full, "none");
          assert(result.aria.includes("fallback for Codex · GPT-6.1-Sol"), result.aria);
          const file = path.join(output, `composer-twin-${width}-${theme}.png`);
          await page.screenshot({ path: file, fullPage: true });
          receipt.screenshots.push(file);
        }
        if (scenario === "fallback") assert(!result.text.includes("Switch back"));
        if (scenario === "fallback-room") {
          assert(result.text.includes("Switch back"));
          assert(result.bannerHeight <= 40, `banner wraps ${result.bannerHeight}`);
        }
        if (scenario === "fallback" || scenario === "fallback-room") {
          const file = path.join(
            output,
            `composer-${scenario === "fallback-room" ? "room-" : ""}${width}-${theme}.png`,
          );
          await page.screenshot({ path: file, fullPage: true });
          receipt.screenshots.push(file);
        }
        if (scenario === "fallback" && width === 900) {
          await page.locator("[data-chat-provider-model-picker]").click();
          await page.getByRole("status").filter({ hasText: "Back to Opus 5.5" }).waitFor();
          assert(
            await page
              .getByRole("status")
              .filter({ hasText: "Back to Opus 5.5" })
              .innerText()
              .then((t) => t.includes("Back to Opus 5.5")),
          );
          assert(await page.getByRole("button", { name: "Back to Opus 5.5" }).isDisabled());
          const file = path.join(output, `composer-menu-${theme}.png`);
          await page.screenshot({ path: file, fullPage: true });
          receipt.screenshots.push(file);
        }
        receipt.checks.push({ theme, width, scenario, ...result });
        await page.close();
      }
  await fs.writeFile(path.join(output, "composer-receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`PASS ${receipt.checks.length} composer cases; ${output}`);
} finally {
  await browser.close();
  server.close();
}

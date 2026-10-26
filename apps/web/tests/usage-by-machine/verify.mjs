// Build with vp build --config apps/web/tests/usage-by-machine/vite.config.ts first.
// Supply the installed Playwright entry via STUDIO_PLAYWRIGHT_MODULE.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert.strict;
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href);
const root = NodePath.resolve(".artifacts/usage-by-machine/site");
const output = NodePath.resolve(
  process.env.USAGE_BY_MACHINE_OUTPUT ?? ".artifacts/usage-by-machine/evidence",
);
await NodeFSP.mkdir(output, { recursive: true });
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".svg")
          ? "image/svg+xml"
          : "text/html";
    res.writeHead(200, { "Content-Type": mime });
    res.end(await NodeFSP.readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.STUDIO_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.STUDIO_CHROMIUM_EXECUTABLE }
    : {}),
});
const receipt = { headless: true, checks: [], screenshots: [] };
const edges = async (locator, side) => {
  const out = [];
  for (const el of await locator.all()) {
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    if (box.width === 0) continue;
    out.push(Math.round(side === "start" ? box.x : box.x + box.width));
  }
  return out;
};
const aligned = (values, what) => {
  for (const value of values)
    assert.ok(Math.abs(value - values[0]) <= 1, `${what} aligned (${values.join(", ")})`);
};
try {
  // Desktop app and web, a tablet or narrow window, a phone, the smallest phone.
  for (const theme of ["light", "dark"]) {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
      });
      await page.route("**/*", (route) =>
        route.request().url().startsWith(origin) ? route.continue() : route.abort(),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?theme=${theme}`);
      const popover = page.locator('[data-case="popover"]');
      await popover.waitFor();
      await page.evaluate(() =>
        Promise.all(document.getAnimations({ subtree: true }).map((a) => a.finished)),
      );
      const popBox = await popover.boundingBox();
      assert.ok(popBox.x >= 0 && popBox.x + popBox.width <= width, "popover fits the viewport");
      // The coordinator's account is part of its machine, not a section of its own.
      assert.equal(await popover.locator(".sws-usage-provider").count(), 0, "no separate section");
      const heads = popover.locator(".sws-hl-compact-head");
      const firstHead = heads.first();
      assert.deepEqual(await firstHead.locator(".sws-hl-badge").allTextContents(), [
        "This machine",
        "This project",
      ]);
      // Wide enough for the bars, a host header is one line; narrower, the name gets its own.
      const narrow = !(await popover
        .locator(".sws-hl-compact-window > .sws-hl-bar")
        .first()
        .isVisible());
      for (const head of await heads.all()) {
        const box = await head.boundingBox();
        assert.ok(box.height <= (narrow ? 44 : 24), `host header fits (${box.height}px)`);
      }
      if (narrow) {
        const name = await firstHead
          .locator("strong")
          .evaluate((el) => el.scrollWidth <= el.clientWidth);
        assert.ok(name, "this machine's name is not clipped");
      }
      // Each provider: name and account on one line, or two when narrow; never more.
      for (const rowEl of await popover.locator(".sws-hl-compact-row").all()) {
        const box = await rowEl.boundingBox();
        assert.ok(box.height <= (narrow ? 40 : 24), `provider line fits (${box.height}px)`);
      }
      const accounts = popover.locator(".sws-hl-compact-account");
      for (const account of await accounts.all()) {
        const box = await account.boundingBox();
        assert.ok(box.height <= 18, `account on one line (${box.height}px)`);
        assert.ok(box.x + box.width <= popBox.x + popBox.width, "account stays inside");
      }
      const accountTexts = await accounts.allTextContents();
      assert.ok(
        accountTexts.includes("you@work.example · Claude Max Subscription"),
        "coordinator account with its plan",
      );
      assert.ok(
        accountTexts.includes("me@home.example · also on Studio Mac (M4 Max)"),
        "shared account names the other machine",
      );
      const coordinator = popover.locator(".sws-hl-compact-entry[data-coordinator]");
      assert.equal(await coordinator.count(), 1);
      assert.equal(await coordinator.locator(".sws-hl-tag").textContent(), "Coordinator");
      const visibleLabel = (el) =>
        [...el.childNodes]
          .filter((node) => !(node instanceof Element && node.classList.contains("sr-only")))
          .map((node) => node.textContent)
          .join("");
      assert.deepEqual(
        await coordinator.locator(".sws-hl-compact-window-label").evaluateAll((els, fn) => {
          const strip = new Function(`return ${fn}`)();
          return els.map(strip);
        }, visibleLabel.toString()),
        ["5-hour", "Weekly", "Weekly · Fable"],
      );
      // Every provider lists every window it reports, not only the coordinator.
      assert.equal(await popover.locator(".sws-hl-compact-window").count(), 16, "all windows");
      for (const windowEl of await popover.locator(".sws-hl-compact-window").all()) {
        const box = await windowEl.boundingBox();
        assert.ok(box.height <= 20, `window on one line (${box.height}px)`);
        // Label, bar, value and reset never overlap one another.
        const parts = [];
        for (const part of await windowEl.locator(":scope > *").all()) {
          if (!(await part.isVisible())) continue;
          const b = await part.boundingBox();
          if (b.width > 0) parts.push(b);
        }
        for (let i = 1; i < parts.length; i++)
          assert.ok(parts[i].x >= parts[i - 1].x + parts[i - 1].width - 0.5, "no overlap");
      }
      const windowsOf = async (host, provider) => {
        const entry = popover
          .locator(".sws-hl-compact-host")
          .filter({ has: page.locator(".sws-hl-compact-title strong", { hasText: host }) })
          .locator(".sws-hl-compact-entry")
          .filter({ has: page.locator(".sws-hl-compact-provider", { hasText: provider }) });
        const out = [];
        for (const el of await entry.locator(".sws-hl-compact-window").all())
          out.push({
            label: (await el.locator(".sws-hl-compact-window-label").textContent()).replace(
              ", least left",
              "",
            ),
            value: await el.locator(".sws-hl-compact-value").textContent(),
            aside: (await el.locator(".sws-hl-compact-aside").textContent()).replace(
              /, usable again.*$/,
              "",
            ),
            rank: await el.getAttribute("data-rank"),
          });
        return out;
      };
      // The weekly at 12% binds the 5-hour at 70%; neither number is merged.
      assert.deepEqual(await windowsOf("Studio Mac", "Claude"), [
        { label: "5-hour", value: "70% left", aside: "in 2h 24m", rank: "other" },
        { label: "Weekly", value: "12% left", aside: "in 4d 16h", rank: "binding" },
      ]);
      // Receding rows are dimmer but every text in them keeps AA contrast (4.5:1).
      const worst = await popover.evaluate((root) => {
        const canvas = document.createElement("canvas").getContext("2d");
        const rgba = (css) => {
          canvas.fillStyle = "#000";
          canvas.fillStyle = css;
          canvas.fillRect(0, 0, 1, 1);
          const d = canvas.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2], d[3] / 255];
        };
        const lum = ([r, g, b]) =>
          [r, g, b]
            .map((v) => v / 255)
            .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        let bgEl = root;
        while (bgEl && rgba(getComputedStyle(bgEl).backgroundColor)[3] === 0)
          bgEl = bgEl.parentElement;
        canvas.clearRect(0, 0, 1, 1);
        const bg = rgba(getComputedStyle(bgEl ?? document.body).backgroundColor);
        let min = Infinity;
        for (const el of root.querySelectorAll(
          ".sws-hl-compact-window[data-rank='other'] > :not(.sws-hl-bar)",
        )) {
          let alpha = 1;
          for (let n = el; n && n !== root; n = n.parentElement)
            alpha *= Number(getComputedStyle(n).opacity);
          canvas.clearRect(0, 0, 1, 1);
          const fg = rgba(getComputedStyle(el).color);
          const a = alpha * fg[3];
          const mixed = fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
          const [l1, l2] = [lum(mixed), lum(bg)].sort((x, y) => y - x);
          min = Math.min(min, (l1 + 0.05) / (l2 + 0.05));
        }
        return min;
      });
      assert.ok(worst >= 4.5, `receding rows keep AA contrast (${worst.toFixed(2)}:1)`);
      receipt.checks.push({ case: "contrast", theme, width, worst: Number(worst.toFixed(2)) });
      // A long provider name ends in an ellipsis and the account stays visible.
      const longEntry = popover
        .locator(".sws-hl-compact-entry")
        .filter({ hasText: "GitHub Copilot Enterprise" });
      const longName = await longEntry.locator(".sws-hl-compact-name").evaluate((el) => ({
        clipped: el.scrollWidth > el.clientWidth,
        overflow: getComputedStyle(el).textOverflow,
      }));
      assert.equal(longName.overflow, "ellipsis");
      const longAccount = await longEntry.locator(".sws-hl-compact-account").boundingBox();
      assert.ok(longAccount.width >= 60, `account keeps room (${longAccount.width}px)`);
      // A spent weekly blocks the 5-hour: it says so instead of showing 90% left.
      assert.deepEqual(await windowsOf("Lab MacBook", "Claude"), [
        { label: "5-hour", value: "Blocked", aside: "by Weekly", rank: "other" },
        { label: "Weekly", value: "Limit reached", aside: "in 3d 5h", rank: "binding" },
      ]);
      // A saved reading whose 5-hour has reset since is not shown as full or empty.
      assert.deepEqual(await windowsOf("Office MacBook", "Claude"), [
        { label: "5-hour", value: "reset since", aside: "", rank: "other" },
        { label: "Weekly", value: "15% left", aside: "in 4d 20h", rank: "binding" },
      ]);
      // Bars, values and resets share one column on every machine and window.
      const grid = popover.locator(".sws-hl-compact-grid");
      const bars = await edges(grid.locator(".sws-hl-bar"), "start");
      aligned(bars, "bars");
      aligned(await edges(grid.locator(".sws-hl-compact-value"), "end"), "values");
      aligned(await edges(grid.locator(".sws-hl-compact-aside"), "end"), "resets");
      assert.deepEqual(errors, []);
      const file = NodePath.join(output, `popover-${theme}-${width}.png`);
      await page.screenshot({ path: file, fullPage: false });
      receipt.screenshots.push(file);
      receipt.checks.push({ case: "popover", theme, width, bars: bars.length > 0 });

      if (width === 1440 || width === 390) {
        await page.goto(`${origin}/?theme=${theme}&case=limits`);
        const limits = page.locator('[data-case="limits"]');
        await limits.waitFor();
        const blocks = limits.locator(".sws-hl-block");
        assert.equal(await blocks.count(), 5);
        assert.deepEqual(await blocks.first().locator("header .sws-hl-badge").allTextContents(), [
          "This machine",
          "This project",
        ]);
        const identities = await limits.locator(".sws-hl-identity").allTextContents();
        assert.ok(identities.includes("team@company.example · Claude Max Subscription"));
        // Every window of a provider starts its bar at the same x; shared chips never wrap.
        for (const provider of await limits.locator(".sws-hl-provider").all()) {
          aligned(await edges(provider.locator(".sws-hl-window .sws-hl-bar"), "start"), "bars");
        }
        for (const chip of await limits.locator(".sws-hl-shared").all()) {
          const box = await chip.boundingBox();
          assert.ok(box.height <= 20, `shared chip on one line (${box.height}px)`);
        }
        const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(pageWidth <= width, `no horizontal scroll (${pageWidth})`);
        assert.deepEqual(errors, []);
        const limitsFile = NodePath.join(output, `limits-${theme}-${width}.png`);
        await page.screenshot({ path: limitsFile, fullPage: true });
        receipt.screenshots.push(limitsFile);
        receipt.checks.push({ case: "limits", theme, width });
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));

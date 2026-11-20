// Headless check of the first feature guide and its Overview offer in every state (1398 T-07),
// light and dark, at 390 and 1280 px. Builds the fixture itself unless FIRST_FEATURE_SITE names a
// built one. Run from the repository root:
//   node apps/web/tests/first-feature/verify.mjs /absolute/owned/report-dir
import * as NodeAssert from "node:assert/strict";
import * as NodeChild from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/first-feature/evidence");
let site = process.env.FIRST_FEATURE_SITE;
if (!site) {
  site = ".artifacts/first-feature/site";
  const built = NodeChild.spawnSync(
    process.execPath,
    [
      "node_modules/vite-plus/bin/vp",
      "build",
      "--config",
      "apps/web/tests/first-feature/vite.config.ts",
    ],
    { stdio: "inherit" },
  );
  NodeAssert.equal(built.status, 0, "the fixture build failed");
}
site = NodePath.resolve(site);
await NodeFSP.mkdir(output, { recursive: true });

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const receipt = {
  headless: true,
  // What these pictures do not prove (1398 PR 659 pre-screen).
  proofLimits: [
    "The fixture draws the guide and the offer card alone, not inside the real project page.",
    "Only the app's default theme is drawn: a person who picked a palette sees theirs.",
  ],
  checks: [],
  screenshots: [],
};
const check = (name, ok, detail = "") => {
  receipt.checks.push({ name, ok, detail });
  if (!ok) console.error(`FAIL ${name} ${detail}`);
};

/** What each state must show; `null` means nothing is drawn. */
const EXPECT = {
  "offer-start": { offer: "start", action: "Try a first feature", title: "Build a first feature" },
  "offer-sign-in": {
    offer: "sign-in",
    action: "Sign in an agent first",
    title: "Build a first feature",
  },
  "offer-starting": {
    offer: "start",
    action: "Try a first feature",
    title: "Build a first feature",
    disabled: true,
  },
  "offer-continue": { offer: "continue", action: "Open it", title: "Continue your first feature" },
  "offer-absent-no-key": { absent: "[data-first-feature-offer]" },
  "offer-absent-finished": { absent: "[data-first-feature-offer]" },
  "offer-absent-dismissed": { absent: "[data-first-feature-offer]" },
  "sample-review-warning": { text: "Automatic review is still on for the sample" },
  "step1-specweave": { knots: ["now", "later", "later"], text: "Turn SpecWeave on." },
  "step1-waiting": { knots: ["now", "later", "later"], waiting: true },
  "step2-ask": {
    knots: ["done", "now", "later"],
    text: "review it and close it.",
    writeDisabled: false,
  },
  "step2-ask-no-second-family": {
    knots: ["done", "now", "later"],
    text: "build it and close it.",
    writeDisabled: false,
  },
  "step2-ask-unknown": { knots: ["done", "now", "later"], writeDisabled: true },
  "step2-ask-written": { text: "review it and close it.", writeDisabled: null },
  "step2-planning": { status: "planning" },
  "step2-working": { status: "working", text: "Working: 2 of 4 tasks" },
  "step2-in-review": { status: "review" },
  "step2-fixing": { status: "fixing" },
  "step2-waiting": { waiting: true },
  "step3-reviews": { knots: ["done", "done", "now"], brands: ["meta", "openai"] },
  "step3-same-family": { note: "same-family", brands: ["claude"] },
  "step3-no-second-family": { note: "no-second-family", brands: ["openai", "meta"] },
  "step3-none-recorded": { note: "none-recorded" },
  "skipped-knot": { knots: ["skipped", "now", "later"] },
  "guide-error": { text: "The guide could not be updated. Try again." },
  end: { text: "That is the loop: plan, board, work, review, done.", removeDisabled: true },
  "end-finished-stored": { removeDisabled: false },
  "end-review-all-done": { text: "On for all projects on this Mac." },
  "end-review-all-saving": { reviewAllDisabled: true },
  "end-review-all-not-allowed": {
    reviewAllDisabled: true,
    text: "This connection cannot change the settings of this Mac.",
  },
  "end-removing": { text: "Its folder and files stay on disk." },
  "end-remove-confirm": { text: "Its folder and files stay on disk." },
};

try {
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      for (const [state, want] of Object.entries(EXPECT)) {
        const label = `${state} ${theme} ${width}`;
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          deviceScaleFactor: 1,
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${origin}/?state=${state}&theme=${theme}`);
        await page.locator("[data-fixture-ready]").waitFor();
        if (want.text) {
          // A missing text is a failed check, not an abort, so one run reports every state.
          const shown = await page
            .getByText(want.text, { exact: false })
            .first()
            .waitFor({ timeout: 10_000 })
            .then(
              () => true,
              () => false,
            );
          check(`${label}: says "${want.text}"`, shown);
        }
        // A settled frame: the step's sentence fades in from opacity 0 (setup-fall, 0.56 s after
        // 40 ms), and Playwright counts an element at opacity 0 as visible. Nothing here loops.
        const settled = await page
          .waitForFunction(
            () =>
              document
                .getAnimations()
                .every((animation) => animation.playState !== "running" && !animation.pending),
            undefined,
            { timeout: 10_000 },
          )
          .then(
            () => true,
            () => false,
          );
        check(`${label}: every animation has ended`, settled);
        // A guide body that is really there: the step slot and every ancestor fully opaque, with
        // a box and words in it. Blank bodies passed four review rounds before this check.
        const body = await page.evaluate(() => {
          if (document.querySelector('[data-slot="first-feature-guide"]') === null) return null;
          const now = document.querySelector('[data-slot="first-feature-now"]');
          if (now === null) return { missing: true };
          const opacityOf = (start) => {
            let opacity = 1;
            for (let node = start; node instanceof Element; node = node.parentElement)
              opacity *= Number(getComputedStyle(node).opacity);
            return opacity;
          };
          const box = now.getBoundingClientRect();
          const sentence = now.querySelector("p")?.innerText.trim() ?? "";
          // The blank pictures hid the buttons too, so each one must show on its own.
          const hiddenButtons = [...now.querySelectorAll("button")]
            .filter((button) => {
              const own = button.getBoundingClientRect();
              // A button that is off is drawn faded on purpose, never invisible.
              const least =
                button.disabled || button.getAttribute("aria-disabled") === "true" ? 0.7 : 1;
              return opacityOf(button) < least || own.width === 0 || own.height === 0;
            })
            .map((button) => button.textContent?.trim() || "button");
          return {
            opacity: opacityOf(now),
            width: box.width,
            height: box.height,
            sentence,
            hiddenButtons,
          };
        });
        if (body !== null)
          check(
            `${label}: the step's sentence shows`,
            body.opacity === 1 &&
              body.width > 0 &&
              body.height > 0 &&
              body.sentence.length > 0 &&
              body.hiddenButtons.length === 0,
            JSON.stringify(body),
          );
        const seen = await page.evaluate(() => {
          const all = (selector) => [...document.querySelectorAll(selector)];
          const guide = document.querySelector('[data-slot="first-feature-guide"]');
          const remove = all("button").find(
            (b) => b.textContent?.trim() === "Remove the sample project",
          );
          return {
            sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            // The page can clip what overflows, so measure the guide and the card themselves.
            outside: all(
              '[data-slot="first-feature-guide"], [data-slot="first-feature-guide"] *, [data-first-feature-offer], [data-first-feature-offer] *',
            )
              .filter((node) => {
                const box = node.getBoundingClientRect();
                return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
              })
              .map((node) => node.textContent?.trim().slice(0, 40) || node.tagName)
              .slice(0, 5),
            // Text cut short inside the guide or the card, as a truncate class does it.
            clipped: all('[data-slot="first-feature-guide"] *, [data-first-feature-offer] *')
              .filter((node) => {
                // Screen reader text such as " (done)" is a 1 px box on purpose.
                if (node.closest(".sr-only") !== null) return false;
                const style = getComputedStyle(node);
                return (
                  (style.overflowX === "hidden" || style.overflowX === "clip") &&
                  node.scrollWidth > node.clientWidth + 1 &&
                  node.textContent?.trim()
                );
              })
              .map((node) => node.textContent.trim().slice(0, 40))
              .slice(0, 5),
            // innerText keeps a cut label whole, so a label that overflows its box counts as cut.
            knotLabels: all('[data-slot="first-feature-knot-label"]').map((node) =>
              node.scrollWidth > node.clientWidth + 1
                ? "cut"
                : node.firstChild?.textContent?.trim(),
            ),
            dialog: all('[role="dialog"]').length,
            offer:
              document
                .querySelector("[data-first-feature-offer]")
                ?.getAttribute("data-first-feature-offer") ?? null,
            offerTitle:
              document.querySelector("[data-first-feature-offer] h2")?.textContent ?? null,
            offerActions: all("[data-first-feature-offer-action]").map((b) =>
              b.textContent?.trim(),
            ),
            knots: all("[data-first-feature-knots] li").map((li) => li.getAttribute("data-state")),
            status:
              document
                .querySelector("[data-first-feature-status]")
                ?.getAttribute("data-first-feature-status") ?? null,
            note:
              document
                .querySelector("[data-first-feature-note]")
                ?.getAttribute("data-first-feature-note") ?? null,
            waiting: document.querySelector("[data-first-feature-waiting]") !== null,
            brands: all(
              "[data-first-feature-reviews] [data-provider-logo], [data-first-feature-note] [data-provider-logo]",
            ).map((mark) => mark.getAttribute("data-provider-logo")),
            marksDrawn: all("[data-provider-logo]").every(
              (mark) => mark.getBoundingClientRect().width > 0,
            ),
            guide: guide !== null,
            removeDisabled: remove ? remove.disabled : null,
            reviewAllDisabled:
              all("button").find(
                (b) =>
                  b.textContent?.trim() === "Review finished features in all projects on this Mac",
              )?.disabled ?? null,
            writeDisabled:
              all("button").find((b) => b.textContent?.trim() === "Write it for me")?.disabled ??
              null,
            offerDisabled:
              document.querySelector("[data-first-feature-offer-action]")?.disabled ?? null,
            text: document.body.innerText,
          };
        });
        check(`${label}: no page errors`, errors.length === 0, errors.join("; "));
        check(`${label}: nothing runs off the side`, !seen.sideways);
        check(
          `${label}: the guide and the card fit the window`,
          seen.outside.length === 0,
          JSON.stringify(seen.outside),
        );
        check(
          `${label}: no text in the guide is cut short`,
          seen.clipped.length === 0,
          JSON.stringify(seen.clipped),
        );
        if (seen.guide)
          check(
            `${label}: every step's name shows in full`,
            JSON.stringify(seen.knotLabels) ===
              JSON.stringify(["Turn SpecWeave on", "Ask for it whole", "Read the review"]),
            JSON.stringify(seen.knotLabels),
          );
        check(`${label}: never a dialog`, seen.dialog === 0 || state === "sample-review-warning");
        check(`${label}: no time is named`, !/minute/i.test(seen.text), seen.text.slice(0, 200));
        if (want.absent) check(`${label}: absent`, seen.offer === null);
        if (want.offer) {
          check(`${label}: offer kind`, seen.offer === want.offer, String(seen.offer));
          check(`${label}: title`, seen.offerTitle === want.title, String(seen.offerTitle));
          check(
            `${label}: one action`,
            seen.offerActions.length === 1 && seen.offerActions[0] === want.action,
            JSON.stringify(seen.offerActions),
          );
        }
        if (want.text) check(`${label}: says it`, seen.text.includes(want.text), want.text);
        if (want.knots)
          check(
            `${label}: knots`,
            JSON.stringify(seen.knots) === JSON.stringify(want.knots),
            JSON.stringify(seen.knots),
          );
        if (state.startsWith("step") || state.startsWith("end") || state === "skipped-knot")
          check(`${label}: three knots`, seen.knots.length === 3, String(seen.knots.length));
        if (want.status)
          check(`${label}: status line`, seen.status === want.status, String(seen.status));
        if (want.note) check(`${label}: note`, seen.note === want.note, String(seen.note));
        if (want.waiting) check(`${label}: says where to look`, seen.waiting);
        if (want.brands) {
          check(
            `${label}: provider marks`,
            JSON.stringify(seen.brands) === JSON.stringify(want.brands),
            JSON.stringify(seen.brands),
          );
          check(`${label}: marks are drawn`, seen.marksDrawn);
        }
        if (want.reviewAllDisabled !== undefined)
          check(
            `${label}: Review-all waits`,
            seen.reviewAllDisabled === want.reviewAllDisabled,
            String(seen.reviewAllDisabled),
          );
        if (want.writeDisabled !== undefined)
          check(
            `${label}: Write it for me ${want.writeDisabled === null ? "gone" : want.writeDisabled ? "waits" : "ready"}`,
            seen.writeDisabled === want.writeDisabled,
            String(seen.writeDisabled),
          );
        if (want.disabled !== undefined)
          check(
            `${label}: action waits while starting`,
            seen.offerDisabled === want.disabled,
            String(seen.offerDisabled),
          );
        if (want.removeDisabled !== undefined)
          check(
            `${label}: Remove waits for finished`,
            seen.removeDisabled === want.removeDisabled,
            String(seen.removeDisabled),
          );
        if (state === "sample-review-warning") {
          // The toast slides in over 0.5 s: wait until it rests fully on screen before the picture.
          const settled = await page
            .waitForFunction(
              () => {
                const toast = [
                  ...document.querySelectorAll('[data-slot="toast-viewport"] > *'),
                ].find((node) =>
                  node.textContent?.includes("Automatic review is still on for the sample"),
                );
                if (toast === undefined) return false;
                const box = toast.getBoundingClientRect();
                return (
                  box.left >= 0 &&
                  box.right <= window.innerWidth &&
                  toast.getAnimations({ subtree: true }).length === 0
                );
              },
              undefined,
              { timeout: 10_000 },
            )
            .then(
              () => true,
              () => false,
            );
          check(`${label}: the toast rests on screen`, settled);
        }
        if (!want.absent) {
          const file = NodePath.join(output, `${state}-${theme}-${width}.png`);
          await page.screenshot({ path: file, fullPage: true });
          receipt.screenshots.push(file);
        }
        await page.close();
      }
    }
  }
  // Reduced motion draws every state at once: the step block and the knots have no animation.
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await page.goto(`${origin}/?state=step2-working&theme=light`);
  await page.locator("[data-fixture-ready]").waitFor();
  const animations = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="first-feature-now"], [data-slot="setup-knot"]')].map(
      (node) => getComputedStyle(node).animationName,
    ),
  );
  check(
    "reduced motion: nothing animates",
    animations.every((name) => name === "none"),
    JSON.stringify(animations),
  );
  await page.close();
} finally {
  await browser.close();
  server.close();
  await NodeFSP.writeFile(NodePath.join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
const failed = receipt.checks.filter((entry) => !entry.ok);
NodeAssert.equal(failed.length, 0, `${failed.length} of ${receipt.checks.length} checks failed`);
console.log(
  `${receipt.checks.length} checks passed, ${receipt.screenshots.length} screenshots in ${output}`,
);

// A message that names media only by path: one thumbnail under it, which opens the full file.
// Build first: vp build --config apps/web/tests/inline-media/vite.config.ts
// UI_EVIDENCE_DIR must be a new directory (default: a timestamped one under .artifacts).
// Always headless.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE
    ? NodeURL.pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
    : "playwright"
);
const output =
  process.env.UI_EVIDENCE_DIR ??
  NodePath.resolve(
    `.artifacts/inline-media/evidence-${new Date().toISOString().replace(/\W/g, "")}`,
  );
await NodeFSP.mkdir(output, { recursive: !process.env.UI_EVIDENCE_DIR });
const root = NodePath.resolve(process.env.INLINE_MEDIA_SITE ?? ".artifacts/inline-media/site");
const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

// The media route stands in for the thread's server: a thumb request gets a 640 px picture,
// a plain one the 1600 px file, so the page shows which of the two it loaded.
const picture = (width, label) => {
  const height = Math.round((width * 9) / 16);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#1f2937"/>
<rect x="4%" y="8%" width="92%" height="14%" rx="${width / 80}" fill="#374151"/>
<rect x="4%" y="28%" width="44%" height="60%" rx="${width / 80}" fill="#2563eb"/>
<rect x="52%" y="28%" width="44%" height="28%" rx="${width / 80}" fill="#4b5563"/>
<rect x="52%" y="60%" width="44%" height="28%" rx="${width / 80}" fill="#4b5563"/>
<text x="50%" y="17%" fill="#f9fafb" font-family="sans-serif" font-size="${width / 22}" text-anchor="middle">${label}</text>
</svg>`;
};
const mediaRequests = [];
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/media/")) {
      mediaRequests.push(url.pathname + url.search);
      if (url.pathname.endsWith(".webm")) {
        res.writeHead(200, { "Content-Type": "video/webm" });
        res.end(await NodeFSP.readFile(new URL("./demo.webm", import.meta.url)));
        return;
      }
      const thumb = url.searchParams.get("variant") === "thumb";
      const name = decodeURIComponent(url.pathname.slice("/media/".length));
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(picture(thumb ? 640 : 1600, `${name} · ${thumb ? "thumb 640" : "full 1600"}`));
      return;
    }
    const file = NodePath.resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(`${root}${NodePath.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const body = await NodeFSP.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(file)] ?? "text/html" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});

const VIEWS = [
  { name: "1280", viewport: { width: 1280, height: 1500 } },
  { name: "390", viewport: { width: 390, height: 1900 } },
];
const results = [];
const errors = [];

const open = async (view, query) => {
  const context = await browser.newContext({ viewport: view.viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${view.name}${query}: ${error.message}`));
  // Nothing but the fixture's own origin is reached.
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/${query}`);
  await page.locator('[data-testid="chip"] code, [data-testid="chip"] a').first().waitFor();
  await page.waitForLoadState("networkidle");
  return { context, page };
};

const caseState = (page, id) =>
  page.locator(`[data-testid="${id}"]`).evaluate((section) => ({
    fallbacks: [...section.querySelectorAll("[data-media-fallback]")].map((node) => ({
      kind: node.getAttribute("data-media-fallback"),
      image: (() => {
        const image = node.querySelector("img");
        return image
          ? {
              src: new URL(image.src).pathname + new URL(image.src).search,
              naturalWidth: image.naturalWidth,
              shownWidth: Math.round(image.getBoundingClientRect().width),
              shownHeight: Math.round(image.getBoundingClientRect().height),
            }
          : null;
      })(),
      video: node.querySelector("video") !== null,
    })),
    images: section.querySelectorAll("img").length,
    text: section.textContent,
    spills: section.scrollWidth > section.clientWidth + 1,
  }));

try {
  for (const view of VIEWS) {
    for (const theme of ["light", "dark"]) {
      // Before: every case is a chip (or the author's own image), with no thumbnail.
      const before = await open(view, `?before&theme=${theme}`);
      const beforeStates = {};
      for (const id of ["chip", "several", "embedded", "missing", "video", "streaming"]) {
        beforeStates[id] = await caseState(before.page, id);
        NodeAssert.equal(beforeStates[id].fallbacks.length, 0, `before ${id}: no thumbnail`);
      }
      NodeAssert.equal(beforeStates.chip.images, 0, "before chip: no picture at all");
      NodeAssert.match(beforeStates.chip.text, /after\.png/, "before chip: the chip is there");
      await before.page.screenshot({
        path: NodePath.join(output, `before-${theme}-${view.name}.png`),
        fullPage: true,
      });
      await before.context.close();

      const after = await open(view, `?theme=${theme}`);
      const { page } = after;
      await page.locator('[data-testid="chip"] [data-media-fallback] img').waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("[data-media-fallback] img")].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      );
      const states = {};
      for (const id of ["chip", "several", "embedded", "missing", "video", "streaming"]) {
        states[id] = await caseState(page, id);
        NodeAssert.equal(states[id].spills, false, `${id}: nothing spills sideways`);
      }
      // One thumbnail of the first file, loaded as the thumb variant, with the chip kept.
      NodeAssert.equal(states.chip.fallbacks.length, 1, "chip: exactly one thumbnail");
      NodeAssert.equal(states.chip.fallbacks[0].image.src, "/media/after.png?variant=thumb");
      NodeAssert.equal(states.chip.fallbacks[0].image.naturalWidth, 640, "chip: the thumb loaded");
      NodeAssert.ok(states.chip.fallbacks[0].image.shownHeight <= 15 * 16 + 1, "chip: thumb sized");
      NodeAssert.match(states.chip.text, /after\.png/, "chip: the chip stays");
      NodeAssert.match(states.chip.text, /notes\.md/, "chip: the other file stays a chip");
      NodeAssert.equal(states.several.fallbacks.length, 1, "several: exactly one thumbnail");
      NodeAssert.equal(states.several.fallbacks[0].image.src, "/media/before.png?variant=thumb");
      // What the author embedded wins: its own full image, and no fallback.
      NodeAssert.equal(states.embedded.fallbacks.length, 0, "embedded: no fallback");
      NodeAssert.equal(states.embedded.images, 1, "embedded: the author's image only");
      NodeAssert.equal(states.missing.fallbacks.length, 0, "missing: the chip alone");
      NodeAssert.match(states.missing.text, /remote\.png/, "missing: the chip stays");
      NodeAssert.equal(states.video.fallbacks.length, 1, "video: one player");
      NodeAssert.equal(states.video.fallbacks[0].kind, "video");
      NodeAssert.equal(states.video.fallbacks[0].video, true, "video: a player, not an image");
      NodeAssert.equal(states.streaming.fallbacks.length, 0, "streaming: waits for the end");
      await page.screenshot({
        path: NodePath.join(output, `after-${theme}-${view.name}.png`),
        fullPage: true,
      });

      // A click opens the file itself in the expanded viewer, never the thumb.
      await page.locator('[data-testid="chip"] [data-media-fallback] img').click();
      const viewerImage = page.locator('[role="dialog"] img').first();
      await viewerImage.waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector('[role="dialog"] img');
        return image?.complete && image.naturalWidth > 0;
      });
      const viewer = await viewerImage.evaluate((image) => ({
        src: new URL(image.src).pathname + new URL(image.src).search,
        naturalWidth: image.naturalWidth,
      }));
      NodeAssert.equal(viewer.src, "/media/after.png", "viewer: the full file");
      NodeAssert.equal(viewer.naturalWidth, 1600, "viewer: at full size");
      await page.screenshot({ path: NodePath.join(output, `viewer-${theme}-${view.name}.png`) });
      results.push({ view: view.name, theme, before: beforeStates, after: states, viewer });
      await after.context.close();
    }
  }
  NodeAssert.deepEqual(errors, [], "no page errors");
} finally {
  await NodeFSP.writeFile(
    NodePath.join(output, "inline-media-check.json"),
    JSON.stringify(
      { results, errors, mediaRequests: [...new Set(mediaRequests)].toSorted() },
      null,
      2,
    ),
  );
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`inline-media: ${results.length} views passed; evidence in ${output}`);

// @effect-diagnostics nodeBuiltinImport:off - Reads the runtime and three.js from disk for a browser test.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { wrapThreeCommonJs } from "./localArtifactLibs.ts";

const DECK = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./artifact-libs/motion-deck.js", import.meta.url)),
  "utf8",
);
const THREE = wrapThreeCommonJs(
  NodeFS.readFileSync(
    NodeModule.createRequire(
      NodeURL.fileURLToPath(
        new URL("../../../../packages/client-runtime/package.json", import.meta.url),
      ),
    ).resolve("three"),
    "utf8",
  ),
);

// Two small scenes: one with three beats and a counter, one plain.
const SCENES = `
SpecWithCodeDeck.start({
  title: "Test deck",
  scenes: [
    { id: "intro", beats: [{ dur: 0.3 }, { dur: 0.3 }, { dur: 0.3 }], html: '<h1 id="t">Hello there world</h1><b id="n"></b>',
      create(ctx) {
        const scene = new ctx.THREE.Scene();
        const camera = new ctx.THREE.PerspectiveCamera(40, 1, 0.1, 100);
        const mesh = new ctx.THREE.Mesh(new ctx.THREE.IcosahedronGeometry(1, 2), new ctx.THREE.MeshBasicMaterial({ color: 0xffaa55 }));
        scene.add(mesh); camera.position.z = 5;
        const counter = ctx.odometer(ctx.$("#n"));
        return { scene, camera, update(s) { mesh.rotation.y = s.time; ctx.rise(ctx.$("#t"), s.win(0, 0, 0.3)); counter.set(Math.round(1234 * s.win(1, 0, 0.3))); } };
      } },
    { id: "second", transition: "iris", html: "<p>Two</p>",
      create(ctx) { return { scene: new ctx.THREE.Scene(), camera: new ctx.THREE.PerspectiveCamera() }; } },
  ],
});`;

// A first scene whose enter() throws and whose update() throws after a while, and a
// second scene with its own text field.
const FAULTY = `
SpecWithCodeDeck.start({
  title: "Faulty deck",
  scenes: [
    { id: "broken", beats: [{ dur: 0.2 }],
      create(ctx) {
        let t = 0;
        return { scene: new ctx.THREE.Scene(), camera: new ctx.THREE.PerspectiveCamera(),
          enter() { throw new Error("enter broke"); },
          update(s) { t += 1; if (t > 30) throw new Error("update broke"); } };
      } },
    { id: "form", html: '<input id="field">',
      create(ctx) { return { scene: new ctx.THREE.Scene(), camera: new ctx.THREE.PerspectiveCamera() }; } },
  ],
});`;

// A scene whose id ends in -2, with its own button.
const NAMED = `
SpecWithCodeDeck.start({
  title: "Named deck",
  scenes: [
    { id: "intro", beats: [{ dur: 0.2 }],
      create(ctx) { return { scene: new ctx.THREE.Scene(), camera: new ctx.THREE.PerspectiveCamera() }; } },
    { id: "scene-2", beats: [{ dur: 0.2 }, { dur: 0.2 }],
      html: '<button id="press" onclick="window.pressed=(window.pressed||0)+1">Press</button>',
      create(ctx) { return { scene: new ctx.THREE.Scene(), camera: new ctx.THREE.PerspectiveCamera() }; } },
    { id: "end", beats: [{ dur: 0.2 }],
      create(ctx) { return { scene: new ctx.THREE.Scene(), camera: new ctx.THREE.PerspectiveCamera() }; } },
  ],
});`;

const page = (hash: string, withThree = true, scenes = SCENES) => ({
  url: `http://deck.test/${hash}`,
  html: `<!doctype html><html><head><meta name="specwithcode-page" content="stage"></head><body>
${withThree ? `<script>${THREE}</script>` : ""}<script>${DECK}</script><script>${scenes}</script></body></html>`,
});

describe("motion deck runtime", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const ready = (tab: Page) =>
    tab.waitForFunction("window.specwithcodeReady === true", null, { timeout: 60_000 });

  async function open(hash: string, withThree = true, scenes = SCENES): Promise<Page> {
    const target = page(hash, withThree, scenes);
    const tab = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await tab.route("http://deck.test/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: target.html }),
    );
    await tab.goto(target.url);
    return tab;
  }

  it("loads, keeps a deep link and moves beat by beat with keys", async () => {
    const tab = await open("#intro-2");
    await ready(tab);
    expect(await tab.evaluate<string>("location.hash")).toBe("#intro-2");
    await tab.keyboard.press("ArrowRight");
    expect(await tab.evaluate<string>("location.hash")).toBe("#intro-3");
    await tab.keyboard.press("ArrowRight");
    expect(await tab.evaluate<string>("location.hash")).toBe("#second");
    await tab.keyboard.press("ArrowLeft");
    expect(await tab.evaluate<string>("location.hash")).toBe("#intro-3");
    await tab.keyboard.press("Home");
    expect(await tab.evaluate<string>("location.hash")).toBe("#intro");
    await tab.evaluate(`location.hash = "#second"`);
    await tab.waitForFunction(`SpecWithCodeDeck.current.info().scene === "second"`);
    await tab.close();
  });

  it("rolls the counter and lifts words on beat windows", async () => {
    const tab = await open("#intro-2");
    await ready(tab);
    await tab.evaluate(`SpecWithCodeDeck.current.seek("intro", 2, 1)`);
    const state = await tab.evaluate<{ columns: number; words: number; lastWord: string }>(`({
      columns: document.querySelectorAll("#n .swc-col").length,
      words: document.querySelectorAll("#t .swc-w").length,
      lastWord: document.querySelector("#t .swc-w:last-child > span").style.transform,
    })`);
    expect(state.columns).toBe(4);
    expect(state.words).toBe(3);
    expect(state.lastWord).toMatch(/^translate3d\(0px, 0%/);
    await tab.close();
  });

  it("leaves Escape to the host when nothing is open, and takes it to close help", async () => {
    const tab = await open("");
    await ready(tab);
    const escape = () =>
      tab.evaluate<boolean>(`(() => {
        const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      })()`);
    expect(await escape()).toBe(false);
    await tab.keyboard.press("?");
    expect(await tab.locator(".swc-help").count()).toBe(1);
    expect(await escape()).toBe(true);
    expect(await tab.locator(".swc-help").count()).toBe(0);
    await tab.close();
  });

  it("says what is missing when three.js is not on the page", async () => {
    const tab = await open("", false);
    await expect(tab.locator(".swc-error").textContent()).resolves.toContain("specwithcode:three");
    expect(await tab.evaluate<string>("window.specwithcodeFailed")).toContain("specwithcode:three");
    await tab.close();
  });

  it("keeps going past a scene that throws, and leaves typed keys to a scene's field", async () => {
    const tab = await open("", true, FAULTY);
    await ready(tab);
    // enter() threw on the first scene, yet the loader went and the deck still moves.
    await tab.waitForFunction("!document.querySelector('.swc-load')", null, { timeout: 5_000 });
    await tab.waitForTimeout(800); // long enough for update() to throw too
    await tab.keyboard.press("ArrowRight");
    expect(await tab.evaluate<string>("location.hash")).toBe("#form");
    await tab.click("#field");
    await tab.keyboard.type("a f m");
    await tab.keyboard.press("Backspace");
    expect(await tab.inputValue("#field")).toBe("a f ");
    expect(await tab.evaluate<string>("location.hash")).toBe("#form");
    await tab.close();
  });

  it("opens a scene whose id ends in a number, and leaves Enter to a focused button", async () => {
    const tab = await open("#scene-2", true, NAMED);
    await ready(tab);
    expect(await tab.evaluate<string>("location.hash")).toBe("#scene-2");
    await tab.focus("#press");
    await tab.keyboard.press("Enter");
    expect(await tab.evaluate<number>("window.pressed")).toBe(1);
    expect(await tab.evaluate<string>("location.hash")).toBe("#scene-2");
    await tab.close();
  });
});

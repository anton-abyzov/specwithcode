// @effect-diagnostics nodeBuiltinImport:off - Reads the runtime and three.js from disk for a browser test.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { joinMotionDeck, wrapThreeCommonJs } from "./localArtifactLibs.ts";

const DECK = joinMotionDeck(NodeURL.fileURLToPath(new URL("./artifact-libs", import.meta.url)));
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

// Two small lit worlds with every helper, AgX and halation, joined by a long portal.
const WORLDS = `
function lit(ctx, s) {
  const scene = new ctx.THREE.Scene();
  const camera = new ctx.THREE.PerspectiveCamera(40, 16 / 9, 0.5, 4000);
  camera.position.set(0, 40, 120); camera.lookAt(0, 0, -200);
  const w = ctx.world(scene, { sun: [0.3, 0.2, -1], fogDensity: 0.001 });
  w.sky({ clouds: 0.6, stars: 0.5 });
  w.terrain({ height: 60, segments: 40, size: 1200, plateau: { center: [0, -200], radius: 120 } });
  w.water({ level: -20 });
  const field = w.field({ cols: 24, rows: 24, spacing: 5, center: [0, -200], scan: 0 });
  w.arcs({ pairs: [{ from: [-60, 0, -200], to: [60, 0, -220] }] });
  w.motes({ count: 50 });
  w.slab({ position: [0, 0, -300], progress: 0.5 });
  return { scene, camera, field, update(st) { field.set({ on: 40 + st.win(0, 0, 0.3) * 100 }); } };
}
SpecWithCodeDeck.start({
  title: "World deck",
  scenes: [
    { id: "a", beats: [{ dur: 0.3 }], post: { tone: "agx", halation: 0.5, ca: 0.5, shadows: [0, 0, 0.02] },
      html: '<h1 id="h">Lit world</h1>', create: (ctx) => lit(ctx) },
    { id: "b", transition: "portal", beats: [{ dur: 0.3 }], html: '<h1 id="g">Second</h1>', create: (ctx) => lit(ctx) },
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

  it("refuses a scene id that is another scene's beat link", async () => {
    const clashing = NAMED.replace('id: "intro"', 'id: "scene"');
    const tab = await open("", true, clashing);
    await tab.waitForFunction("typeof window.specwithcodeFailed === 'string'", null, {
      timeout: 10_000,
    });
    expect(await tab.evaluate<string>("window.specwithcodeFailed")).toContain('"scene-2"');
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

  // Mean brightness (0 to 255) of the frame the deck just drew, read in the same task.
  const brightness = `(() => {
    const gl = document.getElementById("swc-stage").getContext("webgl2");
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return sum / (w * h * 3);
  })()`;

  it("draws a lit world with AgX, halation and every world helper", async () => {
    const tab = await open("", true, WORLDS);
    const errors: string[] = [];
    tab.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await ready(tab);
    const lit = await tab.evaluate<number>(
      `(SpecWithCodeDeck.current.seek("a", 1, 0.4), ${brightness})`,
    );
    expect(lit).toBeGreaterThan(20);
    expect(errors).toEqual([]);
    // The display face is registered with its width axis.
    expect(
      await tab.evaluate<boolean>(`document.fonts.check('700 20px "SpecWithCode Display"')`),
    ).toBe(true);
    expect(
      await tab.evaluate<string>(
        `[...document.fonts].find((f) => f.family.includes("SpecWithCode Display")).stretch`,
      ),
    ).toBe("62% 125%");
    await tab.close();
  });

  it("registers the shader transitions and draws each one mid-way", async () => {
    const tab = await open("", true, WORLDS);
    const errors: string[] = [];
    tab.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await ready(tab);
    const names = await tab.evaluate<string[]>("SpecWithCodeDeck.current.transitions()");
    expect(names).toEqual(
      expect.arrayContaining([
        "fade",
        "iris",
        "wipe",
        "portal",
        "flaps",
        "curl",
        "wash",
        "slam",
        "tear",
        "zoom",
      ]),
    );
    for (const name of names) {
      const drawn = await tab.evaluate<[string, number]>(
        `[SpecWithCodeDeck.current.transitionFrame("b", 0.5, ${JSON.stringify(name)}), ${brightness}]`,
      );
      expect(drawn[0]).toBe(name);
      expect(drawn[1], name).toBeGreaterThan(10);
    }
    // An unknown name falls back to fade.
    expect(
      await tab.evaluate<string>(`SpecWithCodeDeck.current.transitionFrame("b", 0.5, "nope")`),
    ).toBe("fade");
    expect(errors).toEqual([]);
    await tab.close();
  });

  it("keeps the incoming scene's text hidden until the transition is mostly through", async () => {
    const tab = await open("", true, WORLDS);
    await ready(tab);
    await tab.keyboard.press("ArrowRight");
    const layers = () =>
      tab.evaluate<boolean[]>(
        `[...document.querySelectorAll(".swc-layer")].map((l) => l.classList.contains("swc-on"))`,
      );
    expect(await layers()).toEqual([false, false]);
    await tab.waitForFunction(
      `document.querySelectorAll(".swc-layer")[1].classList.contains("swc-on")`,
      null,
      {
        timeout: 20_000,
      },
    );
    expect(await tab.evaluate<string>("location.hash")).toBe("#b");
    await tab.close();
  });

  it("keeps going back when Back is pressed again during a backward transition", async () => {
    const tab = await open("#end", true, NAMED);
    await ready(tab);
    await tab.keyboard.press("ArrowLeft");
    await tab.keyboard.press("ArrowLeft");
    expect(await tab.evaluate<string>("location.hash")).toBe("#scene-2-2");
    await tab.waitForFunction(
      `document.querySelectorAll(".swc-layer")[1].classList.contains("swc-on")`,
    );
    expect(await tab.evaluate<string>("SpecWithCodeDeck.current.info().scene")).toBe("scene-2");
    await tab.close();
  });

  it("animates glyphs with each kinetic type style", async () => {
    const tab = await open("", true, WORLDS);
    await ready(tab);
    const styles = ["rise", "blur", "track", "scatter", "drop", "type"];
    const result = await tab.evaluate<
      Record<string, { start: string[]; end: string[]; blur: string }>
    >(`(() => {
      const out = {};
      for (const style of ${JSON.stringify(styles)}) {
        const node = document.createElement("h2");
        node.textContent = "Ship it";
        document.body.appendChild(node);
        SpecWithCodeDeck.type(node, 0, { style });
        const glyphs = [...node.querySelectorAll(".swc-c")];
        const start = glyphs.map((g) => g.style.opacity);
        const blur = glyphs[0].style.filter;
        SpecWithCodeDeck.type(node, 1, { style });
        out[style] = { start, end: glyphs.map((g) => g.style.opacity), blur };
      }
      return out;
    })()`);
    for (const style of styles) {
      expect(result[style]!.start.length, style).toBe(6);
      expect(
        result[style]!.start.every((o) => Number(o) === 0),
        style,
      ).toBe(true);
      expect(
        result[style]!.end.every((o) => Number(o) === 1),
        style,
      ).toBe(true);
    }
    expect(result.blur!.blur).toMatch(/^blur\(/);
    await tab.close();
  });
});

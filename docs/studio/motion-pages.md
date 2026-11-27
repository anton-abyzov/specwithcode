# Motion pages

A motion page is a presentation or animation that an agent publishes with `html_render`: WebGL scenes, kinetic type, a loading bar and synthesized sound, in one HTML file that runs offline. SpecWithCode shows it as a **stage page**: it gets the whole viewer instead of a measured box in the thread.

The example is [`examples/motion-deck/demo.html`](../../examples/motion-deck/demo.html), an original three-scene deck.

## Stage pages

A page opts in with one tag in its head:

```html
<meta name="specwithcode-page" content="stage" />
```

Put it early in the head, before any text or body element. SpecWithCode reads the head the way a browser does, and a page it cannot read with certainty, such as one with a `<template>` or a script containing `<!--` before the tag, is shown as a report.

Then:

| Where               | What the reader gets                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread              | A card with Play and Install as app. The page does not run in the timeline.                                                                                     |
| Reader (after Play) | The page fills the viewer, has keyboard focus, and its frame allows `autoplay; fullscreen`. Closing the reader unloads it, which stops sound and frees the GPU. |
| Installed window    | The page fills the window, never scrolls, and has focus.                                                                                                        |
| Publishing          | The page is not measured; size it to the viewport (`100vw` / `100vh`).                                                                                          |

The frame stays sandboxed as every page is (`allow-scripts allow-forms`, opaque origin), so `localStorage` and cookies are unavailable. Sound still needs one click or key press in the page, as browsers require.

A page's own URL fragment survives the theme bootstrap, so `#scene-2` deep links work, and `history.replaceState` and `hashchange` behave normally.

## Publishing large pages

`html_render` and `html_preview` accept either `html` or `path`. Use `path` (an absolute path to an `.html` or `.htm` file, up to 25 MiB) for anything big; inline `html` is capped at 512,000 characters.

`html_preview` captures a stage page at 1280 px wide, 16:9, after the page sets `window.specwithcodeReady = true`. It waits up to 90 seconds, then captures anyway with a warning. A page that cannot run sets `window.specwithcodeFailed` to a message (the deck does this for you): the preview then captures at once and returns the page's errors.

## Libraries

Pages name SpecWithCode's own libraries with a `specwithcode:` script source. Publishing replaces each with the library's code, once per page, so the page needs no network:

```html
<script src="specwithcode:three"></script>
<!-- three.js r180, as window.THREE -->
<script src="specwithcode:motion-deck"></script>
<!-- window.SpecWithCodeDeck -->
```

An unknown name fails the publish with the list of known names. Remote `https://` scripts still load as written, but a stage page should not need them.

## The deck runtime

```js
SpecWithCodeDeck.start({
  title: "Shown on the loading screen",
  scenes: [
    {
      id: "intro", // #intro, #intro-2, #intro-3 link to its beats; no other scene may be "intro-2"
      beats: [{ dur: 2.4, notes: "Speaker notes for beat 1" }, { dur: 3 }],
      html: "<h1 id='t'>Words</h1>", // a DOM layer above the canvas, shown with the scene
      transition: "iris", // into this scene: "fade", "iris" or "wipe"
      bed: { notes: [50, 57, 62, 69], color: "air" }, // music while the scene is on
      post: { bloom: 1.2, grain: 0.03 }, // or (s) => ({ ... }) per frame
      create(ctx) {
        const scene = new ctx.THREE.Scene();
        const camera = new ctx.THREE.PerspectiveCamera(40, 16 / 9, 0.1, 100);
        return {
          scene,
          camera,
          beat(k) {
            ctx.audio.hit("chime");
          }, // a beat started
          update(s) {
            ctx.rise(ctx.$("#t"), s.win(0, 0, 1.2));
          },
        };
      },
    },
  ],
});
```

### Timing

Each scene has beats. A beat's clock starts when the presenter reaches it, and `s.win(k, t0, t1, ease)` returns 0 to 1 over seconds `t0` to `t1` of beat `k`, eased. Earlier beats read as finished, later ones as not started, and going back rewinds them, so a scene is a function of its beat clocks and can be seeked (`SpecWithCodeDeck.current.seek(id, beat, seconds)`).

`s` also carries `time`, `dt`, `beat`, `enter` (0 to 1 while the scene transitions in), `mouse` (-1 to 1), `width`, `height` and `aspect`.

Easings: `linear`, `inQuad`, `outQuad`, `inOutQuad`, `outCubic`, `inOutCubic`, `outQuart`, `inOutQuart`, `outExpo`, `inOutExpo`, `outBack`, `inOutSine`, `spring`, or a function.

### What `create(ctx)` returns

| Key                       | Purpose                                                                     |
| ------------------------- | --------------------------------------------------------------------------- |
| `scene`, `camera`         | Drawn every frame through the post pass.                                    |
| `update(s)`               | Animate from `s`.                                                           |
| `beat(k, s)`              | A beat started (play a sound, start a burst).                               |
| `enter(s)`                | The scene became current.                                                   |
| `init(s)`                 | Async setup before the scene is warmed up (load or bake data).              |
| `resize(s)`               | The viewport changed.                                                       |
| `pointer(type, event, s)` | Pointer input; return true from `"down"` to take a drag instead of a click. |
| `render(target, s)`       | Draw yourself into the HDR target instead of `scene`/`camera`.              |

`ctx` holds `THREE`, `renderer`, `audio`, `layer` (the scene's DOM layer), `$` (a query inside it), `rise`, `words`, `odometer`, `ease`, `rng` (seeded random), `glsl` (hash, noise and fbm snippets), `mix` and `clamp01`.

### Loading

Before the show, the deck builds every scene, compiles its shaders and draws each beat once offscreen, moving the loading bar one step per scene. Then it sets `window.specwithcodeReady = true` and fires `specwithcode:ready`. A scene that throws while loading is skipped and logged; the others still run. A scene that throws later, in any of its own functions, goes blank and is logged, and the deck keeps moving.

A scene's own `input`, `textarea`, `select`, `button`, link or label takes clicks and keys; the deck's keys stay out of it while it has focus. Everything else in a scene's HTML lets clicks through to the stage.

### Picture

Scenes render into a half-float target. The post pass adds a bloom chain, exposure, ACES tone mapping, contrast and saturation, lift and gain, vignette, film grain, optional chromatic aberration, and dither. `post` options: `bloom`, `threshold`, `knee`, `exposure`, `vignette`, `grain`, `contrast`, `saturation`, `ca`, `fade`, `fadeColor`, `lift`, `gain`. Colours above 1 glow.

Resolution follows the device pixel ratio up to `maxPixelRatio` (2) and drops to 60% when frames run slow, recovering when there is headroom.

### Type

- `rise(element, p, {stagger, ease})` lifts an element's words in one after another as `p` goes 0 to 1.
- `odometer(element, {decimals, group})` returns `{ set(value) }`, a rolling-digit counter.

The DOM layer uses `--u`, one 1920×1080 design pixel, so `calc(var(--u) * 96)` is a 96 px headline at 1080p at any size.

### Sound

Everything is synthesized; there are no audio files. `bed({notes, color, level})` holds a chord (MIDI notes; color `warm`, `glass`, `dark` or `air`) through a filter and a generated-impulse reverb; `chord(notes, glide)` moves it; `hit(kind, {note, gain, pan, verb, delay, dur})` plays `tick`, `pop`, `chime`, `whoosh`, `rise`, `boom` or `blip`. Sound starts on the reader's first click or key; until then beds wait and hits are dropped.

### Keys

| Key                                            | Action                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| → ↓ Space PageDown Enter, click, swipe left    | Next beat                                                                     |
| ← ↑ PageUp Backspace, right-click, swipe right | Back (during a transition, undoes it)                                         |
| Home / End                                     | First / last scene                                                            |
| F                                              | Fullscreen                                                                    |
| M                                              | Sound on or off                                                               |
| N                                              | Speaker notes                                                                 |
| A                                              | Play by itself                                                                |
| ?                                              | Key help                                                                      |
| Escape                                         | Closes help or notes; otherwise goes to SpecWithCode, which closes the reader |

With reduced motion requested, beats complete at once and scenes cut instead of transitioning.

## Building

`node apps/server/scripts/cli.ts build` writes `dist/client/artifact-libs/three.js` (three's CommonJS build wrapped to set `window.THREE`, minified) and copies `motion-deck.js` from `apps/server/src/htmlRender/artifact-libs/`. In development the server reads both from the source tree.

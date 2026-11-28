# Motion pages

A motion page is a presentation or animation that an agent publishes with `html_render`: WebGL scenes, kinetic type, a loading bar and synthesized sound, in one HTML file that runs offline. SpecWithCode shows it as a **stage page**: it gets the whole viewer instead of a measured box in the thread.

The example is [`examples/motion-deck/demo.html`](../../examples/motion-deck/demo.html), an original five-scene deck: a dawn valley, a city of agents at night, a twilight sea, a blue-hour review board and a sea of clouds, each joined by a different transition.

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
      transition: "portal", // into this scene; see Transitions
      bed: { notes: [50, 57, 62, 69], color: "air" }, // music while the scene is on
      post: { tone: "agx", bloom: 0.9, halation: 0.4, grain: 0.03 }, // or (s) => ({ ... }) per frame
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

`ctx` holds `THREE`, `renderer`, `audio`, `layer` (the scene's DOM layer), `$` (a query inside it), `world`, `type`, `rise`, `words`, `odometer`, `ease`, `rng` (seeded random), `glsl` (hash, noise and fbm snippets), `mix` and `clamp01`.

### Loading

Before the show, the deck loads its display face, builds every scene, compiles its shaders and every transition's, and draws each beat once offscreen, moving the loading bar one step per scene. Then it sets `window.specwithcodeReady = true` and fires `specwithcode:ready`. A scene that throws while loading is skipped and logged; the others still run. A scene that throws later, in any of its own functions, goes blank and is logged, and the deck keeps moving.

A scene's own `input`, `textarea`, `select`, `button`, link or label takes clicks and keys; the deck's keys stay out of it while it has focus. Everything else in a scene's HTML lets clicks through to the stage.

### Picture

Scenes render into a half-float target. The post pass adds a bloom chain, exposure, tone mapping, contrast and saturation, lift and gain, a split-tone grade, vignette, film grain, chromatic aberration, halation and dither. Colours above 1 glow.

| `post` option                | Default       | Meaning                                                                |
| ---------------------------- | ------------- | ---------------------------------------------------------------------- |
| `tone`                       | `"aces"`      | `"agx"` (softer, filmic highlights), `"aces"` or `"none"`              |
| `exposure`                   | 1             | Multiplies the scene before tone mapping                               |
| `bloom`, `threshold`, `knee` | 0.6, 0.9, 0.5 | Glow strength and where it starts                                      |
| `halation`                   | 0             | Film's red-orange glow around highlights; 0.2 to 0.5                   |
| `ca`                         | 0             | Chromatic aberration toward the edges; 0.3 to 1                        |
| `grain`                      | 0.03          | Film grain, strongest in the mid-tones; 0.016 to 0.035 reads as filmed |
| `vignette`                   | 0.25          | Darkens the corners                                                    |
| `contrast`, `saturation`     | 1.02, 1.05    | Grade after tone mapping                                               |
| `lift`, `gain`               | black, white  | Shadow and highlight levels, as `[r, g, b]`                            |
| `shadows`, `highlights`      | `[0, 0, 0]`   | Split tone: small colour offsets such as `[0, 0.01, 0.03]`             |
| `fade`, `fadeColor`          | 0, black      | Fades the frame to a colour                                            |

Resolution follows the device pixel ratio up to `maxPixelRatio` (2) within `maxPixels` (4.2 million, so a 5K window stays fast), and drops to 60% when frames run slow, recovering when there is headroom.

### Worlds

A scene that is a dark background with a few objects looks empty. `ctx.world(scene, atmosphere)` builds a lit place that fills the frame, from custom GLSL with one sun, sky ambient and fog, so everything in it agrees:

```js
const world = ctx.world(scene, {
  sun: [0.25, 0.07, -1], // direction toward the sun
  sunColor: [4.2, 2.5, 1.5], // HDR: above 1 glows
  zenith: [0.1, 0.2, 0.42],
  horizon: [1.05, 0.62, 0.45],
  ground: [0.2, 0.14, 0.14],
  fog: [0.8, 0.5, 0.42],
  fogDensity: 0.00045,
  fogHeight: 0.008,
});
world.sky({ clouds: 0.55, stars: 0 });
world.terrain({
  height: 260,
  scale: 0.0024,
  ridge: 0.75,
  valley: 1,
  plateau: { center: [0, -330], radius: 300, height: -24 },
});
world.water({ level: -60 });
const tasks = world.field({ cols: 64, rows: 44, spacing: 7, center: [0, -330], reach: 0 });
// in update(s): tasks.set({ reach: s.win(1, 0, 3) * 300 });
```

| Helper                                                                                                                                          | What it draws                                                                            | Animate with `set`                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sky({clouds, cloudScale, cloudColor, cloudShade, stars, sunSize})`                                                                             | Gradient sky, sun disc, lit fbm clouds, twinkling stars                                  | the same options                                                                                                                 |
| `terrain({height, scale, ridge, seed, valley, valleyWidth, base, plateau, size, segments, low, high, rock, snow, snowLine, ambient})`           | Hills and ridges on the GPU, a meandering valley, an optional flat plateau               | `height`, `scale`, `valley`, `base`, colours                                                                                     |
| `water({level, color, glint, ripple})`                                                                                                          | Sky reflection, ripples and a sun glint                                                  | the same options                                                                                                                 |
| `field({cols, rows, spacing, center, focus, tile, density, block, street, jitter, on, reach, color, colorB, glow, scan, passColor, failColor})` | One glowing screen per grid cell, standing on the terrain: tens of thousands in one draw | `on` (lit radius around `focus`), `reach` (how far tiles have risen), `scan` (an x behind which tiles show pass or fail colours) |
| `arcs({pairs: [{from, to, height, width}], color, glow, packets, speed, progress})`                                                             | Beams of light along curves, with travelling packets                                     | `progress` reveals them                                                                                                          |
| `motes({count, center, box, color, size, rise})`                                                                                                | Drifting points of light                                                                 | `color`, `glow`                                                                                                                  |
| `slab({position, size, yaw, color, glow, rows, progress})`                                                                                      | A glossy monolith with a screen of text and a progress bar                               | `glow`, `progress`                                                                                                               |

`world.set({...})` moves the sun or changes the sky and fog. The deck keeps each world's clock in step with its scene, so seeking works. Give every scene its own palette and time of day.

### Transitions

A scene's `transition` plays when the deck moves into it; going back plays it in reverse, faster. Each has its own length and a synthesized sound cue.

| Name     | Seconds | Look                                                                   |
| -------- | ------- | ---------------------------------------------------------------------- |
| `fade`   | 1.2     | Crossfade                                                              |
| `iris`   | 1.2     | A soft-edged circle opens                                              |
| `wipe`   | 1.2     | A ragged diagonal wipe                                                 |
| `portal` | 2.4     | The old slide becomes a card that tilts and recedes into the new world |
| `flaps`  | 2.2     | A split-flap board flips tile by tile, left to right                   |
| `curl`   | 2.0     | The old slide curls away like paper, showing its blank back            |
| `wash`   | 2.2     | A wave with a foaming lip sweeps the new scene in                      |
| `slam`   | 1.6     | The new scene lands hard: a flash and a shake                          |
| `tear`   | 2.0     | The old slide tears down a ragged line and the halves pull apart       |
| `zoom`   | 1.4     | A push through the old slide with radial blur                          |

An unknown name plays `fade`. Add your own: `SpecWithCodeDeck.transitions.mine = { dur: 2, glsl: "vec3 transition(vec2 uv){ return mix(A(uv), B(uv), p); }", cue(audio, dur) {} }`, where the shader gets `A(uv)`, `B(uv)`, `p`, `aspect`, `time`, `res` and the `swcHash`, `swcNoise` and `swcFbm` helpers. The incoming scene's text appears once a transition is 60% through, and its first beat starts then.

### Type

The runtime carries a display face, **SpecWithCode Display** (Archivo, SIL Open Font License 1.1), with a width axis from 62% to 125% and weights 100 to 900. It is the default for scene layers. Class `swc-display` sets it wide and heavy for headlines; `font-stretch` picks any width in between.

- `type(element, p, {style, stagger, ease, out})` animates glyph by glyph as `p` goes 0 to 1: `rise` (from below a line mask), `blur`, `track` (letters converge), `scatter`, `drop` (with overshoot) or `type`. `out` (0 to 1) takes them away again.
- `rise(element, p, {stagger, ease})` lifts an element's words in one after another.
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

## Testing a deck

`SpecWithCodeDeck.current` has deterministic hooks for stills and checks:

- `seek(id, beat, seconds)` puts a scene at a beat and plays it for `seconds`.
- `transitionFrame(id, p, name)` draws the transition into scene `id` at `p` (0 to 1) and holds that frame until the next key, seek or jump.
- `perf(n)` draws `n` frames of the current scene, waiting for the GPU each time, and returns the mean milliseconds and the drawing size.
- `transitions()` lists the registered transitions.

## Building

`node apps/server/scripts/cli.ts build` writes `dist/client/artifact-libs/three.js` (three's CommonJS build wrapped to set `window.THREE`, minified) and `motion-deck.js`, joined from its source parts in `apps/server/src/htmlRender/artifact-libs/`: `motion-deck.js` (core), `motion-deck-audio.js`, `motion-deck-fx.js` (transitions), `motion-deck-world.js` (worlds and type) and the font in `fonts/` with its licence. In development the server joins the same parts from the source tree.

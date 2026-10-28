/**
 * The script a preview build runs with Node inside the kit's own package, so
 * the kit's code, its esbuild, React and Storybook are loaded there and never
 * into the server. It reads a job file, bundles one entry that requires every
 * stories file and component file lazily (one that fails to load is reported,
 * not fatal), renders each composed story with `react-dom/server`, bundles the
 * CSS the kit ships and the Storybook preview imports with fonts and images as
 * data URLs, and writes a result file. Plain JavaScript: it runs as written.
 */
export const PREVIEW_RUNNER_SOURCE = String.raw`
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const jobPath = process.argv[2];
const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
const out = { fatal: null, problems: [], components: {}, css: "", cssSkipped: [] };
const write = () => fs.writeFileSync(job.resultPath, JSON.stringify(out));
const message = (error) => {
  const first = error && Array.isArray(error.errors) ? error.errors[0] : undefined;
  if (first) return (first.text + (first.location ? " (" + first.location.file + ":" + first.location.line + ")" : "")).slice(0, 300);
  return String((error && error.message) || error).split("\n")[0].slice(0, 300);
};

const req = createRequire(path.join(job.packageRoot, "package.json"));
let esbuild = null;
for (const from of [null, "vite/package.json", "tsup/package.json"]) {
  try {
    esbuild = from === null ? req("esbuild") : createRequire(req.resolve(from))("esbuild");
    break;
  } catch {}
}
if (esbuild === null) {
  out.fatal = "esbuild";
  write();
  process.exit(0);
}
let storybook = true;
try {
  req.resolve("@storybook/react");
} catch {
  storybook = false;
}
for (const name of ["react", "react-dom/server"]) {
  try {
    req.resolve(name);
  } catch {
    out.fatal = "react";
    write();
    process.exit(0);
  }
}

const lines = [
  'exports.React = require("react");',
  'exports.renderToStaticMarkup = require("react-dom/server").renderToStaticMarkup;',
  "exports.storybook = " + (storybook ? 'require("@storybook/react");' : "null;"),
  "exports.preview = " +
    (storybook && job.previewFile
      ? "() => require(" + JSON.stringify(path.join(job.packageRoot, job.previewFile)) + ");"
      : "null;"),
  "exports.stories = {};",
  "exports.modules = {};",
];
for (const file of job.storyFiles) {
  lines.push("exports.stories[" + JSON.stringify(file) + "] = () => require(" + JSON.stringify(path.join(job.packageRoot, file)) + ");");
}
for (const file of new Set(job.components.map((component) => component.file))) {
  lines.push("exports.modules[" + JSON.stringify(file) + "] = () => require(" + JSON.stringify(path.join(job.packageRoot, file)) + ");");
}
const entry = path.join(job.cacheDir, "entry.cjs");
const bundle = path.join(job.cacheDir, "bundle.cjs");
fs.writeFileSync(entry, lines.join("\n"));

const assetLoaders = {};
for (const extension of [".woff2", ".woff", ".ttf", ".otf", ".eot", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"]) {
  assetLoaders[extension] = "dataurl";
}
// Tailwind sources need the kit's Tailwind build; the kit's built CSS stands in for them.
const skipTailwind = {
  name: "skip-tailwind-sources",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, (args) => {
      const text = fs.readFileSync(args.path, "utf8");
      if (/@import\s+["']tailwindcss|@tailwind\s|@theme\s|@plugin\s|@source\s/.test(text)) {
        out.cssSkipped.push(path.relative(job.packageRoot, args.path));
        return { contents: "", loader: "css" };
      }
      return undefined;
    });
  },
};

try {
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    jsx: "automatic",
    logLevel: "silent",
    external: ["react", "react-dom", "react/*", "react-dom/*"],
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ...assetLoaders, ".css": "empty", ".js": "jsx" },
    plugins: [],
  });
} catch (error) {
  out.fatal = "bundle";
  out.problems.push(message(error));
  write();
  process.exit(0);
}

// "BothThemes" → "Both themes": story export names read as captions.
const storyLabel = (name) => {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

const silence = () => {
  const keep = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = () => {};
  return () => Object.assign(console, keep);
};

// Props each component receives while stories render, so one without stories of its
// own can be shown alone with the props a real story gave it.
const captured = new Map();
let currentStory = null;
const capture = (type, props) => {
  if (currentStory === null || type === null || typeof type === "string" || typeof type === "symbol") return;
  let list = captured.get(type);
  if (list === undefined) captured.set(type, (list = []));
  if (list.length < 3) list.push({ props, story: currentStory });
};
const kitRequire = createRequire(bundle);
const runtime = kitRequire("react/jsx-runtime");
for (const key of ["jsx", "jsxs"]) {
  const original = runtime[key];
  if (typeof original === "function") {
    runtime[key] = (type, props, ...rest) => {
      capture(type, props);
      return original(type, props, ...rest);
    };
  }
}
const reactModule = kitRequire("react");
const createElement = reactModule.createElement;
reactModule.createElement = (type, props, ...children) => {
  capture(type, children.length === 0 ? (props ?? {}) : { ...props, children: children.length === 1 ? children[0] : children });
  return createElement(type, props, ...children);
};

const restore = silence();
const kit = kitRequire(bundle);
restore();
const { React, renderToStaticMarkup } = kit;
const sb = kit.storybook;
if (kit.preview !== null) {
  try {
    sb.setProjectAnnotations(kit.preview());
  } catch (error) {
    out.problems.push("Storybook preview: " + message(error));
  }
}

// Nothing to see: no text, no media or control, no SVG shape, and no decorative layer
// (an aria-hidden element styled by the kit's CSS, such as a glyph or a backdrop).
const blank = (html) =>
  html.replace(/<[^>]*>/g, "").trim() === "" &&
  !/<(svg|img|canvas|video|picture|input|select|textarea|button|progress|meter|hr|g|path|rect|circle|ellipse|line|polyline|polygon)\b/i.test(html) &&
  !/<[a-z]+\b[^>]*\baria-hidden="true"[^>]*\b(class|style)=/i.test(html) &&
  !/<[a-z]+\b[^>]*\b(class|style)=[^>]*\baria-hidden="true"/i.test(html);
// SVG shapes outside any <svg> draw nothing in HTML: a component that renders a <g> or a
// <path> on its own is drawn inside an <svg> instead, without the page decorators.
const SHAPES = /<(g|path|rect|circle|ellipse|line|polyline|polygon|text|use)\b/i;
const strayShapes = (html) => SHAPES.test(html.replace(/<svg\b[\s\S]*?<\/svg>/gi, ""));
const inSvg = (value, props) => () =>
  React.createElement("svg", { xmlns: "http://www.w3.org/2000/svg", "data-swc-fragment": "" }, React.createElement(value, props));

const render = (Component) => {
  const quiet = silence();
  try {
    return { html: renderToStaticMarkup(React.createElement(Component)) };
  } catch (error) {
    return { error: message(error) };
  } finally {
    quiet();
  }
};

// Components by the value they export, so a stories file's meta.component finds its ids.
const byValue = new Map();
const byName = new Map();
for (const component of job.components) {
  let value;
  try {
    const quiet = silence();
    try {
      value = kit.modules[component.file]()[component.exportName];
    } finally {
      quiet();
    }
  } catch (error) {
    out.components[component.id] = { stories: [], note: "Its module does not load outside the app: " + message(error) };
    continue;
  }
  out.components[component.id] = { stories: [], note: null, value: value === undefined ? undefined : true };
  if (value !== undefined) byValue.set(value, [...(byValue.get(value) ?? []), component]);
  byName.set(component.exportName, [...(byName.get(component.exportName) ?? []), component]);
  component.value = value;
}

const STORY_BYTES = 1024 * 1024;
const COMPONENT_BYTES = 6 * 1024 * 1024;
const bytesOf = (stories) => stories.reduce((sum, story) => sum + story.html.length, 0);
if (sb !== null) {
  for (const file of job.storyFiles) {
    let module;
    try {
      const quiet = silence();
      try {
        module = kit.stories[file]();
      } finally {
        quiet();
      }
    } catch (error) {
      out.problems.push(file + ": " + message(error));
      continue;
    }
    const meta = module.default ?? {};
    const title = typeof meta.title === "string" ? meta.title.split("/").at(-1).trim() : "";
    // A stories file that names no component of its own (a page or a whole flow) still
    // renders, so the props it gives the components inside feed their previews.
    const owners = byValue.get(meta.component) ?? byName.get(title) ?? [];
    let composed;
    try {
      composed = sb.composeStories(module);
    } catch (error) {
      if (owners.length > 0) out.problems.push(file + ": " + message(error));
      continue;
    }
    for (const [key, Story] of Object.entries(composed)) {
      const label = typeof Story.storyName === "string" && Story.storyName !== key ? Story.storyName : storyLabel(key);
      currentStory = (title || file) + " · " + label;
      const result = render(Story);
      currentStory = null;
      for (const owner of owners) {
        const entryFor = out.components[owner.id];
        if (result.error !== undefined) {
          entryFor.failed = (entryFor.failed ?? 0) + 1;
          entryFor.lastError = result.error;
          continue;
        }
        if (blank(result.html)) {
          entryFor.blank = (entryFor.blank ?? 0) + 1;
          continue;
        }
        if (result.html.length > STORY_BYTES) {
          entryFor.large = (entryFor.large ?? 0) + 1;
          continue;
        }
        if (bytesOf(entryFor.stories) + result.html.length > COMPONENT_BYTES) continue;
        entryFor.stories.push({ name: label, html: result.html });
      }
    }
  }
}

// Example values for a component's declared props, from their types, so one with no
// story can still be shown: text for strings and nodes, small numbers, no-op handlers.
const SAMPLE_DATE = "2026-06-14T18:00:00Z";
const humanize = (name) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const sampleFor = (prop) => {
  const type = prop.type.replace(/\s+/g, " ").trim();
  const name = prop.name;
  if (/=>/.test(type)) return () => {};
  const literal = type.match(/^(["'])([^"']*)\1/);
  if (literal) return literal[2];
  if (/\[\]$|^readonly |^(Readonly)?Array</.test(type)) return [];
  if (/\bDate\b/.test(type) || /(At|Date)$/.test(name)) return SAMPLE_DATE;
  if (/\bboolean\b/.test(type)) return name === "checked" || name === "open" || name === "visible";
  if (/\bnumber\b/.test(type)) return 3;
  if (/(url|src|href)$/i.test(name)) return undefined;
  if (/\bstring\b|ReactNode|ReactElement|JSX\.Element/.test(type)) return humanize(name);
  return undefined;
};
const OPTIONAL_TEXT = new Set(["children", "label", "title", "name", "description", "placeholder"]);
const sampleProps = (props) => {
  const sample = {};
  let filled = 0;
  for (const prop of props) {
    if (prop.optional && !OPTIONAL_TEXT.has(prop.name)) continue;
    const value = sampleFor(prop);
    if (value === undefined) continue;
    sample[prop.name] = value;
    filled += 1;
  }
  return filled === 0 ? null : sample;
};

// A component no story rendered gets one bare render, through the preview's decorators when there are any.
for (const component of job.components) {
  const entryFor = out.components[component.id];
  if (entryFor.stories.length > 0 || component.value === undefined) {
    if (component.value === undefined && entryFor.note === null) entryFor.note = "It is not exported from its file.";
    continue;
  }
  if (
    (typeof component.value !== "function" && typeof component.value !== "object") ||
    (typeof component.value === "function" && /^class\b/.test(Function.prototype.toString.call(component.value)) && !component.value.prototype?.isReactComponent)
  ) {
    entryFor.note = "It is not a component.";
    entryFor.notComponent = true;
    continue;
  }
  const alone = (args) => {
    if (sb !== null) {
      const quiet = silence();
      try {
        return sb.composeStory({ args }, { title: component.exportName, component: component.value });
      } catch {
      } finally {
        quiet();
      }
    }
    return (extra) => React.createElement(component.value, { ...args, ...extra });
  };
  const renderAlone = (props) => {
    const result = render(alone(props));
    if (result.error === undefined && strayShapes(result.html)) return render(inSvg(component.value, props));
    return result;
  };
  const seen = new Set();
  for (const use of captured.get(component.value) ?? []) {
    const result = renderAlone(use.props);
    if (result.error !== undefined || blank(result.html) || result.html.length > STORY_BYTES) continue;
    if (seen.has(result.html)) continue;
    seen.add(result.html);
    entryFor.stories.push({ name: "As used in " + use.story, html: result.html });
  }
  if (entryFor.stories.length > 0) continue;
  const sample = sampleProps(component.props ?? []);
  if (sample !== null) {
    const result = renderAlone(sample);
    if (result.error === undefined && !blank(result.html) && result.html.length <= STORY_BYTES) {
      entryFor.stories.push({ name: "Sample props", html: result.html });
      continue;
    }
  }
  const result = renderAlone({});
  if (result.error === undefined && !blank(result.html) && result.html.length <= STORY_BYTES) {
    entryFor.stories.push({ name: "Default", html: result.html });
    continue;
  }
  if (entryFor.failed) entryFor.note = "Its stories fail to render outside the app: " + entryFor.lastError;
  else if (entryFor.blank) entryFor.note = "Its stories render nothing until someone interacts (a dialog, menu or portal).";
  else if (result.error !== undefined) entryFor.note = "It needs props to render. Add a story with example props.";
  else entryFor.note = "It renders nothing without props. Add a story with example props.";
}
for (const entryFor of Object.values(out.components)) {
  delete entryFor.value;
  delete entryFor.failed;
  delete entryFor.blank;
  delete entryFor.large;
  delete entryFor.lastError;
}

// The stylesheet keeps only rules the rendered previews can use: a rule whose every
// selector names a class no preview has is dropped (a flag set ships hundreds), and
// @font-face rules for scripts other than Latin are dropped. Everything else stays.
const usedClasses = new Set();
for (const entryFor of Object.values(out.components)) {
  for (const story of entryFor.stories) {
    for (const match of story.html.matchAll(/\bclass="([^"]*)"/g)) {
      for (const name of match[1].split(/\s+/)) if (name !== "") usedClasses.add(name);
    }
  }
}
// The frame puts the theme on <html> as a class, so rules keyed on it stay.
for (const name of ["light", "dark"]) usedClasses.add(name);
const unescapeClass = (name) => name.replace(/\\(.)/g, "$1");
const selectorUsed = (selector) => {
  // Classes inside :not(), :where() and friends never decide whether a rule can match.
  const outer = selector.replace(/:(not|where|is|has)\((?:[^()]|\([^()]*\))*\)/g, "");
  const classes = [...outer.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)].map((match) => unescapeClass(match[1]));
  return classes.every((name) => usedClasses.has(name));
};
const LATIN = /U\+0000-00FF|U\+0-FF\b|U\+00-FF\b/i;
const purge = (css) => {
  let result = "";
  let index = 0;
  while (index < css.length) {
    const open = css.indexOf("{", index);
    if (open === -1) {
      result += css.slice(index);
      break;
    }
    const prelude = css.slice(index, open);
    let depth = 1;
    let close = open + 1;
    let quote = null;
    for (; close < css.length && depth > 0; close += 1) {
      const char = css[close];
      if (quote !== null) {
        if (char === "\\") close += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
    }
    const body = css.slice(open + 1, close - 1);
    const head = prelude.trim();
    if (/^@(media|supports|layer|container|document)\b/i.test(head)) {
      const inner = purge(body);
      if (inner.trim() !== "") result += prelude + "{" + inner + "}";
    } else if (/^@font-face/i.test(head)) {
      const range = body.match(/unicode-range:([^;}]*)/i);
      if (range === null || LATIN.test(range[1])) result += prelude + "{" + body + "}";
    } else if (head.startsWith("@") || head.split(",").some(selectorUsed)) {
      result += prelude + "{" + body + "}";
    }
    index = close;
  }
  return result;
};

// One stylesheet: the CSS the kit ships, then the CSS its Storybook preview imports.
const cssImports = [...job.cssFiles.map((file) => path.join(job.packageRoot, file))];
if (job.previewFile) {
  const source = fs.readFileSync(path.join(job.packageRoot, job.previewFile), "utf8");
  const base = path.dirname(path.join(job.packageRoot, job.previewFile));
  // Side-effect imports that are stylesheets: "./x.css", "pkg/x.css", or a package whose entry is CSS (fontsource).
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["'];?/gm)) {
    const specifier = match[1];
    let resolved;
    try {
      resolved = specifier.startsWith(".") ? path.resolve(base, specifier) : createRequire(path.join(base, "x.js")).resolve(specifier);
    } catch (error) {
      if (specifier.endsWith(".css")) out.problems.push("CSS " + specifier + ": " + message(error));
      continue;
    }
    if (resolved.endsWith(".css")) cssImports.push(resolved);
  }
}
if (cssImports.length > 0) {
  const cssEntry = path.join(job.cacheDir, "preview-entry.css");
  const cssOut = path.join(job.cacheDir, "preview.css");
  fs.writeFileSync(cssEntry, [...new Set(cssImports)].map((file) => "@import " + JSON.stringify(file) + ";").join("\n"));
  try {
    await esbuild.build({
      entryPoints: [cssEntry],
      outfile: cssOut,
      bundle: true,
      minify: true,
      logLevel: "silent",
      loader: assetLoaders,
      plugins: [skipTailwind],
    });
    out.css = purge(fs.readFileSync(cssOut, "utf8"));
  } catch (error) {
    out.problems.push("CSS: " + message(error));
  }
}
write();
`;

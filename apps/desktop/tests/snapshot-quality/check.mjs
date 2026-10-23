import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const viteRequire = createRequire(
  await fs.realpath(path.join(root, "node_modules/vite-plus/package.json")),
);
const { build } = createRequire(viteRequire.resolve("vite/package.json"))("esbuild");
const output = path.resolve(process.argv[2] ?? path.join(root, ".artifacts/snapshot-quality"));
await fs.mkdir(output, { recursive: true });
await build({
  stdin: {
    contents: `export { fitMacSnapShot } from './apps/desktop/src/snapShot/MacSnapShot.ts';
export { annotationCaptureRect } from './apps/desktop/src/preview/AnnotationCapture.ts';`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: path.join(output, "capture.cjs"),
});
await build({
  entryPoints: [path.join(root, "apps/desktop/src/preview/PickPreload.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(output, "picker.js"),
  plugins: [
    {
      name: "isolated-picker-boundaries",
      setup(builder) {
        builder.onResolve({ filter: /^(electron|react-grab\/primitives)$/ }, (args) => ({
          path: args.path,
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents:
            args.path === "electron"
              ? "export const ipcRenderer = window.__ipc;"
              : `export async function getElementContext(element) { return {selector: '#selected', htmlPreview: element.outerHTML, componentName: null, stack: [], styles: ''}; }`,
          loader: "js",
        }));
      },
    },
  ],
});
const electron = require("electron");
const run = spawnSync(
  electron,
  ["--headless", path.join(root, "apps/desktop/tests/snapshot-quality/electron.cjs"), output],
  {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  },
);
await fs.writeFile(path.join(output, "electron.log"), `${run.stdout ?? ""}\n${run.stderr ?? ""}`);
if (run.error) throw run.error;
if (run.status !== 0)
  throw new Error(`Headless capture check failed (${run.status}): ${run.stderr}\n${run.stdout}`);
console.log(await fs.readFile(path.join(output, "receipt.json"), "utf8"));

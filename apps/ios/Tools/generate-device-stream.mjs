// Bundles the shared device stream transport the Expo app embeds
// (apps/mobile/src/features/devices/device-stream.browser.ts) into one IIFE
// that defines `StudioDeviceStream`, and writes it to App/Generated/device-stream.js
// for the device viewer's WKWebView. Same build as apps/mobile/scripts/generate-device-stream.mts.
//
// usage: node Tools/generate-device-stream.mjs   (from apps/ios; Node 22 and the repo's pnpm install)
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const iosRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(iosRoot, "../..");
const entry = path.join(repoRoot, "apps/mobile/src/features/devices/device-stream.browser.ts");
const destination = path.join(iosRoot, "App/Generated/device-stream.js");

function fail(message) {
  console.error(`generate-device-stream: ${message}`);
  process.exit(1);
}

let build;
try {
  ({ build } = await import(
    pathToFileURL(path.join(repoRoot, "node_modules/vite-plus/dist/index.js")).href
  ));
} catch {
  fail(`vite-plus is not installed. Run \`pnpm install\` in ${repoRoot} (Node 22, pnpm 11) first.`);
}

const result = await build({
  configFile: false,
  root: repoRoot,
  logLevel: "silent",
  build: {
    write: false,
    target: "es2022",
    minify: true,
    lib: { entry, name: "StudioDeviceStream", formats: ["iife"] },
  },
}).catch((error) => fail(`bundling ${path.relative(repoRoot, entry)} failed: ${error.message}`));

const chunk = (Array.isArray(result) ? result : [result])
  .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
  .find((output) => output.type === "chunk");
if (!chunk) fail("the build did not emit a script.");

const contents = `${chunk.code.trimEnd()}\n`;
const previous = await fs.readFile(destination, "utf8").catch(() => null);
if (previous !== contents) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents);
}
console.error(
  `generate-device-stream: ${path.relative(iosRoot, destination)} (${contents.length} bytes)`,
);

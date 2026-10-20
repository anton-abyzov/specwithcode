#!/usr/bin/env node
// Bundles scripts/studio-provision/entry.ts into one ESM file that needs only Node.js 22,
// for provisioning tests on clean machines:
//   node scripts/studio-provision/bundle.mjs [out.mjs]
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

// rolldown comes with vite-plus; resolve it from there instead of adding a dependency.
const fromVitePlus = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("vite-plus/package.json"),
);
const { build } = await import(NodeURL.pathToFileURL(fromVitePlus.resolve("rolldown")).href);

const out =
  process.argv[2] ?? NodeURL.fileURLToPath(new URL("./dist/provision.mjs", import.meta.url));
await build({
  input: NodeURL.fileURLToPath(new URL("./entry.ts", import.meta.url)),
  platform: "node",
  logLevel: "warn",
  output: {
    file: out,
    format: "esm",
    codeSplitting: false,
    banner:
      "import { createRequire as __provisionRequire } from 'node:module'; const require = __provisionRequire(import.meta.url);",
  },
});
console.log(out);

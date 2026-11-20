import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const src = NodeURL.fileURLToPath(new URL("../../src", import.meta.url));

// The queue reads live thread state; the fixture swaps those modules for
// fictional data so the real queue and question components render alone.
const stubs: Record<string, string> = {
  [NodePath.join(src, "state/entities.ts")]: "stubs/entities.ts",
  [NodePath.join(src, "state/threads.ts")]: "stubs/threads.ts",
  [NodePath.join(src, "state/use-atom-command.ts")]: "stubs/use-atom-command.ts",
  [NodePath.join(src, "assets/assetUrls.ts")]: "stubs/assetUrls.ts",
};

function stubThreadState(): Plugin {
  return {
    name: "compact-stack-stubs",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source.includes("client-runtime/state/thread-workflows")) {
        return NodePath.join(here, "stubs/thread-workflows.ts");
      }
      if (!importer || importer.includes("/tests/compact-stack/")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const stub = resolved ? stubs[resolved.id.split("?")[0]!] : undefined;
      return stub ? NodePath.join(here, stub) : null;
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [stubThreadState(), react(), tailwindcss()],
  resolve: { alias: { "~": src } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/compact-stack/site",
    emptyOutDir: true,
  },
});

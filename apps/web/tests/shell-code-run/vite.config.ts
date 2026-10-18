import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const fixture = fileURLToPath(new URL(".", import.meta.url));
const appSource = resolve(fixture, "../../src");
const stubs = resolve(fixture, "stubs.ts");

// Renders the real chat Markdown and inline Run UI. Only the terminal, scope and
// machine lookups that InlineShellRun reads are replaced by an in-memory terminal,
// so no server, store or shell is involved.
function stubInlineShellRunState(): Plugin {
  return {
    name: "stub-inline-shell-run-state",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer?.endsWith("/components/chat/InlineShellRun.tsx")) return null;
      return /^\.\.\/\.\.\/state\/(?:session|environments|terminal|terminalSessions|use-atom-command)$/.test(
        source,
      )
        ? stubs
        : null;
    },
  };
}

export default defineConfig({
  root: fixture,
  plugins: [stubInlineShellRunState(), react(), tailwindcss()],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/shell-code-run/site",
    emptyOutDir: true,
  },
});

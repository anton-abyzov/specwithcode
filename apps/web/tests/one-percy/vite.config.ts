import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const { fileURLToPath } = NodeURL;

// The real StudioSidebar, Percy switch and confirmation, Threads pane and
// offline line; only stores, routing, settings and RPC hooks are simulated.
const MOCKED =
  /\/(state\/(entities|environments|projects|server|session|threads|use-atom-command|use-orchestration-command)|hooks\/(useSettings|useScratchProject|useThreadActions)|lib\/chatThreadActions|threadRoutes|settings\/useSettingsProjectGroups|sidebar\/(SidebarPlanProgress|SidebarChrome)|shell\/ModelBadge|ThreadMoveDialog|studio\/(personalShareCommands|machineChecking|useThreadIncrementProgress))$/;
const mocks = fileURLToPath(new URL("./mocks.tsx", import.meta.url));
const attention = fileURLToPath(new URL("./attention.ts", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-one-percy-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer || importer === mocks || !importer.includes("/apps/web/")) return null;
        if (importer !== attention && /\/studio\/useProjectAttention$/.test(id)) return attention;
        if (id === "@effect/atom-react" || id === "@tanstack/react-router") return mocks;
        if ((id.startsWith(".") || id.startsWith("~/")) && MOCKED.test(id)) return mocks;
        return null;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    // Readable stacks in the receipt when a view throws.
    minify: false,
    outDir: "../../../../.artifacts/one-percy/site",
    emptyOutDir: true,
    // Code the views import but never run here may name a hook the mocks lack:
    // it resolves to undefined instead of failing the build. Mock what renders.
    rollupOptions: { shimMissingExports: true, output: { inlineDynamicImports: true } },
  },
});

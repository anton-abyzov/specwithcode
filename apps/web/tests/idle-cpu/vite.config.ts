import { defineConfig } from "vite-plus";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const { fileURLToPath } = NodeURL;

// The real client store (shell reducer, thread atoms, entity hooks), sidebar and thread
// route; only the connection, settings and routing boundaries are simulated.
const MOCKED =
  /\/apps\/web\/src\/(state\/(environments|projects|server|session|shell|threads|use-atom-command|use-orchestration-command)|hooks\/(useSettings|useScratchProject|useThreadActions)|lib\/chatThreadActions|studio\/(fleet|projectWorkspace)|lib\/archivedThreadsState|components\/(settings\/useSettingsProjectGroups|sidebar\/SidebarChrome|ProjectFavicon|studio\/shell\/ModelBadge|ThreadMoveDialog|ChatView))\.tsx?$/;
const mocks = fileURLToPath(new URL("./mocks.tsx", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "idle-cpu-fixture",
      enforce: "pre",
      async resolveId(id, importer, options) {
        if (!importer || importer === mocks) return null;
        if (id === "@tanstack/react-router") return mocks;
        if (!id.startsWith(".") && !id.startsWith("~")) return null;
        const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
        return resolved && MOCKED.test(resolved.id) ? mocks : null;
      },
    },
    react(),
    // The production build compiles components with the React Compiler; so does this one.
    babel({
      // Run from the repository root, so name the folder that holds the compiler.
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
    tailwindcss(),
  ],
  resolve: { alias: { "~": fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/idle-cpu/site",
    emptyOutDir: true,
    // Function names stay readable in the CPU profile.
    minify: false,
  },
});

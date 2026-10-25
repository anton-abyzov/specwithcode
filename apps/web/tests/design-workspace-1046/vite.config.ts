import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const { fileURLToPath } = NodeURL;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The real design system page, Files layer, Assets, menus, dialogs, project
// board and More menu. Only data, connection, permission and capability
// modules are simulated: each one below is swapped for a shim that re-exports
// the real module and overrides the named hooks from mocks.tsx.
const mocks = here("./mocks.tsx");
const src = here("../../src/");
const MOCKED: Record<string, { readonly names: readonly string[]; readonly star: boolean }> = {
  [`${src}state/query.ts`]: { names: ["useEnvironmentQuery"], star: true },
  [`${src}state/use-atom-command.ts`]: { names: ["useAtomCommand"], star: true },
  [`${src}state/session.ts`]: {
    names: ["useEnvironmentScope", "readEnvironmentScope", "usePreparedConnection"],
    star: true,
  },
  [`${src}state/server.ts`]: { names: ["serverEnvironment"], star: true },
  [`${src}state/entities.ts`]: {
    names: ["useServerConfigs", "useProjects", "useThreadShells"],
    star: true,
  },
  [`${src}state/environments.ts`]: { names: ["usePrimaryEnvironmentId"], star: true },
  [`${src}state/assets.ts`]: { names: ["projectFaviconUrlAtom"], star: true },
  [`${src}state/presentation.ts`]: { names: ["useEnvironmentPresentation"], star: true },
  [`${src}studio/design.ts`]: { names: ["design"], star: false },
  [`${src}studio/designSystemImport.ts`]: { names: ["designSystemImport"], star: false },
  [`${src}hooks/useScratchProject.ts`]: { names: ["useScratchProject"], star: false },
  [`${src}env.ts`]: { names: ["isElectron"], star: true },
  [here("../../../../packages/client-runtime/src/state/runtime.ts")]: {
    names: ["executeAtomQuery"],
    star: true,
  },
};
const CANDIDATE =
  /(query|use-atom-command|session|entities|environments|assets|presentation|server|design|designSystemImport|useScratchProject|env|runtime)(\.tsx?)?$/;
const PREFIX = "\0design-workspace-1046:";

function fixtureMocks(): Plugin {
  return {
    name: "design-workspace-1046-mocks",
    enforce: "pre",
    async resolveId(id, importer, options) {
      if (id.startsWith(PREFIX)) return id;
      if (!importer || importer === mocks || importer.startsWith("\0")) return null;
      if (!importer.includes("/apps/web/") || !CANDIDATE.test(id)) return null;
      const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
      const file = resolved?.id.split("?")[0];
      return file !== undefined && MOCKED[file] ? `${PREFIX}${file}` : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const file = id.slice(PREFIX.length);
      const spec = MOCKED[file]!;
      return [
        spec.star ? `export * from ${JSON.stringify(file)};` : "",
        `export { ${spec.names.join(", ")} } from ${JSON.stringify(mocks)};`,
      ].join("\n");
    },
  };
}

export default defineConfig({
  root: here("."),
  plugins: [fixtureMocks(), react(), tailwindcss()],
  resolve: { alias: { "~": here("../../src") } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/design-workspace-1046/site",
    emptyOutDir: true,
  },
});

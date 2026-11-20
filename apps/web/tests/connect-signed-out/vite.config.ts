import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const here = (path: string) => NodeURL.fileURLToPath(new URL(path, import.meta.url));
const stubs = here("./stubs.tsx");
const progress = here("../thread-row-meta/incrementProgress.ts");
const configs = here("../thread-row-meta/serverConfigs.ts");

// The production Threads pane and signed-out banner. Only what the window would
// read from Clerk, the catalog and its host is answered by the fixture.
const isolate: Plugin = {
  name: "connect-signed-out-isolate",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer) return null;
    if (importer.endsWith("ConnectSignedOutBanner.tsx")) {
      if (
        source === "@clerk/react" ||
        source.endsWith("/useStudioConnectAuthPrompt") ||
        source.endsWith("/useConnectRenew") ||
        source.endsWith("/cloud/ConnectSessionGuard") ||
        source.endsWith("/state/environments") ||
        source.endsWith("/studio/machineNickname")
      )
        return stubs;
    }
    if (importer.endsWith("useConnectSessionEnd.ts") && source === "@clerk/react") return stubs;
    if (importer.endsWith("SignedOutBanner.tsx") && source.endsWith("/cloud/publicConfig"))
      return stubs;
    if (
      (importer.endsWith("ThreadsPane.tsx") || importer.endsWith("SidebarPlanProgress.tsx")) &&
      /useThreadIncrementProgress$/.test(source)
    )
      return progress;
    if (importer.endsWith("ModelBadge.tsx") && /state\/entities$/.test(source)) return configs;
    return null;
  },
};

export default defineConfig({
  root: here("."),
  plugins: [isolate, react(), tailwindcss()],
  resolve: { alias: { "~": here("../../src") } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/connect-signed-out/site",
    emptyOutDir: true,
  },
});

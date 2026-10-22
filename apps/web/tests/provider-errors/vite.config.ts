import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const source = NodeURL.fileURLToPath(new URL("../../src/", import.meta.url));
const virtualPrefix = "\0provider-error-fixture:";

// Keep the production banner, timeline, alerts and buttons. Their settings,
// thread lookup and file/PR actions are synthetic and never reach a host.
const mocks: Record<string, string> = {
  settings: `
    export * from ${JSON.stringify(`${source}hooks/useSettings.ts`)};
    import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
    const settings = { ...DEFAULT_SERVER_SETTINGS, ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "24-hour", timelineDetail: "verbose" };
    export const useClientSettings = (select) => select ? select(settings) : settings;
    export const usePrimarySettings = useClientSettings;
    export const useServerSettings = (_environment, select) => select ? select(settings) : settings;
  `,
  entities: `
    export * from ${JSON.stringify(`${source}state/entities.ts`)};
    export const useThreadShell = () => null;
    export const useThreadLinkTargets = () => [];
    export const useProject = () => null;
  `,
  files: `
    export * from ${JSON.stringify(`${source}fileContextMenu.ts`)};
    export const useFileContextMenuHandler = () => () => {};
  `,
  pullRequests: `
    export * from ${JSON.stringify(`${source}lib/openPullRequestLink.ts`)};
    export const useOpenPrLink = () => () => {};
  `,
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-provider-error-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (/(?:^|\/)hooks\/useSettings$/.test(id)) return `${virtualPrefix}settings`;
        if (!importer?.endsWith("MessagesTimeline.tsx")) return;
        if (/(?:^|\/)state\/entities$/.test(id)) return `${virtualPrefix}entities`;
        if (/(?:^|\/)fileContextMenu$/.test(id)) return `${virtualPrefix}files`;
        if (/(?:^|\/)lib\/openPullRequestLink$/.test(id)) return `${virtualPrefix}pullRequests`;
      },
      load(id) {
        if (id.startsWith(virtualPrefix)) return mocks[id.slice(virtualPrefix.length)];
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": source } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/provider-errors/site",
    emptyOutDir: true,
  },
});

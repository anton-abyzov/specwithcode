import { defineConfig, type Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const settings = NodeURL.fileURLToPath(new URL("./stubs/settings.tsx", import.meta.url));
// The real TimelineDetailMenu; only the settings it reads are answered by the fixture.
const STUBBED = [
  /settings\/useSettingsProjectGroups$/,
  /settings\/SettingsScopeContext$/,
  /settings\/useScopedSettings$/,
  /hooks\/useSettings$/,
  /state\/server$/,
  /^@effect\/atom-react$/,
];

const stubs: Plugin = {
  name: "reply-chip-stubs",
  enforce: "pre",
  resolveId(source, importer) {
    if (!importer?.match(/(TimelineDetailMenu|timelineDetail)\.tsx?$/)) return null;
    return STUBBED.some((pattern) => pattern.test(source)) ? settings : null;
  },
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [stubs, react(), tailwindcss()],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: process.env.REPLY_CHIP_OUT ?? "../../../../.artifacts/reply-chip/site",
    emptyOutDir: true,
  },
});

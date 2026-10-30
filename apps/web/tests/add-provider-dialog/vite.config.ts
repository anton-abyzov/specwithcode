import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mock = (name: string) =>
  NodeURL.fileURLToPath(new URL(`./mocks/${name}.ts`, import.meta.url));
const MOCKED: Record<string, string> = {
  "../../state/server": mock("server"),
  "../../state/query": mock("query"),
  "../../state/use-atom-command": mock("use-atom-command"),
  "../../state/session": mock("session"),
  "../../hooks/useSettings": mock("useSettings"),
};

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "add-provider-fixture-state",
      enforce: "pre",
      transform(code, id) {
        if (!id.includes("/components/settings/") || id.includes("node_modules")) return;
        let next = code;
        for (const [specifier, file] of Object.entries(MOCKED)) {
          next = next.replaceAll(`from "${specifier}"`, `from "${file}"`);
        }
        return next;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: { outDir: "../../../../.artifacts/add-provider-dialog/site", emptyOutDir: true },
});

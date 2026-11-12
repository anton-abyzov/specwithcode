import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const MOCKED =
  /^@tanstack\/react-router$|^@effect\/atom-react$|\/(state\/(desktopNetworkAccess|entities|environments|session)|studio\/(fleet|machineNickname)|environments\/primary|confirmDialog|connection\/desktopLocal|lib\/machineStatus|studio\/shell\/HostLimits|usePrimaryFleet|MachineWorkGrants|HandoffModeSettings|RenameMachineDialog)$/;

// A machine's update card and its pause row, rendered from their views with no
// server behind them.
const UPDATE_CARD = /(ManagedUpdatesSection|UpdatePausePolicyRow)\.tsx$/;
const UPDATE_CARD_MOCKED =
  /^@effect\/atom-react$|\/(state\/(managedUpdates|query|session|server|use-atom-command)|studio\/machineNickname|confirmDialog|ServerUpdateAction|ui\/toast)$/;

export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-machines-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer?.endsWith("MachinesSettings.tsx") && MOCKED.test(id))
          return NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
        if (UPDATE_CARD.test(importer ?? "") && UPDATE_CARD_MOCKED.test(id))
          return NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/machines-page/site",
    emptyOutDir: true,
  },
});

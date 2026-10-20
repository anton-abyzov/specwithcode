import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// Only the menu and rename dialog see the mocks; the draft store and UI kit are real.
const owners = /(DraftMachinePicker|RenameMachineDialog)\.tsx$/;
const mocked =
  /(\/hooks\/useProjectCoordinatorHandoff|\/studio\/machineNickname|\/studio\/useRenameMachine|\/AddToMachineDialog|\/studio\/ProjectLinkDialog|\/connection\/catalog|\/connection\/desktopLocal|\/state\/use-atom-command|\/state\/environments|\/state\/entities|\/state\/session|\/hooks\/useSettings|\/logicalProject|\/hooks\/useScratchProject|\/lib\/machineLastSeen|^@tanstack\/react-router)$/;
// The add dialog, consolidation step and copy helpers are real; only their RPCs and stores are not.
const dialogOwners = /(AddToMachineDialog|AddToMachineConsolidate)\.tsx$|addToMachineCopy\.ts$/;
const dialogMocked =
  /(\/state\/(entities|environments|sourceControl|use-atom-command)|\/(machineNickname|machineHandoff|projectLink|ProjectLinkDialog)|^@specweave-studio\/client-runtime\/state\/runtime)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-run-on-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (importer && owners.test(importer) && mocked.test(id)) return mocks;
        if (importer && dialogOwners.test(importer) && dialogMocked.test(id)) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/run-on-machines/site",
    emptyOutDir: true,
  },
});

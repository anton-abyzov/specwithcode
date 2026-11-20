import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";

const mocks = NodeURL.fileURLToPath(new URL("./mocks.tsx", import.meta.url));
// The status row, its install step, the command box, the status wording, the team
// rules view, the registry install block and the settings layout are real. Machine
// state, RPCs, the setup terminal and routing are simulated.
const owners =
  /\/(settings\/(ProviderStatusRow|AcpRegistryRepair|settingsLayout)\.tsx|teamRules\/useTeamRules\.ts)$/;
const mocked =
  /(^@effect\/atom-react|\/state\/server|\/state\/session|\/state\/environments|\/state\/use-atom-command|\/onboarding\/AgentSetupPanel|\/onboarding\/WizardFrame|\/ClaudeSignIn|\/FoundAgents|\/FeaturedAcpProviders|\/hooks\/useSettings|\/useScopedSettings|\/SettingsScopeContext|\/SettingInheritance|\/SettingsScopeSentence|\/scopedSettings|\/projectListVisibility|\/WorkspacePageContainer)$/;
export default defineConfig({
  root: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    {
      name: "isolated-provider-install-step-fixture",
      enforce: "pre",
      resolveId(id, importer) {
        if (!importer || importer === mocks) return;
        // No router runs here, so every link and navigation is a stand-in.
        if (id === "@tanstack/react-router" || (owners.test(importer) && mocked.test(id)))
          return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": NodeURL.fileURLToPath(new URL("../../src", import.meta.url)) } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/provider-install-step/site",
    emptyOutDir: true,
  },
});

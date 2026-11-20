import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
// The real setup steps draw. Of each module below, the names listed come from
// mocks.tsx and everything else from the module itself: what setup would ask a
// server, the desktop shell or the sign-in service for reads a stand-in.
const overrides: Record<string, readonly string[]> = {
  env: ["isElectron"],
  "cloud/publicConfig": ["hasCloudPublicConfig"],
  "cloud/useCloudLinkController": ["useCloudLinkController"],
  "components/clerk/useStudioConnectAuthPrompt": ["useStudioConnectAuthPrompt"],
  "components/onboarding/FirstRunUpdateNotice": ["FirstRunUpdateNotice"],
  "components/github/StarOnGitHub": ["StarOnGitHubLink"],
  "components/settings/AccountJoinCard": ["AccountJoinCard"],
  "components/settings/ChatGptWelcomeCoordinator": ["ChatGptWelcomeCoordinator"],
  "components/settings/CodexSetupSection": ["CodexSetupSection", "AddManagedCodexAccountDialog"],
  "components/settings/FoundAgents": [
    "agentName",
    "defaultAgentInstance",
    "foundAgentsView",
    "useAgentSearch",
  ],
  "components/onboarding/AgentRows": [
    "FoundAgentRow",
    "ProviderAgentRow",
    "GitRow",
    "InstallAgentRow",
  ],
  "components/onboarding/MachineBasics": ["MachineBasics"],
  "components/onboarding/ProjectsFolderChoice": ["ProjectsFolderChoice"],
  "components/access/FullDiskAccess": ["FullDiskAccessRow", "FirstRunFullDiskAccess"],
  "components/cloud/CloudEnvironmentConnectList": ["CloudEnvironmentConnectRows"],
  "components/ThreadTerminalDrawer": ["TerminalViewport"],
  "connection/onboarding": ["connectPairing"],
  "hooks/useProjectFolderChoice": ["rememberRecentFolder"],
  "onboarding/accessRecommendation": ["useFullAccessRecommendation"],
  "onboarding/firstRun": ["useCompleteOnboarding"],
  "onboarding/useProjectScans": ["useProjectScans"],
  "state/agentSessions": ["agentSessionImport"],
  "state/entities": ["useProjects", "readProjects"],
  "state/environments": [
    "useEnvironments",
    "usePrimaryEnvironment",
    "useRelayEnvironmentDiscovery",
  ],
  "state/projects": ["projectEnvironment"],
  "state/server": ["serverEnvironment"],
  "state/session": [
    "environmentSession",
    "useEnvironmentScope",
    "useEnvironmentsWithScope",
    "readEnvironmentScope",
  ],
  "state/terminal": ["terminalEnvironment"],
  "state/use-atom-command": ["useAtomCommand"],
  "studio/fleet": ["useMachineWorkGrants"],
  "teamRules/useTeamRules": ["useTeamRules"],
};
const stubbed = new Map(
  Object.entries(overrides).map(([path, names]) => [NodePath.resolve(appSource, path), names]),
);
const bare: Record<string, readonly string[]> = { "@clerk/react": ["useAuth", "useUser"] };
const STUB = "\0first-run-walk:";
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-first-run-walk",
      enforce: "pre",
      async resolveId(source, importer) {
        // The stand-in's own imports reach the real module and the mocks.
        if (!importer || importer === mocks || importer.startsWith(STUB)) return;
        if (source in bare) return `${STUB}${source}`;
        const target = source.startsWith("~/")
          ? NodePath.resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? NodePath.resolve(NodePath.dirname(importer), source)
            : source;
        const key = target.replace(/\.(tsx?|jsx?)$/, "");
        if (!stubbed.has(key)) return;
        const real = await this.resolve(source, importer, { skipSelf: true });
        if (real) return `${STUB}${real.id}`;
      },
      load(id) {
        if (!id.startsWith(STUB)) return;
        const real = id.slice(STUB.length);
        const names = bare[real] ?? stubbed.get(real.replace(/\.(tsx?|jsx?)$/, "")) ?? [];
        return [
          `export * from ${JSON.stringify(real)};`,
          `export { ${names.join(", ")} } from ${JSON.stringify(mocks)};`,
        ].join("\n");
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/first-run-walk/site",
    emptyOutDir: true,
  },
});

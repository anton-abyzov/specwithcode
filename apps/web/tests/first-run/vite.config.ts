import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fixture = NodeURL.fileURLToPath(new URL(".", import.meta.url));
const appSource = NodePath.resolve(fixture, "../../src");
const mocks = NodePath.resolve(fixture, "mocks.tsx");
const stubs = new Set(
  [
    "state/environments",
    "state/session",
    "state/use-atom-command",
    "state/agentSessions",
    "state/entities",
    "state/projects",
    "state/filesystem",
    "state/query",
    "studio/machineNickname",
    "cloud/publicConfig",
    "cloud/useCloudLinkController",
    "studio/fleet",
    "teamRules/useTeamRules",
    "components/settings/AccountJoinCard",
    "connection/onboarding",
    "onboarding/useProjectScans",
    "onboarding/targetEnvironment.logic",
    "components/clerk/useStudioConnectAuthPrompt",
    "components/cloud/CloudEnvironmentConnectList",
    "components/onboarding/FirstRunUpdateNotice",
    "components/github/StarOnGitHub",
    "env",
  ].map((path) => NodePath.resolve(appSource, path)),
);
export default defineConfig({
  root: fixture,
  plugins: [
    {
      name: "isolated-first-run",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "@clerk/react") return mocks;
        if (!importer || importer === mocks) return;
        // The sign-in step reads one session atom; the stand-in hands it the value itself.
        if (source === "@effect/atom-react" && importer.endsWith("SignInFirstStep.tsx"))
          return mocks;
        const target = source.startsWith("~/")
          ? NodePath.resolve(appSource, source.slice(2))
          : source.startsWith(".")
            ? NodePath.resolve(NodePath.dirname(importer), source)
            : source;
        if (stubs.has(target.replace(/\.(tsx?|jsx?)$/, ""))) return mocks;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": appSource } },
  build: {
    target: "esnext",
    outDir: "../../../../.artifacts/first-run/site",
    emptyOutDir: true,
  },
});

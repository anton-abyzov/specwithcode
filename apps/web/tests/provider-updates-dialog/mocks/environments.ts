// Fixture-only stand-in: two machines, one ready Codex and one offline Claude.
const codex = (version: string, latest: string, command: string) => ({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version,
  versionAdvisory: {
    status: "behind_latest",
    canUpdate: true,
    updateCommand: command,
    latestVersion: latest,
  },
});
const ENVIRONMENTS = [
  {
    environmentId: "ministorm",
    label: "ministorm",
    connection: { phase: "connected" },
    serverConfig: {
      providers: [
        codex(
          "0.164.0",
          "0.166.0",
          "npm install -g --prefix /home/anton/.local/share/fnm/node-versions/v24.22.0/installation --allow-scripts=@openai/codex @openai/codex@latest",
        ),
      ],
    },
  },
  {
    environmentId: "m3",
    label: "M3 MacBook",
    connection: { phase: "disconnected" },
    serverConfig: { providers: [codex("0.165.0", "0.166.0", "owning npm (staged)")] },
  },
  {
    environmentId: "m1",
    label: "M1 mini",
    connection: { phase: "connected" },
    serverConfig: { providers: [] },
  },
];
export const useEnvironments = () => ({ environments: ENVIRONMENTS });

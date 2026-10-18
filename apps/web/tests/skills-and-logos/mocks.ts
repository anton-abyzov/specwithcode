import type { ProjectSkillsSnapshot } from "@specweave-studio/contracts";

const presence = (driver: string, label: string, enabled = true) => ({
  instanceId: driver,
  driver,
  label,
  path: `/Users/developer/.agents/skills/${label.toLowerCase()}/SKILL.md`,
  scope: "user",
  enabled,
});
const row = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `Fixture skill ${name}`,
  status: "ok",
  attention: false,
  issues: [],
  path: `/Users/developer/.agents/skills/${name}/SKILL.md`,
  scopes: ["user"],
  providers: [presence("claudeAgent", "Claude")],
  lock: null,
  drift: "unlocked",
  copies: 1,
  divergent: false,
  doctor: [],
  ...extra,
});
const lock = (source: string, tier: string | null) => ({
  lockPath: "/Users/developer/.agents/vskill.lock",
  lockScope: "user",
  version: "1.0.0",
  tier,
  source,
  sha: "abc",
  installedAt: "2026-10-01T00:00:00.000Z",
});

export const snapshot = {
  cwd: "/Users/developer/scratch",
  checkedAt: "2026-10-17T12:00:00.000Z",
  rows: [
    row("a11y-debugging", { providers: [presence("grok", "Grok")], scopes: ["plugin"] }),
    row("apify-data-gathering", {
      status: "ok",
      attention: true,
      doctor: ['name "marketing/apify-data-gathering" must be lowercase letters'],
      lock: lock("github:anton-abyzov/vskill", "VERIFIED"),
      drift: "match",
    }),
    row("frontend:build", {
      providers: [presence("codex", "Codex"), presence("claudeAgent", "Claude")],
      lock: lock("marketplace:anton-abyzov/vskill#frontend", "VERIFIED"),
      drift: "match",
    }),
    row("asc-apple-ads", {
      providers: [
        presence("claudeAgent", "Claude"),
        presence("codex", "Codex"),
        presence("grok", "Grok"),
        { ...presence("acpRegistry", "Copilot"), instanceId: "copilot" },
        { ...presence("acpRegistry", "Gemini", false), instanceId: "gemini" },
        presence("cursor", "Cursor"),
        presence("opencode", "OpenCode"),
      ],
    }),
    row("excalidraw-skill", {
      providers: [presence("codex", "Codex")],
      lock: lock("github:yctimlin/mcp_excalidraw", null),
      drift: "match",
    }),
  ],
  providers: [
    { instanceId: "claudeAgent", driver: "claudeAgent", label: "Claude", state: "ok", skills: 4 },
    { instanceId: "codex", driver: "codex", label: "Codex", state: "ok", skills: 3 },
    { instanceId: "grok", driver: "grok", label: "Grok", state: "ok", skills: 2 },
  ],
  locks: [{ path: "/Users/developer/.agents/vskill.lock", scope: "user", skills: 3 }],
  doctor: "ok",
} as unknown as ProjectSkillsSnapshot;

export const projectWorkspace = { skills: (input: unknown) => input };
export function useEnvironmentQuery(_query: unknown) {
  return { data: snapshot, error: null, isPending: false, refresh: () => undefined };
}

// Registry identity the real catalog carries for ACP instances.
const entries = new Map<string, Record<string, unknown>>([
  ["copilot", { driverKind: "acpRegistry", acpRegistryAgentId: "github-copilot-cli" }],
  [
    "gemini",
    {
      driverKind: "acpRegistry",
      acpRegistryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/gemini.svg",
    },
  ],
]);
export function useProviderEntries(_environmentId: string) {
  return entries;
}

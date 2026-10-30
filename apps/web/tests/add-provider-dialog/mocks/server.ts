// Fixture-only overrides; everything else comes from the real module.
export * from "../../../src/state/server";
// Fixture-only stand-ins for the dialog's environment state and commands.
const REGISTRY = [
  ["agoragentic-acp", "Agoragentic"],
  ["amp-acp", "Amp"],
  ["antigravity-acp", "Google Antigravity"],
  ["auggie", "Auggie CLI"],
  ["claude-acp", "Claude Agent"],
  ["cline", "Cline"],
  ["codex-acp", "Codex"],
  ["cursor", "Cursor"],
  ["devin", "Devin"],
  ["factory-droid", "Factory Droid"],
  ["gemini", "Gemini CLI"],
  ["github-copilot-cli", "Copilot"],
  ["goose", "goose"],
  ["grok-build", "Grok Build"],
  ["junie", "Junie"],
  ["kimi", "Kimi CLI"],
  ["opencode", "OpenCode"],
  ["opencode-v2", "OpenCode V2"],
  ["pi-acp", "pi ACP"],
  ["qwen-code", "Qwen Code"],
].map(([id, name]) => ({
  id,
  name,
  version: "1.0.0",
  description: `${name} coding agent (fixture metadata)`,
  authors: [],
  license: null,
  website: null,
  repository: null,
  icon: null,
  distribution: "npx",
  integrity: "registry",
}));

export const serverEnvironment = {
  searchAcpRegistry: (descriptor: { input: { query: string } }) => descriptor,
  prepareAcpRegistryAgent: "prepare",
};
export { REGISTRY };

import type { TeamRulesFile } from "@specweave-studio/contracts";

/**
 * What the provider CLIs read when they run outside the app. Pure: it prints
 * what to deploy and names what they cannot express, so nothing is dropped
 * without a word. Field names follow each provider's managed configuration docs.
 */
export interface TeamRulesCompanion {
  readonly managedSettings: string;
  readonly requirements: string;
  /** Rules with no equivalent, in words for the person deploying these files. */
  readonly notes: ReadonlyArray<string>;
}

export const COMPANION_PATHS = {
  managedSettings: {
    darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
    linux: "/etc/claude-code/managed-settings.json",
    win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
  },
  requirements: {
    darwin: "/etc/codex/requirements.toml",
    linux: "/etc/codex/requirements.toml",
    win32: "%ProgramData%\\OpenAI\\Codex\\requirements.toml",
  },
} as const;

const CLAUDE_SERVER_NAME = /^[A-Za-z0-9_-]+$/u;
const tomlString = (value: string) => JSON.stringify(value);
const tomlList = (values: ReadonlyArray<string>) => `[${values.map(tomlString).join(", ")}]`;

export function teamRulesCompanion(rules: TeamRulesFile): TeamRulesCompanion {
  const notes: Array<string> = [];
  const ceiling = rules.agents?.ceiling;
  const limited = ceiling !== undefined && ceiling !== "full-access";

  const permissions = {
    ...(limited ? { disableBypassPermissionsMode: "disable" } : {}),
    ...(ceiling === "approval-required" || ceiling === "auto-accept-edits"
      ? { disableAutoMode: "disable" }
      : {}),
  };
  if (ceiling === "approval-required") {
    notes.push(
      "Claude Code has no setting that forbids accepting edits, so outside the app its limit is one step above Supervised.",
    );
  }

  const models = rules.ai?.models;
  const exactModels = (models ?? []).filter((model) => !model.includes("*"));
  if (models !== undefined && exactModels.length !== models.length) {
    notes.push(
      "ai.models has patterns. Claude Code's availableModels takes names or aliases, so only exact names were copied; add the patterns' models by hand.",
    );
  }
  if (models !== undefined) {
    notes.push(
      "Codex has no model allowlist in requirements.toml, so ai.models does not limit it outside the app.",
    );
  }

  const allow = rules.connections?.allow;
  const claudeServers = (allow ?? []).filter((name) => CLAUDE_SERVER_NAME.test(name));
  if (allow !== undefined && claudeServers.length !== allow.length) {
    notes.push(
      "connections.allow has names Claude Code cannot match exactly, such as patterns; they were left out of allowedMcpServers.",
    );
  }
  if (allow !== undefined && allow.length > 0) {
    notes.push(
      "A Claude Code serverName entry matches a label the person chooses, so it is not a security control; add serverUrl or serverCommand entries for that.",
      "Codex matches MCP servers by command or URL, which these rules do not hold. Fill in the identity line for each server in requirements.toml.",
    );
  }

  const environment = rules.ai?.pin?.claudeAgent?.environment;
  const managedSettings = {
    ...(Object.keys(permissions).length === 0 ? {} : { permissions }),
    ...(models === undefined ? {} : { availableModels: exactModels }),
    ...(allow === undefined
      ? {}
      : { allowedMcpServers: claudeServers.map((serverName) => ({ serverName })) }),
    ...(environment === undefined ? {} : { env: environment }),
  };

  const requirementLines = [
    ...(limited
      ? [
          // Supervised runs as untrusted and read-only in the app, so it allows no more here.
          `allowed_approval_policies = ${tomlList(ceiling === "approval-required" ? ["untrusted"] : ["untrusted", "on-request"])}`,
          `allowed_sandbox_modes = ${tomlList(ceiling === "approval-required" ? ["read-only"] : ["read-only", "workspace-write"])}`,
        ]
      : []),
    ...(allow === undefined
      ? []
      : allow.length === 0
        ? ["", "[mcp_servers]"]
        : allow.flatMap((name) => [
            "",
            `# Allowed by Team rules. Replace this with the server's command or URL.`,
            `# [mcp_servers.${tomlString(name)}]`,
            `# identity = { command = "..." }`,
          ])),
  ];

  const unmatched = [
    ...(rules.ai?.providers === undefined
      ? []
      : [
          "ai.providers: neither CLI can refuse to be itself. Remove the CLIs that are not listed.",
        ]),
    ...(Object.keys(rules.ai?.pin ?? {}).some((driver) => driver !== "claudeAgent") ||
    rules.ai?.pin?.claudeAgent?.binaryPath !== undefined ||
    rules.ai?.pin?.claudeAgent?.launchArgs !== undefined
      ? ["ai.pin: only claudeAgent's environment has an equivalent here."]
      : []),
    ...(rules.agents?.routines === undefined
      ? []
      : ["agents.routines: routines exist only in the app."]),
    ...(rules.reach === undefined
      ? []
      : ["reach: phones, Connect, machines and webhooks exist only in the app."]),
    ...(rules.tools === undefined ? [] : ["tools: these switches apply to the app's own tools."]),
    ...(rules.telemetry === undefined
      ? []
      : ["telemetry: this setting covers the app's OTLP export."]),
    ...(rules.updates === undefined ? [] : ["updates: each CLI updates by its own means."]),
    ...(rules.zones === undefined
      ? []
      : [
          "zones: managed files apply to the whole machine, so a zone's limits are not copied here.",
        ]),
  ];

  return {
    managedSettings: `${JSON.stringify(managedSettings, null, 2)}\n`,
    requirements: requirementLines.length === 0 ? "" : `${requirementLines.join("\n")}\n`,
    notes: [...notes, ...unmatched],
  };
}

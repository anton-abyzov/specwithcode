/**
 * Where the server starts a process that runs an agent or a model, and how
 * each provider adapter reaches one. Paths are relative to apps/server/src.
 *
 * providerSpawnSites.test.ts reads these
 * lists: every spawn site must apply HEADLESS_BROWSER_ENVIRONMENT through one
 * of HEADLESS_ENVIRONMENT_HELPERS, and a new spawn in a provider directory
 * fails the test until it is listed here.
 */

/** Calls that apply HEADLESS_BROWSER_ENVIRONMENT (see RuntimeInstructions.ts). */
export const HEADLESS_ENVIRONMENT_HELPERS = [
  "withHeadlessBrowserEnvironment(",
  "headlessChildProcessEnvironment(",
] as const;

/** Processes that run agent turns, prompts or commands an agent asked for. */
export const PROVIDER_PROCESS_SPAWN_SITES: Readonly<Record<string, string>> = {
  "orchestration-v2/Adapters/ClaudeAdapterV2.ts": "Claude Agent SDK query env for every turn",
  "orchestration-v2/Adapters/CodexAdapterV2.ts": "codex app-server for every Codex session",
  "orchestration-v2/Adapters/PiRpc.ts": "pi --mode rpc for Pi sessions, forks and text generation",
  "provider/acp/AcpSessionRuntime.ts":
    "every ACP agent: registry agents, Copilot, Devin, Grok, Antigravity, their text generation",
  "provider/acp/AcpClientTerminals.ts": "commands ACP agents run through terminal/create",
  "provider/opencodeRuntime.ts": "opencode serve for OpenCode 1 and 2 and their text generation",
  "textGeneration/ClaudeTextGeneration.ts": "claude -p for titles, commit messages and PR text",
  "textGeneration/CodexTextGeneration.ts": "codex exec for titles, commit messages and PR text",
  "cli/triage.ts": "claude or codex launched interactively by the triage command",
};

/**
 * Spawns in provider directories that start no agent turn: version and
 * capability probes, sign-in helpers, installers and process cleanup.
 */
export const NON_AGENT_PROVIDER_SPAWNS: Readonly<Record<string, string>> = {
  "provider/ClaudeProvider.ts": "claude CLI status and version probes",
  "provider/CodexProvider.ts": "codex app-server account and model probe, no turns",
  "provider/CodexInstallation.ts": "codex install and version checks",
  "provider/GrokProvider.ts": "grok CLI version and model probes",
  "provider/Drivers/GrokSkills.ts": "grok inspect --json skill listing",
  "provider/Drivers/MuseDriver.ts": "muse usage --json fallback probe when the Muse host reports no usage",
  "provider/PiProvider.ts": "pi --version probe",
  "provider/providerDiscovery.ts": "startup grok and opencode version and sign-in probes",
  "provider/OpenCodeServerLedger.ts": "stops leftover opencode servers",
  "provider/acp/AcpRegistryAuth.ts": "registry agent terminal sign-in and preflight",
  "provider/acp/AcpRegistrySupport.ts": "registry agent version probes",
  "provider/acp/CopilotStartupModel.ts": "copilot --version and --help probes",
  "provider/antigravityAuthSupport.ts": "Antigravity sign-in browser preflight helper",
  "provider/claudeResetCredits.ts": "reads the Claude CLI keychain item for usage credits",
  "provider/providerMaintenance.ts": "Homebrew provider upgrades",
  "provider/providerMaintenanceRunner.ts": "provider install and update commands",
  "provider/providerSnapshot.ts": "spawnAndCollect runner shared by the probes above",
  "cli/browser.ts": "browser setup: system package installs and lookups",
  "cli/uninstall.ts": "Windows runtime folder removal after the CLI exits",
};

/**
 * How each adapter reaches its process: each file imports the next one, and
 * the last is a spawn site. A null chain means the provider has no local child
 * process whose environment the server sets.
 */
export const PROVIDER_ADAPTER_PROCESS_CHAINS: Readonly<
  Record<string, { readonly chain: ReadonlyArray<string> | null; readonly note: string }>
> = {
  "orchestration-v2/Adapters/AcpAdapterV2.ts": {
    chain: ["provider/acp/AcpSessionRuntime.ts"],
    note: "generic ACP adapter used by registry agents, Copilot and Devin",
  },
  "orchestration-v2/Adapters/AcpRegistryAdapterV2.ts": {
    chain: ["provider/acp/AcpSessionRuntime.ts"],
    note: "ACP registry agents",
  },
  "orchestration-v2/Adapters/AntigravityAdapterV2.ts": {
    chain: ["provider/acp/AntigravityAcpSupport.ts", "provider/acp/AcpSessionRuntime.ts"],
    note: "Antigravity over ACP",
  },
  "orchestration-v2/Adapters/ClaudeAdapterV2.ts": {
    chain: ["orchestration-v2/Adapters/ClaudeAdapterV2.ts"],
    note: "Claude Agent SDK starts Claude Code with the query env",
  },
  "orchestration-v2/Adapters/CodexAdapterV2.ts": {
    chain: ["orchestration-v2/Adapters/CodexAdapterV2.ts"],
    note: "spawns codex app-server itself",
  },
  "orchestration-v2/Adapters/CursorAdapterV2.ts": {
    chain: null,
    note: "the Cursor SDK runs inside the server process and its shell tool inherits the server environment; the SDK has no env option",
  },
  "orchestration-v2/Adapters/GrokAdapterV2.ts": {
    chain: ["provider/acp/GrokAcpSupport.ts", "provider/acp/AcpSessionRuntime.ts"],
    note: "Grok over ACP",
  },
  "orchestration-v2/Adapters/OpenCodeAdapterV2.ts": {
    chain: ["provider/opencodeRuntime.ts"],
    note: "connectToOpenCodeServer starts opencode serve unless a server URL is configured",
  },
  "orchestration-v2/Adapters/OpenCode2AdapterV2.ts": {
    chain: [
      "provider/opencode2/OpenCode2Server.ts",
      "provider/OpenCodeServerOwner.ts",
      "provider/opencodeRuntime.ts",
    ],
    note: "OpenCode 2 server, unless a server URL is configured",
  },
  "orchestration-v2/Adapters/PiAdapterV2.ts": {
    chain: ["orchestration-v2/Adapters/PiRpc.ts"],
    note: "Pi RPC process",
  },
};

/**
 * Where each adapter gives its per-thread process SpecWeave's thread, tool and
 * model variables (see withSpecweaveAgentEnvironment in RuntimeInstructions.ts).
 * `site` must contain `marker`. A null site is a listed exception: the
 * provider has no process of its own per thread.
 */
export const SPECWEAVE_AGENT_ENVIRONMENT_ADAPTERS: Readonly<
  Record<
    string,
    | { readonly site: string; readonly marker: string }
    | { readonly site: null; readonly note: string }
  >
> = {
  "orchestration-v2/Adapters/AcpAdapterV2.ts": {
    site: "orchestration-v2/Adapters/AcpAdapterV2.ts",
    marker: "specweaveAgentEnvironment(",
  },
  "orchestration-v2/Adapters/AcpRegistryAdapterV2.ts": {
    site: "orchestration-v2/Adapters/AcpRegistryAdapterV2.ts",
    marker: "...agentEnvironment",
  },
  "orchestration-v2/Adapters/AntigravityAdapterV2.ts": {
    site: "provider/Drivers/AntigravityDriver.ts",
    marker: "...input.agentEnvironment",
  },
  "orchestration-v2/Adapters/ClaudeAdapterV2.ts": {
    site: "orchestration-v2/Adapters/ClaudeAdapterV2.ts",
    marker: "withSpecweaveAgentEnvironment(",
  },
  "orchestration-v2/Adapters/CodexAdapterV2.ts": {
    site: "orchestration-v2/Adapters/CodexAdapterV2.ts",
    marker: "withSpecweaveAgentEnvironment(",
  },
  "orchestration-v2/Adapters/CursorAdapterV2.ts": {
    site: null,
    note: "the Cursor SDK runs inside the server process, which serves every thread",
  },
  "orchestration-v2/Adapters/GrokAdapterV2.ts": {
    site: "orchestration-v2/Adapters/GrokAdapterV2.ts",
    marker: "...input.agentEnvironment",
  },
  "orchestration-v2/Adapters/OpenCodeAdapterV2.ts": {
    site: "orchestration-v2/Adapters/OpenCodeAdapterV2.ts",
    marker: "withSpecweaveAgentEnvironment(",
  },
  "orchestration-v2/Adapters/OpenCode2AdapterV2.ts": {
    site: null,
    note: "one OpenCode 2 server per provider instance serves every thread",
  },
  "orchestration-v2/Adapters/PiAdapterV2.ts": {
    site: "orchestration-v2/Adapters/PiAdapterV2.ts",
    marker: "withSpecweaveAgentEnvironment(",
  },
  // Muse builds its ACP adapter in the driver rather than an *AdapterV2.ts file.
  "provider/Drivers/MuseDriver.ts": {
    site: "provider/Drivers/MuseDriver.ts",
    marker: "...runtime.agentEnvironment",
  },
};

/** Directories scanned for spawns that are not classified above. */
export const PROVIDER_SPAWN_SCAN_DIRECTORIES = [
  "cli",
  "orchestration-v2",
  "provider",
  "textGeneration",
];

/** Source that starts a child process or a Claude Agent SDK query. */
export const PROCESS_SPAWN_PATTERN =
  /\bChildProcess\.make\(|\.spawn\(|\bspawnSync\(|\bexecFileSync\(|\bexecSync\(|\bexecFile\(|\bquery\(\{/;

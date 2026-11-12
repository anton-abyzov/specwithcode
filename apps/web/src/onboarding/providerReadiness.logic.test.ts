import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canInstallOnboardingAgent,
  getOnboardingProviderState,
  listOnboardingAgents,
  onboardingAgentUses,
  resolveAgentSignInCommand,
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "./providerReadiness.logic";

const readyCodex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-08-23T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("getOnboardingProviderState", () => {
  it("treats an enabled Codex provider with ready status and unknown authentication as ready", () => {
    expect(getOnboardingProviderState(readyCodex)).toBe("ready");
  });

  it("treats authenticated providers as ready only when their provider status is ready", () => {
    expect(getOnboardingProviderState({ ...readyCodex, auth: { status: "authenticated" } })).toBe(
      "ready",
    );
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "error",
      }),
    ).toBe("attention");
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        auth: { status: "authenticated" },
        status: "warning",
      }),
    ).toBe("attention");
  });

  it("offers sign-in only when the server reports an authentication failure", () => {
    expect(
      getOnboardingProviderState({
        ...readyCodex,
        status: "error",
        auth: { status: "unauthenticated" },
      }),
    ).toBe("signIn");
    expect(getOnboardingProviderState({ ...readyCodex, status: "error" })).toBe("attention");
    expect(getOnboardingProviderState({ ...readyCodex, status: "warning" })).toBe("attention");
  });

  it("does not offer installation or sign-in for disabled providers", () => {
    expect(getOnboardingProviderState({ ...readyCodex, enabled: false, installed: false })).toBe(
      "disabled",
    );
    expect(getOnboardingProviderState({ ...readyCodex, status: "disabled" })).toBe("disabled");
  });

  it("offers installation only when an enabled provider is missing", () => {
    expect(getOnboardingProviderState({ ...readyCodex, installed: false, status: "error" })).toBe(
      "install",
    );
  });

  it("waits for a provider snapshot before offering an action", () => {
    expect(getOnboardingProviderState(undefined)).toBe("checking");
  });
});

describe("resolveOnboardingProviderLoginCommand", () => {
  it("uses the selected Codex account binary", () => {
    const provider = { ...readyCodex, instanceId: ProviderInstanceId.make("codex_work") };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [provider.instanceId]: {
              driver: provider.driver,
              config: { binaryPath: "/opt/codex-work/bin/codex" },
            },
          },
        },
        "linux",
      ),
    ).toBe("/opt/codex-work/bin/codex login");
  });

  it("uses the selected Claude account binary", () => {
    const provider: ServerProvider = {
      ...readyCodex,
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude_work"),
    };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [provider.instanceId]: {
              driver: provider.driver,
              config: { binaryPath: "/opt/claude-work/bin/claude" },
            },
          },
        },
        "linux",
      ),
    ).toBe("/opt/claude-work/bin/claude auth login");
  });

  it("quotes a Codex path with spaces for PowerShell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              binaryPath: "C:\\Program Files\\Codex & Tools\\codex.exe",
            },
          },
        },
        "windows",
      ),
    ).toBe("& 'C:\\Program Files\\Codex & Tools\\codex.exe' login");
  });

  it("quotes a Claude path with shell metacharacters on POSIX", () => {
    const provider: ServerProvider = {
      ...readyCodex,
      driver: ProviderDriverKind.make("claudeAgent"),
      instanceId: ProviderInstanceId.make("claude"),
    };

    expect(
      resolveOnboardingProviderLoginCommand(
        provider,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            claudeAgent: {
              ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
              binaryPath: "/opt/Claude Tools/$current/claude",
            },
          },
        },
        "linux",
      ),
    ).toBe("'/opt/Claude Tools/$current/claude' auth login");
  });

  it.each([
    ["~/my tools/codex", "~/'my tools/codex' login"],
    ["~\\my tools/codex", "~/'my tools/codex' login"],
    ["~/tools/codex's build", `~/'tools/codex'"'"'s build' login`],
    ["~\\tools\\codex's build", `~/'tools\\codex'"'"'s build' login`],
    ["~/tools/codex; echo unsafe", "~/'tools/codex; echo unsafe' login"],
  ])("keeps the home prefix expandable while quoting %s", (binaryPath, expectedCommand) => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              binaryPath,
            },
          },
        },
        "linux",
      ),
    ).toBe(expectedCommand);
  });

  it.each(["darwin", "linux"] as const)("quotes backslashes in a Codex path on %s", (platform) => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              binaryPath: "/opt/codex\\work/codex",
            },
          },
        },
        platform,
      ),
    ).toBe("'/opt/codex\\work/codex' login");
  });

  it("keeps a plain Windows path unquoted", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              binaryPath: "C:\\Tools\\codex.exe",
            },
          },
        },
        "windows",
      ),
    ).toBe("C:\\Tools\\codex.exe login");
  });

  it("uses the default command when an old server reports an unknown shell", () => {
    expect(
      resolveOnboardingProviderLoginCommand(
        readyCodex,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              binaryPath: "/opt/Codex Tools/codex",
            },
          },
        },
        "unknown",
      ),
    ).toBe("codex login");
  });
});

describe("resolveOnboardingProviderInstallCommand", () => {
  it("uses the PowerShell installer on Windows environments", () => {
    expect(resolveOnboardingProviderInstallCommand("codex", "windows")).toBe(
      "irm https://chatgpt.com/codex/install.ps1 | iex",
    );
    expect(resolveOnboardingProviderInstallCommand("claudeAgent", "windows")).toBe(
      "irm https://claude.ai/install.ps1 | iex",
    );
  });

  it.each(["darwin", "linux", "unknown"] as const)("uses the shell installer on %s", (platform) => {
    expect(resolveOnboardingProviderInstallCommand("codex", platform)).toBe(
      "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    );
    expect(resolveOnboardingProviderInstallCommand("claudeAgent", platform)).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
  });
});

const agent = (driver: string, patch: Partial<ServerProvider> = {}): ServerProvider => ({
  ...readyCodex,
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  auth: { status: "authenticated" },
  ...patch,
});

describe("resolveAgentSignInCommand", () => {
  it.each([
    ["cursor", "cursor-agent login"],
    ["grok", "grok login"],
    ["muse", "muse login"],
    ["opencode", "opencode auth login"],
    // Pi has no sign-in command: it signs in from inside.
    ["pi", "pi"],
  ])("gives %s its own sign-in command", (driver, command) => {
    expect(resolveAgentSignInCommand(agent(driver), DEFAULT_SERVER_SETTINGS, "darwin")).toBe(
      command,
    );
  });

  it("runs the command path saved for that entry", () => {
    const grok = agent("grok", { instanceId: ProviderInstanceId.make("grok-work") });
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [grok.instanceId]: { driver: grok.driver, config: { binaryPath: "/opt/x ai/grok" } },
      },
    };
    expect(resolveAgentSignInCommand(grok, settings, "darwin")).toBe("'/opt/x ai/grok' login");
    expect(resolveAgentSignInCommand(grok, settings, "windows")).toBe("& '/opt/x ai/grok' login");
  });

  it("doubles every quote PowerShell would close the path at, curly ones included", () => {
    const grok = agent("grok");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [grok.instanceId]: {
          driver: grok.driver,
          config: { binaryPath: "C:\\it's\\a\u2019; calc; \u2018b\\grok.exe" },
        },
      },
    };
    expect(resolveAgentSignInCommand(grok, settings, "windows")).toBe(
      "& 'C:\\it''s\\a\u2019\u2019; calc; \u2018\u2018b\\grok.exe' login",
    );
  });

  it("has no command for an agent that signs in through the app alone", () => {
    expect(
      resolveAgentSignInCommand(agent("antigravity"), DEFAULT_SERVER_SETTINGS, "darwin"),
    ).toBeNull();
    expect(
      resolveAgentSignInCommand(agent("acpRegistry"), DEFAULT_SERVER_SETTINGS, "darwin"),
    ).toBeNull();
  });
});

describe("onboardingAgentUses", () => {
  it("says what each agent runs on", () => {
    expect(onboardingAgentUses("codex")).toBe("Uses your ChatGPT plan");
    expect(onboardingAgentUses("claudeAgent")).toBe("Uses your Claude plan");
    expect(onboardingAgentUses("github-copilot-cli")).toBe("Uses your GitHub Copilot plan");
    expect(onboardingAgentUses("something-new")).toBe("Uses its own sign-in");
  });
});

describe("listOnboardingAgents", () => {
  const signedOut = { auth: { status: "unauthenticated" }, status: "error" } as const;
  const missing = { installed: false, status: "error", auth: { status: "unknown" } } as const;

  it("lists every agent that is on and installed, Codex and Claude first", () => {
    const list = listOnboardingAgents({
      providers: [agent("grok", signedOut), agent("claudeAgent"), agent("cursor"), agent("codex")],
    });
    expect(list.rows.map((row) => [row.agent, row.state])).toEqual([
      ["codex", "ready"],
      ["claudeAgent", "ready"],
      ["grok", "signIn"],
      ["cursor", "ready"],
    ]);
    expect(list.notInstalled).toEqual([]);
  });

  it("gives each account of one agent its own row", () => {
    const list = listOnboardingAgents({
      providers: [
        agent("claudeAgent"),
        agent("claudeAgent", { instanceId: ProviderInstanceId.make("claude-work"), ...signedOut }),
      ],
    });
    expect(list.rows.filter((row) => row.agent === "claudeAgent").map((row) => row.key)).toEqual([
      "claudeAgent",
      "claude-work",
    ]);
  });

  it("always has a Codex row, because its ChatGPT sign-in needs nothing installed", () => {
    expect(listOnboardingAgents({ providers: null }).rows).toEqual([
      { kind: "agent", key: "codex", agent: "codex", provider: undefined, state: "checking" },
    ]);
    const list = listOnboardingAgents({ providers: [agent("codex", missing)] });
    expect(list.rows.map((row) => [row.agent, row.state])).toEqual([["codex", "install"]]);
    expect(list.notInstalled).toEqual([]);
  });

  it("names agents that are not installed and leaves out ones that are off", () => {
    const list = listOnboardingAgents({
      providers: [
        agent("codex"),
        agent("claudeAgent", missing),
        agent("grok", { enabled: false, status: "disabled" }),
      ],
      notFound: ["claudeAgent", "cursor", "codex", "gemini"],
    });
    expect(list.rows.map((row) => row.agent)).toEqual(["codex"]);
    expect(list.notInstalled).toEqual(["claudeAgent", "cursor", "gemini"]);
  });

  it("adds a row for each found agent that is not on yet", () => {
    const list = listOnboardingAgents({
      providers: [agent("codex"), agent("claudeAgent")],
      found: [
        { agent: "grok", kind: "builtIn", state: "signed-out" },
        { agent: "muse", kind: "builtIn", state: "ready" },
        { agent: "gemini", kind: "registry", state: "installed" },
        // A found agent that already has a row is not listed twice.
        { agent: "claudeAgent", kind: "builtIn", state: "installed" },
      ],
      notFound: ["cursor"],
    });
    expect(list.rows.slice(2)).toEqual([
      { kind: "found", key: "found:grok", agent: "grok", registry: false, state: "signed-out" },
      { kind: "found", key: "found:muse", agent: "muse", registry: false, state: "ready" },
      { kind: "found", key: "found:gemini", agent: "gemini", registry: true, state: "installed" },
    ]);
    expect(list.notInstalled).toEqual(["cursor"]);
  });
});

describe("canInstallOnboardingAgent", () => {
  it("knows an installer for Codex and Claude Code only", () => {
    expect(["codex", "claudeAgent", "grok", "toString"].filter(canInstallOnboardingAgent)).toEqual([
      "codex",
      "claudeAgent",
    ]);
  });
});

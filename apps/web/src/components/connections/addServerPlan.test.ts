import type { NativeConnectionsSnapshot } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  catalogPresence,
  defaultTools,
  installedTools,
  machinePlan,
  otherMachineState,
  secretFields,
  shownCommand,
  signInCommands,
  signInStep,
  toolChoices,
  toolsWithName,
  withSecrets,
} from "./addServerPlan";
import { catalogDraft, CATALOG_SHOWN, SERVER_CATALOG } from "./serverCatalog";
import { parseServerPaste, SERVER_NAME, type ServerDraft } from "./serverPaste";

const entry = (id: string) => SERVER_CATALOG.find((candidate) => candidate.id === id)!;
const pasted = (text: string): ServerDraft => {
  const result = parseServerPaste(text);
  if (!result?.ok) throw new Error("refused");
  return result.draft;
};
const user = (provider: "codex" | "claude", name: string, more: object = {}) => ({
  id: `${provider}:${name}`,
  name,
  provider,
  sourceId: `${provider}-user`,
  scope: "user" as const,
  transport: "http" as const,
  state: "configured" as const,
  shadowed: false,
  ...more,
});
const machine = (more: Partial<NativeConnectionsSnapshot> = {}): NativeConnectionsSnapshot => ({
  observedAt: "2026-11-18T00:00:00Z",
  runtime: "unverified",
  truncated: false,
  sources: [],
  connections: [],
  plugins: [],
  otherTools: [
    { tool: "claude-desktop", status: "read", connections: [] },
    { tool: "cursor", status: "missing", connections: [] },
    { tool: "gemini", status: "read", connections: [] },
  ],
  ...more,
});
/** A snapshot as a machine sends it when it predates a field. */
function without(key: "plugins" | "otherTools"): NativeConnectionsSnapshot {
  const { [key]: _dropped, ...rest } = machine();
  return rest;
}
const linear = catalogDraft(entry("linear"));

describe("server catalog", () => {
  it("carries a checked vendor page and date for every entry", () => {
    expect(SERVER_CATALOG.map((item) => item.id)).toEqual([
      "higgsfield",
      "github",
      "linear",
      "notion",
      "sentry",
      "context7",
      "figma",
    ]);
    expect(CATALOG_SHOWN).toBe(6);
    for (const item of SERVER_CATALOG) {
      expect(item.id).toMatch(SERVER_NAME);
      expect(item.checked).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(item.page).toMatch(/^https:\/\/\S+$/);
      expect(item.url).toMatch(/^https:\/\/\S+$/);
      expect(item.url).not.toMatch(/\/sse\/?$/);
      expect(item.line.length).toBeGreaterThan(0);
      expect(item.signIn === "token").toBe(item.token !== undefined);
      // The paste box reads the same address the card adds.
      expect(pasted(item.url).server.url).toBe(item.url);
    }
    expect(new Set(SERVER_CATALOG.map((item) => item.id)).size).toBe(SERVER_CATALOG.length);
  });

  it("leaves a token entry's token for the user to fill", () => {
    const draft = catalogDraft(entry("github"));
    expect(draft.server.headers).toEqual({ Authorization: "Bearer " });
    const [field] = secretFields(draft);
    expect(field).toEqual({
      where: "header",
      key: "Authorization",
      index: -1,
      prefix: "Bearer ",
      value: "",
    });
    expect(withSecrets(draft, [{ ...field!, value: "tok" }]).server).toEqual({
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer tok" },
    });
  });
});

describe("secret fields", () => {
  it("masks environment values, header values and the argument after a secret flag", () => {
    const draft = pasted(
      "claude mcp add docs -e API_KEY=YOUR_API_KEY -- npx -y docs-mcp --token abc123 --port 80",
    );
    const fields = secretFields(draft);
    expect(fields).toEqual([
      { where: "env", key: "API_KEY", index: -1, prefix: "", value: "" },
      { where: "arg", key: "--token", index: 3, prefix: "", value: "abc123" },
    ]);
    expect(shownCommand(draft)).toBe("npx -y docs-mcp --token •••• --port 80");
    const filled = withSecrets(draft, [
      { ...fields[0]!, value: "real" },
      { ...fields[1]!, value: "other" },
    ]);
    expect(filled.server).toEqual({
      command: "npx",
      args: ["-y", "docs-mcp", "--token", "other", "--port", "80"],
      env: { API_KEY: "real" },
    });
  });

  it("quotes an argument with a space when it shows the command", () => {
    expect(
      shownCommand({ name: "x", kind: "stdio", server: { command: "node", args: ["a b", "c"] } }),
    ).toBe("node 'a b' c");
  });
});

describe("tools on a machine", () => {
  it("lists Codex, Claude Code and the other tools installed there", () => {
    expect(installedTools(machine())).toEqual(["codex", "claude", "claude-desktop", "gemini"]);
    expect(installedTools(without("otherTools"))).toEqual(["codex", "claude"]);
  });

  it("ticks what can run a web address and names why Claude Desktop cannot", () => {
    const choices = toolChoices(machine(), linear);
    expect(choices).toEqual([
      { tool: "codex", blocked: null },
      { tool: "claude", blocked: null },
      { tool: "claude-desktop", blocked: "kind" },
      { tool: "gemini", blocked: null },
    ]);
    expect(defaultTools(choices, entry("linear"))).toEqual(["codex", "claude", "gemini"]);
    // Figma admits only the tools on its own list.
    expect(defaultTools(choices, entry("figma"))).toEqual(["codex", "claude"]);
    expect(
      toolChoices(machine(), pasted("npx -y docs-mcp")).every((choice) => choice.blocked === null),
    ).toBe(true);
  });

  it("finds the tools whose own file already has the name", () => {
    const snapshot = machine({
      connections: [
        user("codex", "linear"),
        user("claude", "linear", { plugin: "linear@official" }),
        user("claude", "linear", { scope: "local", project: "site" }),
      ],
      otherTools: [
        {
          tool: "gemini",
          status: "read",
          connections: [{ id: "g", name: "linear", transport: "http", state: "disabled" }],
        },
      ],
    });
    expect(toolsWithName(snapshot, "linear")).toEqual(["codex", "gemini"]);
    expect(toolChoices(snapshot, linear)).toEqual([
      { tool: "codex", blocked: "taken" },
      { tool: "claude", blocked: null },
      { tool: "gemini", blocked: "taken" },
    ]);
  });

  it("leaves out of a machine's request the tools it would refuse", () => {
    const snapshot = machine({
      connections: [user("codex", "linear")],
      otherTools: [{ tool: "claude-desktop", status: "read", connections: [] }],
    });
    expect(machinePlan(snapshot, linear, ["codex", "claude", "claude-desktop", "cursor"])).toEqual({
      tools: ["claude"],
      dropped: [
        { tool: "codex", why: "taken" },
        { tool: "claude-desktop", why: "kind" },
        { tool: "cursor", why: "missing" },
      ],
    });
  });

  it("says whether a catalog server is on the machine in all tools, some or none", () => {
    const only = { otherTools: [] };
    expect(catalogPresence(machine(only), entry("linear"))).toBe("absent");
    expect(
      catalogPresence(
        machine({ ...only, connections: [user("codex", "linear")] }),
        entry("linear"),
      ),
    ).toBe("partly");
    expect(
      catalogPresence(
        machine({ ...only, connections: [user("codex", "linear"), user("claude", "linear")] }),
        entry("linear"),
      ),
    ).toBe("added");
  });
});

describe("sign-in step", () => {
  it("builds each tool's command from the server's final name", () => {
    expect(signInCommands("linear-work", ["codex", "claude", "gemini", "cursor"]))
      .toMatchInlineSnapshot(`
      [
        {
          "command": "codex mcp login linear-work",
          "tool": "codex",
        },
        {
          "command": "claude mcp login linear-work",
          "tool": "claude",
        },
      ]
    `);
    expect(signInCommands("x", ["gemini"])).toEqual([]);
  });

  it("is offered only where a browser sign-in may be left to do", () => {
    expect(signInStep(linear, entry("linear"))).toBe("browser");
    expect(signInStep(catalogDraft(entry("context7")), entry("context7"))).toBeNull();
    expect(signInStep(catalogDraft(entry("github")), entry("github"))).toBeNull();
    expect(signInStep(pasted("https://x.test/mcp"), null)).toBe("maybe");
    expect(signInStep(pasted("npx -y docs-mcp"), null)).toBeNull();
    expect(
      signInStep(pasted('claude mcp add -t http x https://x.test/mcp -H "X-Key: k"'), null),
    ).toBeNull();
  });
});

describe("another machine", () => {
  it("is ready only when connected, permitted, scanned and on a version that previews", () => {
    const ready = { connected: true, permitted: true, snapshot: machine(), failed: false };
    expect(otherMachineState(ready)).toBe("ready");
    expect(otherMachineState({ ...ready, connected: false })).toBe("offline");
    expect(otherMachineState({ ...ready, permitted: false })).toBe("denied");
    expect(otherMachineState({ ...ready, snapshot: null })).toBe("checking");
    expect(otherMachineState({ ...ready, failed: true })).toBe("failed");
    expect(otherMachineState({ ...ready, snapshot: without("plugins") })).toBe("old");
  });
});

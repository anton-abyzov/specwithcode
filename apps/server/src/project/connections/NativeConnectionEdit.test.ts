import { describe, expect, it } from "vite-plus/test";
import {
  disableCodexServer,
  maskedEntry,
  removeCodexServer,
  setClaudePlugin,
  setCodexPlugin,
  setJsonServer,
  toolDeclaration,
  toolEntry,
} from "./NativeConnectionEdit.ts";

const CODEX = `# mine
[mcp_servers.docs]
command = "/bin/docs"
args = ["serve"]

[mcp_servers.docs.env]
TOKEN = "x"

[mcp_servers.other]
url = "https://o.test/mcp"
enabled = true # keep

[plugins."github@openai-curated"]
enabled = true
`;

describe("per-tool declaration edits", () => {
  it("turns a Codex server off by adding or flipping enabled", () => {
    const docs = disableCodexServer(CODEX, "docs")!;
    expect(docs).toContain("[mcp_servers.docs]\nenabled = false\ncommand");
    const other = disableCodexServer(CODEX, "other")!;
    expect(other).toContain("enabled = false # keep");
    expect(disableCodexServer(CODEX, "missing")).toBeNull();
  });
  it("keeps comments that belong to the next table when removing one", () => {
    const text =
      '[mcp_servers.a]\ncommand = "x"\n\n# GitHub server, needs token\n# [mcp_servers.old]\n[mcp_servers.b]\ncommand = "y"\n';
    expect(removeCodexServer(text, "a")).toBe(
      '# GitHub server, needs token\n# [mcp_servers.old]\n[mcp_servers.b]\ncommand = "y"\n',
    );
  });
  it("removes a Codex table with its sub-tables and nothing else", () => {
    const next = removeCodexServer(CODEX, "docs")!;
    expect(next).not.toContain("docs");
    expect(next).toContain("# mine");
    expect(next).toContain("[mcp_servers.other]");
    expect(next).toContain('[plugins."github@openai-curated"]');
    expect(removeCodexServer(CODEX, "missing")).toBeNull();
  });
  it("toggles plugins in Codex and Claude Code", () => {
    expect(setCodexPlugin(CODEX, "github@openai-curated", false)).toContain(
      '[plugins."github@openai-curated"]\nenabled = false',
    );
    expect(setCodexPlugin(CODEX, "absent@x", false)).toBeNull();
    expect(JSON.parse(setClaudePlugin('{"theme":"dark"}', "a@b", false)!)).toEqual({
      theme: "dark",
      enabledPlugins: { "a@b": false },
    });
  });
  it("writes each tool's own format and reads it back as the same launch", () => {
    const stdio = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { K: "v" },
    } as const;
    const http = { transport: "http", url: "https://x.test/mcp", headers: { A: "b" } } as const;
    for (const tool of ["claude", "gemini", "copilot", "cursor", "opencode", "windsurf"] as const) {
      expect(toolDeclaration(tool, toolEntry(tool, stdio))).toEqual(stdio);
      expect(toolDeclaration(tool, toolEntry(tool, http))).toEqual(http);
    }
    expect(toolEntry("opencode", stdio)).toEqual({
      type: "local",
      command: ["npx", "-y", "pkg"],
      environment: { K: "v" },
      enabled: true,
    });
    expect(toolEntry("windsurf", http)).toEqual({
      serverUrl: "https://x.test/mcp",
      headers: { A: "b" },
    });
    expect(toolEntry("claude-desktop", http)).toBeNull();
    expect(toolDeclaration("gemini", { url: "https://x.test/sse" })).toBeNull();
  });
  it("adds, refuses a taken name, and deletes JSON servers keeping other keys", () => {
    const added = setJsonServer("opencode", '{"theme":"x"}', "a", { type: "remote", url: "u" })!;
    expect(JSON.parse(added)).toEqual({ theme: "x", mcp: { a: { type: "remote", url: "u" } } });
    expect(setJsonServer("opencode", added, "a", {})).toBeNull();
    expect(JSON.parse(setJsonServer("opencode", added, "a", undefined)!)).toEqual({
      theme: "x",
      mcp: {},
    });
    expect(setJsonServer("cursor", null, "a", { command: "x" })).toContain('"mcpServers"');
    expect(setJsonServer("cursor", "[1]", "a", { command: "x" })).toBeNull();
  });
  it("masks environment, headers and secret-shaped values in previews", () => {
    const shown = maskedEntry({
      command: "npx",
      args: ["--api-key", "abc", "--token=xyz", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      env: { OPENAI_API_KEY: "sk-live" },
      url: "https://user:pw@x.test/mcp?key=1",
      headers: { Authorization: "Bearer t" },
    });
    expect(shown).not.toMatch(/abc|xyz|ghp_|sk-live|pw@|key=1|Bearer/);
    expect(shown).toContain('"OPENAI_API_KEY":"••••"');
    expect(shown).toContain('"--token=••••"');
    for (const entry of [
      {
        command: "npx",
        args: [
          "mcp-remote",
          "https://x.test/sse",
          "--header",
          "Authorization: Bearer abc123secret",
        ],
      },
      { command: "docker", args: ["run", "-e", "GITHUB_TOKEN=mysecretvalue1"] },
      { command: "sh", args: ["-c", "API_KEY=secret123 node s.js"] },
      { command: "x", args: ["--pat", "ghx"] },
      { url: "https://x.test/mcp", bearer_token: "tok_short_secret" },
      { command: "x", oauth: { clientSecret: "s3cr3t" } },
    ])
      expect(maskedEntry(entry)).not.toMatch(
        /abc123secret|mysecretvalue1|secret123|ghx|tok_short|s3cr3t/,
      );
    expect(maskedEntry({ args: ["-e", "GITHUB_TOKEN=v"] })).toContain("GITHUB_TOKEN=••••");
  });
});

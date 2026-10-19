import { describe, expect, it } from "vite-plus/test";
import {
  disableCodexServer,
  editableCodexSkills,
  maskedEntry,
  removeCodexServer,
  setClaudePlugin,
  setCodexPlugin,
  setCodexSkills,
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
      args: ["--api-key", "abc", "--token=xyz", `ghp_${"abcdef"}ghijklmnopqrstuvwxyz0123456789`],
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

const SKILLS = `model = "gpt-5"

[[skills.config]]
path = "/Users/me/.codex/skills/stripe-docs/SKILL.md"
enabled = false

[[skills.config]]
name = "github:review"
enabled = false # mine

[mcp_servers.docs]
command = "/bin/docs"
`;

describe("Codex skill switches", () => {
  it("turns skills off by name, appending only the missing entries", () => {
    const names = ["stripe:stripe-docs", "stripe:stripe-pay", "github:review"];
    const off = setCodexSkills(SKILLS, names, false)!;
    expect(off.startsWith(SKILLS)).toBe(true);
    expect(off.slice(SKILLS.length)).toBe(
      '\n[[skills.config]]\nname = "stripe:stripe-docs"\nenabled = false\n\n[[skills.config]]\nname = "stripe:stripe-pay"\nenabled = false\n',
    );
    expect(setCodexSkills(off, names, false)).toBe(off);
    expect(setCodexSkills("", ["a:b"], false)).toBe(
      '[[skills.config]]\nname = "a:b"\nenabled = false\n',
    );
  });
  it("turns skills on by removing exactly their name entries", () => {
    const off = setCodexSkills(SKILLS, ["stripe:stripe-docs", "stripe:stripe-pay"], false)!;
    expect(setCodexSkills(off, ["stripe:stripe-docs", "stripe:stripe-pay"], true)).toBe(SKILLS);
    const github = setCodexSkills(SKILLS, ["github:review"], true)!;
    expect(github).toBe(
      'model = "gpt-5"\n\n[[skills.config]]\npath = "/Users/me/.codex/skills/stripe-docs/SKILL.md"\nenabled = false\n\n[mcp_servers.docs]\ncommand = "/bin/docs"\n',
    );
    expect(setCodexSkills(SKILLS, ["absent:skill"], true)).toBe(SKILLS);
  });
  it("replaces a name entry that turns the skill on and refuses an unparsable result", () => {
    const text = '[[skills.config]]\nname = "a:b"\nenabled = true\n';
    expect(setCodexSkills(text, ["a:b"], false)).toBe(
      '[[skills.config]]\nname = "a:b"\nenabled = false\n',
    );
    expect(setCodexSkills("[broken", ["a:b"], false)).toBeNull();
  });
  it("keeps CRLF line endings and reads entries in the middle of the file", () => {
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    const off = crlf('[[skills.config]]\nname = "a:b"\nenabled = false\n[x]\ny = 1\n');
    expect(setCodexSkills(off, ["a:b"], true)).toBe(crlf("[x]\ny = 1\n"));
    const on = crlf('[[skills.config]]\nname = "a:b"\nenabled = true\n[x]\ny = 1\n');
    expect(setCodexSkills(on, ["a:b", "a:c"], false)).toBe(
      crlf(
        '[x]\ny = 1\n\n[[skills.config]]\nname = "a:b"\nenabled = false\n\n[[skills.config]]\nname = "a:c"\nenabled = false\n',
      ),
    );
  });
  it("refuses to leave an entry that still turns a name the other way", () => {
    // The nested array line reads as a header, so the scanner cannot take that entry.
    const cut = '[[skills.config]]\nname = "a:b"\nenabled = true\nkeep = [\n[1]\n]\n';
    expect(setCodexSkills(cut, ["a:b"], false)).toBeNull();
    const off = '[[skills.config]]\nname = "a:b"\nenabled = false\nkeep = [\n[1]\n]\n';
    expect(setCodexSkills(off, ["a:b"], true)).toBeNull();
  });
  it("flips the switch of an entry with keys of its own instead of dropping it", () => {
    const own = '[[skills.config]]\nname = "a:b"\nenabled = false\nnote = "keep"\n';
    const on = setCodexSkills(own, ["a:b"], true)!;
    expect(on).toBe(own.replace("false", "true"));
    expect(setCodexSkills(on, ["a:b"], false)).toBe(own);
    expect(setCodexSkills('[[skills.config]]\nname = "a:b"\nnote = "keep"\n', ["a:b"], false)).toBe(
      '[[skills.config]]\nenabled = false\nname = "a:b"\nnote = "keep"\n',
    );
  });
  it("edits skills.config written as one inline array", () => {
    const inline =
      '[skills]\nconfig = [{ name = "x" }, { path = "/p/SKILL.md", enabled = false }]\n';
    const off = setCodexSkills(inline, ["a:b"], false)!;
    expect(off).toBe(inline.replace("false }]", 'false }, { name = "a:b", enabled = false }]'));
    expect(setCodexSkills(off, ["a:b"], true)).toBe(inline);
    const lines =
      'skills.config = [\n  { name = "a:b", enabled = false, note = "keep" },\n  { name = "a:c", enabled = false }, # c\n]\n';
    expect(setCodexSkills(lines, ["a:b", "a:c"], true)).toBe(
      'skills.config = [\n  { name = "a:b", enabled = true, note = "keep" }, # c\n]\n',
    );
    expect(setCodexSkills(lines, ["a:d"], false)).toBe(
      lines.replace("}, # c", '},\n  { name = "a:d", enabled = false }, # c'),
    );
    expect(
      setCodexSkills('skills.config = [{ name = "a:b", enabled = false }]\n', ["a:b"], true),
    ).toBe("skills.config = []\n");
  });
  it("leaves forms it does not write to the caller", () => {
    for (const text of [
      '[skills.config]\nname = "a:b"\n',
      'skills = { config = [{ name = "a:b", enabled = false }] }\n',
    ]) {
      expect(editableCodexSkills(text)).toBe(false);
      expect(setCodexSkills(text, ["a:b"], true)).toBeNull();
    }
    expect(editableCodexSkills(SKILLS)).toBe(true);
    expect(editableCodexSkills("")).toBe(true);
  });
});

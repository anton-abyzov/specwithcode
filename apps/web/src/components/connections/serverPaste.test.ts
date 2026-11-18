import { describe, expect, it } from "vite-plus/test";

import {
  builtInOverlap,
  isPlaceholder,
  parseServerPaste,
  secretArgs,
  serverNameFrom,
  shellWords,
  type ServerDraft,
} from "./serverPaste";
import { parseTomlSubset } from "./serverPasteToml";

function draft(text: string): ServerDraft {
  const result = parseServerPaste(text);
  if (!result?.ok) throw new Error(`refused: ${JSON.stringify(result)}`);
  return result.draft;
}
function refusal(text: string) {
  const result = parseServerPaste(text);
  if (!result || result.ok) throw new Error(`accepted: ${JSON.stringify(result)}`);
  return { reason: result.reason, ...(result.params ? { params: result.params } : {}) };
}
const UNREADABLE = {
  reason: "SpecWithCode could not read this as a web address, a command or a settings block.",
};
const SSE = {
  reason:
    "This is an SSE server, which SpecWithCode cannot add. Look for a Streamable HTTP address on the server's setup page.",
};
const flag = (tool: string, name: string) => ({
  reason: "SpecWithCode cannot carry over the {tool} option “{flag}”.",
  params: { tool, flag: name },
});
const key = (name: string) => ({
  reason: "SpecWithCode cannot carry over the setting “{key}”: it only works in one tool.",
  params: { key: name },
});

describe("parseServerPaste", () => {
  it("says nothing about an empty box", () => {
    expect(parseServerPaste("  \n ")).toBeNull();
  });

  it("reads a web address and names the server after its site", () => {
    expect(draft(" https://mcp.higgsfield.ai/mcp ")).toEqual({
      name: "higgsfield",
      kind: "http",
      server: { url: "https://mcp.higgsfield.ai/mcp" },
    });
    expect(draft("https://api.githubcopilot.com/mcp/").name).toBe("githubcopilot");
    expect(draft("http://127.0.0.1:8080/mcp").name).toBe("server");
    expect(draft("http://localhost:3000/mcp").name).toBe("server");
  });

  it("refuses an SSE address and an address that is not http", () => {
    expect(refusal("https://mcp.linear.app/sse")).toEqual(SSE);
    expect(refusal("wss://example.com/mcp")).toEqual({
      reason: "Only http and https addresses can be added.",
    });
  });

  it("reads a package runner command", () => {
    expect(draft("npx -y @upstash/context7-mcp --api-key abc123")).toEqual({
      name: "context7",
      kind: "stdio",
      server: { command: "npx", args: ["-y", "@upstash/context7-mcp", "--api-key", "abc123"] },
    });
    expect(draft("$ npx @playwright/mcp@latest").name).toBe("playwright");
    expect(draft("uvx mcp-server-git --repository /srv/repo").name).toBe("git");
    expect(draft("npx -y @modelcontextprotocol/server-filesystem /Users/me").name).toBe(
      "filesystem",
    );
    expect(
      draft("docker run -i --rm -e GITHUB_TOKEN ghcr.io/github/github-mcp-server:latest").name,
    ).toBe("github");
    expect(draft("node /opt/tools/build/index.js").name).toBe("server");
    expect(draft("API_KEY=abc npx -y some-mcp").server).toEqual({
      command: "npx",
      args: ["-y", "some-mcp"],
      env: { API_KEY: "abc" },
    });
    expect(draft('API_KEY="a b" npx -y some-mcp').server.env).toEqual({ API_KEY: "a b" });
  });

  it("does not guess at a command it does not know", () => {
    expect(refusal("my-server --stdio")).toEqual(UNREADABLE);
    expect(refusal("claude plugin install figma@claude-plugins-official")).toEqual(UNREADABLE);
    expect(refusal("npx 'unclosed")).toEqual(UNREADABLE);
    expect(refusal("some words that are not a command")).toEqual(UNREADABLE);
  });

  it("reads `claude mcp add` for a web address", () => {
    expect(draft("claude mcp add --transport http linear https://mcp.linear.app/mcp")).toEqual({
      name: "linear",
      kind: "http",
      server: { url: "https://mcp.linear.app/mcp" },
    });
    expect(
      draft(
        'claude mcp add --scope user --header "Authorization: Bearer abc" --transport http context7 https://mcp.context7.com/mcp',
      ).server,
    ).toEqual({ url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer abc" } });
    // The address after -H is not taken for a second header.
    expect(
      draft(
        'claude mcp add -t http corridor -H "X-Api-Key: k" -H "X-Team: t" https://app.corridor.dev/api/mcp',
      ),
    ).toEqual({
      name: "corridor",
      kind: "http",
      server: {
        url: "https://app.corridor.dev/api/mcp",
        headers: { "X-Api-Key": "k", "X-Team": "t" },
      },
    });
    expect(draft("claude mcp add sentry https://mcp.sentry.dev/mcp").kind).toBe("http");
  });

  it("reads `claude mcp add` for a program, across continued lines", () => {
    expect(
      draft("claude mcp add my-server -e API_KEY=xxx -e MODE=fast -- npx my-mcp-server"),
    ).toEqual({
      name: "my-server",
      kind: "stdio",
      server: {
        command: "npx",
        args: ["my-mcp-server"],
        env: { API_KEY: "xxx", MODE: "fast" },
      },
    });
    expect(
      draft("claude mcp add tools \\\n  --env=TOKEN=abc \\\n  -- my-command --some-flag arg1")
        .server,
    ).toEqual({ command: "my-command", args: ["--some-flag", "arg1"], env: { TOKEN: "abc" } });
  });

  it("reads `claude mcp add-json`", () => {
    expect(
      draft(
        `claude mcp add-json github '{"type":"http","url":"https://api.githubcopilot.com/mcp","headers":{"Authorization":"Bearer YOUR_GITHUB_PAT"}}'`,
      ),
    ).toEqual({
      name: "github",
      kind: "http",
      server: {
        url: "https://api.githubcopilot.com/mcp",
        headers: { Authorization: "Bearer YOUR_GITHUB_PAT" },
      },
    });
  });

  it("refuses a Claude Code option it cannot carry over, naming it and not its value", () => {
    expect(
      refusal("claude mcp add --transport http --client-id abc123 x https://x.test/mcp"),
    ).toEqual(flag("Claude Code", "--client-id"));
    expect(refusal("claude mcp add -t http x https://x.test/mcp --callback-port=8080")).toEqual(
      flag("Claude Code", "--callback-port"),
    );
    expect(refusal("claude mcp add --frobnicate x -- npx y")).toEqual(
      flag("Claude Code", "--frobnicate"),
    );
    expect(refusal("claude mcp add --transport sse linear https://mcp.linear.app/sse")).toEqual(
      SSE,
    );
    expect(refusal("claude mcp add -t sse linear https://mcp.linear.app/mcp")).toEqual(SSE);
  });

  it("reads `codex mcp add` in both forms", () => {
    expect(draft("codex mcp add figma --url https://mcp.figma.com/mcp")).toEqual({
      name: "figma",
      kind: "http",
      server: { url: "https://mcp.figma.com/mcp" },
    });
    expect(
      draft("codex mcp add context7 --env KEY=v -- npx -y @upstash/context7-mcp --api-key abc"),
    ).toEqual({
      name: "context7",
      kind: "stdio",
      server: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp", "--api-key", "abc"],
        env: { KEY: "v" },
      },
    });
  });

  it("refuses a Codex option it cannot carry over", () => {
    expect(
      refusal(
        "codex mcp add github --url https://api.githubcopilot.com/mcp/ --bearer-token-env-var GITHUB_PAT_TOKEN",
      ),
    ).toEqual(flag("Codex", "--bearer-token-env-var"));
    expect(refusal("codex mcp add -c model=o3 x -- npx y")).toEqual(flag("Codex", "-c"));
    expect(refusal("codex mcp add x --oauth-client-id=abc --url https://x.test/mcp")).toEqual(
      flag("Codex", "--oauth-client-id"),
    );
  });

  it("reads a JSON settings block in the shapes setup pages print", () => {
    const expected = {
      name: "context7",
      kind: "stdio",
      server: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { KEY: "v" } },
    };
    const entry = `{"command":"npx","args":["-y","@upstash/context7-mcp"],"env":{"KEY":"v"}}`;
    expect(draft(`{"mcpServers":{"context7":${entry}}}`)).toEqual(expected);
    expect(draft(`{"context7":${entry}}`)).toEqual(expected);
    expect(draft(`"context7": ${entry},`)).toEqual(expected);
    expect(draft(entry)).toEqual(expected);
    expect(
      draft(`{"servers":{"notion":{"type":"http","url":"https://mcp.notion.com/mcp"}}}`),
    ).toEqual({ name: "notion", kind: "http", server: { url: "https://mcp.notion.com/mcp" } });
    expect(draft(`{"mcpServers":{"x":{"httpUrl":"https://x.test/mcp"}}}`).server).toEqual({
      url: "https://x.test/mcp",
    });
    expect(
      draft(`{"mcp":{"docs":{"type":"local","command":["npx","-y","docs-mcp"],"enabled":true}}}`),
    ).toEqual({
      name: "docs",
      kind: "stdio",
      server: { command: "npx", args: ["-y", "docs-mcp"] },
    });
    expect(draft(`{"mcpServers":{"My Server!":{"command":"npx"}}}`).name).toBe("My-Server");
  });

  it("refuses a JSON block it cannot use", () => {
    expect(
      refusal(`{"mcpServers":{"linear":{"type":"sse","url":"https://mcp.linear.app/sse"}}}`),
    ).toEqual(SSE);
    expect(refusal(`{"mcpServers":{"x":{"url":"https://x.test/sse"}}}`)).toEqual(SSE);
    expect(refusal(`{"mcpServers":{"x":{"command":"npx","cwd":"/srv/secret-path"}}}`)).toEqual(
      key("cwd"),
    );
    expect(refusal(`{"mcpServers":{"x":{"command":"npx","disabled":true}}}`)).toEqual(
      key("disabled"),
    );
    expect(refusal(`{"mcpServers":{"a":{"command":"npx"},"b":{"command":"uvx"}}}`)).toEqual({
      reason: "This block has {count} servers. Paste one at a time.",
      params: { count: "2" },
    });
    expect(refusal(`{"mcpServers":{}}`)).toEqual(UNREADABLE);
    expect(refusal(`{"mcpServers":{"x":{"command":"npx","url":"https://x.test/mcp"}}}`)).toEqual(
      UNREADABLE,
    );
    expect(refusal(`{"mcpServers":{"x":{"command":"npx","env":{"bad key":"v"}}}}`)).toEqual(
      UNREADABLE,
    );
    expect(refusal(`{"mcpServers": {`)).toEqual(UNREADABLE);
  });

  it("reads a TOML settings block", () => {
    expect(
      draft(
        `[mcp_servers.context7]\nurl = "https://mcp.context7.com/mcp"\nhttp_headers = { "Authorization" = "Bearer abc" }\n`,
      ),
    ).toEqual({
      name: "context7",
      kind: "http",
      server: { url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer abc" } },
    });
    expect(
      draft(
        `# docs\n[mcp_servers.docs]\ncommand = "npx" # runner\nargs = [\n  "-y",\n  'docs-mcp',\n]\nenabled = true\n\n[mcp_servers.docs.env]\nTOKEN = "x"\n`,
      ),
    ).toEqual({
      name: "docs",
      kind: "stdio",
      server: { command: "npx", args: ["-y", "docs-mcp"], env: { TOKEN: "x" } },
    });
    expect(draft(`command = "uvx"\nargs = ["mcp-server-git"]`).name).toBe("git");
  });

  it("refuses a TOML block it cannot use", () => {
    expect(
      refusal(
        `[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\nbearer_token_env_var = "GITHUB_PAT_TOKEN"`,
      ),
    ).toEqual(key("bearer_token_env_var"));
    expect(refusal(`[mcp_servers.x]\ncommand = "npx"\nstartup_timeout_sec = 20`)).toEqual(
      key("startup_timeout_sec"),
    );
    expect(refusal(`[mcp_servers.a]\ncommand = "npx"\n[mcp_servers.b]\ncommand = "uvx"`)).toEqual({
      reason: "This block has {count} servers. Paste one at a time.",
      params: { count: "2" },
    });
    expect(refusal(`[[mcp_servers]]\nname = "x"`)).toEqual(UNREADABLE);
    expect(refusal(`[mcp_servers.x]\ncommand = """\nnpx"""`)).toEqual(UNREADABLE);
  });

  it("never puts a pasted value into a refusal", () => {
    const secret = "s3cr3t-value-1234";
    for (const text of [
      `claude mcp add --client-id ${secret} x https://x.test/mcp`,
      `codex mcp add x --url https://x.test/mcp --bearer-token-env-var ${secret}`,
      `{"mcpServers":{"x":{"command":"npx","cwd":"${secret}"}}}`,
      `[mcp_servers.x]\ncommand = "npx"\nbearer_token_env_var = "${secret}"`,
    ])
      expect(JSON.stringify(parseServerPaste(text))).not.toContain(secret);
  });
});

describe("paste helpers", () => {
  it("splits words like a shell", () => {
    expect(shellWords(`a "b c" 'd "e"' f\\ g "h\\"i"`)).toEqual([
      "a",
      "b c",
      'd "e"',
      "f g",
      'h"i',
    ]);
    expect(shellWords(`a ''`)).toEqual(["a", ""]);
    expect(shellWords(`a "b`)).toBeNull();
  });

  it("makes a name the machine accepts", () => {
    expect(serverNameFrom("My Server!")).toBe("My-Server");
    expect(serverNameFrom("123")).toBe("server");
    expect(serverNameFrom("x".repeat(90))).toHaveLength(64);
  });

  it("finds the argument that holds a secret", () => {
    expect([...secretArgs(["-y", "pkg", "--api-key", "abc", "--port", "80"])]).toEqual([3]);
    expect([...secretArgs(["--token", "--verbose"])]).toEqual([]);
  });

  it("knows a placeholder from a real value", () => {
    for (const value of ["YOUR_API_KEY", "<token>", "xxx", "...", "${GITHUB_TOKEN}", "$TOKEN", ""])
      expect([value, isPlaceholder(value)]).toEqual([value, true]);
    for (const value of ["abc123", "ghp_realLookingValue", "fast"])
      expect([value, isPlaceholder(value)]).toEqual([value, false]);
  });

  it("names the built-in tool a server overlaps with", () => {
    expect(builtInOverlap(draft("npx -y chrome-devtools-mcp@latest"))?.tool).toBe("chrome");
    expect(builtInOverlap(draft("npx @playwright/mcp@latest"))?.tool).toBe("in-app-browser");
    expect(builtInOverlap(draft("npx -y ios-simulator-mcp"))?.tool).toBe("simulators");
    expect(
      builtInOverlap({ name: "computer-use", kind: "stdio", server: { command: "npx" } })?.tool,
    ).toBe("computer-use");
    expect(builtInOverlap(draft("https://mcp.linear.app/mcp"))).toBeNull();
  });

  it("reads only the TOML it knows", () => {
    expect(parseTomlSubset(`a = 1\nb.c = "x"\n[t."k-1"]\nv = [ "a", "b" ]`)).toEqual({
      a: 1,
      b: { c: "x" },
      t: { "k-1": { v: ["a", "b"] } },
    });
    expect(parseTomlSubset(`a = "x"\na = "y"`)).toBeNull();
    expect(parseTomlSubset(`a = "x" b = "y"`)).toBeNull();
    expect(parseTomlSubset(`a = 2026-11-18T10:00:00Z`)).toBeNull();
  });
});

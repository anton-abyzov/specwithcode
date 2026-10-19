import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Discovery from "./NativeConnectionDiscovery.ts";
import {
  addClaudeServer,
  appendCodexServer,
  enableCodexServer,
  portableDeclaration,
} from "./NativeConnectionEdit.ts";

let root: string;
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-apply-"));
  await NodeFSP.mkdir(NodePath.join(root, "codex"));
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});
const codexFile = () => NodePath.join(root, "codex", "config.toml");
const claudeFile = () => NodePath.join(root, ".claude.json");
const service = <A, E>(
  use: (discovery: Discovery.NativeConnectionDiscovery["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* Discovery.NativeConnectionDiscovery);
  }).pipe(
    Effect.provide(
      Discovery.layer.pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(
          Layer.succeed(Discovery.NativeConnectionPaths, {
            codexHome: NodePath.join(root, "codex"),
            claudeFile: claudeFile(),
            claudeSettings: NodePath.join(root, "settings.json"),
            otherTools: [],
          }),
        ),
      ),
    ),
  );

const managed = <A, E>(
  use: (discovery: Discovery.NativeConnectionDiscovery["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* Discovery.NativeConnectionDiscovery);
  }).pipe(
    Effect.provide(
      Discovery.layer.pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(
          Layer.succeed(Discovery.NativeConnectionPaths, {
            codexHome: NodePath.join(root, "codex"),
            claudeFile: claudeFile(),
            claudeSettings: NodePath.join(root, "settings.json"),
            otherTools: [
              { tool: "cursor", path: NodePath.join(root, "cursor", "mcp.json") },
              { tool: "opencode", path: NodePath.join(root, "opencode", "opencode.json") },
              { tool: "claude-desktop", path: NodePath.join(root, "desktop", "config.json") },
              { tool: "windsurf", path: NodePath.join(root, "windsurf", "mcp_config.json") },
            ],
            stateDir: NodePath.join(root, "state"),
            home: root,
          }),
        ),
      ),
    ),
  );
const write = (relative: string, value: unknown) =>
  Effect.promise(async () => {
    const path = NodePath.join(root, relative);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  });
const readJson = (relative: string) =>
  Effect.promise(async () =>
    JSON.parse(await NodeFSP.readFile(NodePath.join(root, relative), "utf8")),
  );
const readText = (relative: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(root, relative), "utf8"));

const LEGACY_COMPUTER_USE = `# my codex config
model = "gpt-5"

[mcp_servers.computer-use]
command = "./Codex Computer Use.app/Contents/MacOS/Client"
args = ["mcp"]
cwd = "."
enabled = false

[mcp_servers.docs]
command = "/usr/local/bin/docs-mcp"
args = ["serve"]
enabled = false # paused

[plugins."computer-use@openai-bundled"]
enabled = true
`;

describe("native declaration edits", () => {
  it("enables only the named table and keeps comments", () => {
    const next = enableCodexServer(LEGACY_COMPUTER_USE, "docs")!;
    expect(next).toContain("enabled = true # paused");
    expect(next).toContain("# my codex config");
    expect(next.match(/enabled = false/g)).toHaveLength(1);
    expect(enableCodexServer(LEGACY_COMPUTER_USE, "missing")).toBeNull();
  });
  it("refuses declarations that only the declaring tool can run", () => {
    expect(portableDeclaration("codex", { command: "./app/Client", args: ["mcp"] })).toBeNull();
    expect(portableDeclaration("codex", { command: "/bin/x", cwd: "." })).toBeNull();
    expect(
      portableDeclaration("codex", { url: "https://x.test/mcp", bearer_token_env_var: "T" }),
    ).toBeNull();
    expect(portableDeclaration("claude", { type: "sse", url: "https://x.test/sse" })).toBeNull();
    expect(portableDeclaration("claude", { command: "npx", args: ["-y", "pkg"] })).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: {},
    });
  });
  it("appends a Codex table and adds a Claude entry without touching others", () => {
    const declaration = { transport: "http", url: "https://x.test/mcp", headers: {} } as const;
    const codex = appendCodexServer(LEGACY_COMPUTER_USE, "remote", declaration)!;
    expect(codex.startsWith(LEGACY_COMPUTER_USE)).toBe(true);
    expect(codex).toContain('[mcp_servers.remote]\nurl = "https://x.test/mcp"');
    expect(appendCodexServer(LEGACY_COMPUTER_USE, "docs", declaration)).toBeNull();
    const claude = JSON.parse(
      addClaudeServer(
        JSON.stringify({ theme: "dark", mcpServers: { a: {} } }),
        "remote",
        declaration,
      )!,
    );
    expect(claude.theme).toBe("dark");
    expect(Object.keys(claude.mcpServers)).toEqual(["a", "remote"]);
    expect(
      addClaudeServer(JSON.stringify({ mcpServers: { remote: {} } }), "remote", declaration),
    ).toBeNull();
  });
});

describe("native connection apply", () => {
  it.effect("marks plugin-provided and non-portable Codex servers", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => NodeFSP.writeFile(codexFile(), LEGACY_COMPUTER_USE));
      const snapshot = yield* service((discovery) => discovery.read());
      const computerUse = snapshot.connections.find((c) => c.name === "computer-use")!;
      expect(computerUse).toMatchObject({
        state: "disabled",
        portable: false,
        pluginProvided: true,
      });
      expect(snapshot.connections.find((c) => c.name === "docs")).toMatchObject({ portable: true });
    }),
  );
  it.effect("enables a disabled Codex server and copies it to Claude Code", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        NodeFSP.writeFile(codexFile(), LEGACY_COMPUTER_USE, { mode: 0o600 }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(claudeFile(), JSON.stringify({ numStartups: 3 })),
      );
      const docs = (yield* service((discovery) => discovery.read())).connections.find(
        (c) => c.name === "docs",
      )!;
      const enabled = yield* service((discovery) =>
        discovery.apply({ action: "enable", connectionId: docs.id }),
      );
      expect(enabled.connections.find((c) => c.name === "docs")?.state).toBe("configured");
      const copied = yield* service((discovery) =>
        discovery.apply({ action: "copy", connectionId: docs.id }),
      );
      expect(
        copied.connections.find((c) => c.name === "docs" && c.provider === "claude"),
      ).toBeDefined();
      const claude = JSON.parse(
        yield* Effect.promise(() => NodeFSP.readFile(claudeFile(), "utf8")),
      );
      expect(claude.numStartups).toBe(3);
      expect(claude.mcpServers.docs).toEqual({
        type: "stdio",
        command: "/usr/local/bin/docs-mcp",
        args: ["serve"],
        env: {},
      });
      const mode = (yield* Effect.promise(() => NodeFSP.stat(codexFile()))).mode & 0o777;
      expect(mode).toBe(0o600);
      const again = yield* Effect.flip(
        service((discovery) => discovery.apply({ action: "copy", connectionId: docs.id })),
      );
      expect(again.code).toBe("exists");
    }),
  );
  it.effect("refuses to copy a relative-path declaration and writes through symlinks", () =>
    Effect.gen(function* () {
      const real = NodePath.join(root, "dotfiles-config.toml");
      yield* Effect.promise(() => NodeFSP.writeFile(real, LEGACY_COMPUTER_USE));
      yield* Effect.promise(() => NodeFSP.symlink(real, codexFile()));
      const snapshot = yield* service((discovery) => discovery.read());
      const computerUse = snapshot.connections.find((c) => c.name === "computer-use")!;
      const refused = yield* Effect.flip(
        service((discovery) => discovery.apply({ action: "copy", connectionId: computerUse.id })),
      );
      expect(refused.code).toBe("not_portable");
      const docs = snapshot.connections.find((c) => c.name === "docs")!;
      yield* service((discovery) => discovery.apply({ action: "enable", connectionId: docs.id }));
      expect((yield* Effect.promise(() => NodeFSP.lstat(codexFile()))).isSymbolicLink()).toBe(true);
      expect(yield* Effect.promise(() => NodeFSP.readFile(real, "utf8"))).toContain(
        "enabled = true # paused",
      );
    }),
  );
});

describe("managing declarations across tools", () => {
  const setup = Effect.gen(function* () {
    yield* write("codex/config.toml", LEGACY_COMPUTER_USE);
    yield* write(".claude.json", {
      numStartups: 3,
      mcpServers: {
        notes: { type: "stdio", command: "notes-mcp", args: [], env: { TOKEN: "sk-secret" } },
      },
    });
    yield* write("cursor/mcp.json", { mcpServers: {} });
    yield* write("opencode/opencode.json", { theme: "x" });
    yield* write("desktop/config.json", { mcpServers: {} });
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "windsurf")));
  });
  it.effect("previews an add with masked values and writes nothing", () =>
    Effect.gen(function* () {
      yield* setup;
      const before = yield* readText(".claude.json");
      const result = yield* managed((d) =>
        d.apply({
          action: "add",
          preview: true,
          name: "search",
          tools: ["claude", "cursor", "windsurf"],
          server: { command: "npx", args: ["-y", "search-mcp"], env: { API_KEY: "sk-live-123" } },
        }),
      );
      expect(result.change?.preview).toBe(true);
      expect(result.change?.id).toBeUndefined();
      expect(result.change?.files.map((f) => f.path)).toEqual([
        "~/.claude.json",
        NodePath.join("~", "cursor", "mcp.json"),
        NodePath.join("~", "windsurf", "mcp_config.json"),
      ]);
      expect(JSON.stringify(result.change)).not.toContain("sk-live-123");
      expect(yield* readText(".claude.json")).toBe(before);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.access(NodePath.join(root, "windsurf", "mcp_config.json")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  );
  it.effect("adds to each ticked tool in its format, refuses a taken name, and undoes", () =>
    Effect.gen(function* () {
      yield* setup;
      const add = {
        action: "add",
        name: "search",
        tools: ["codex", "opencode", "windsurf"],
        server: { url: "https://search.test/mcp" },
      } as const;
      const result = yield* managed((d) => d.apply(add));
      expect(result.change?.id).toMatch(/^\d{13}-[0-9a-f]{8}$/);
      expect(yield* readText("codex/config.toml")).toContain(
        '[mcp_servers.search]\nurl = "https://search.test/mcp"',
      );
      expect((yield* readJson("opencode/opencode.json")).mcp.search).toEqual({
        type: "remote",
        url: "https://search.test/mcp",
        enabled: true,
      });
      expect((yield* readJson("windsurf/mcp_config.json")).mcpServers.search).toEqual({
        serverUrl: "https://search.test/mcp",
      });
      const taken = yield* Effect.flip(managed((d) => d.apply(add)));
      expect(taken.code).toBe("exists");
      yield* managed((d) => d.apply({ action: "undo", changeId: result.change!.id! }));
      expect(yield* readText("codex/config.toml")).toBe(LEGACY_COMPUTER_USE);
      expect(yield* readJson("opencode/opencode.json")).toEqual({ theme: "x" });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.access(NodePath.join(root, "windsurf", "mcp_config.json")).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }),
  );
  it.effect("parks a Claude Code server, lists it disabled, and restores it unchanged", () =>
    Effect.gen(function* () {
      yield* setup;
      const original = (yield* readJson(".claude.json")).mcpServers.notes;
      const notes = (yield* managed((d) => d.read())).connections.find((c) => c.name === "notes")!;
      const off = yield* managed((d) => d.apply({ action: "disable", connectionId: notes.id }));
      expect((yield* readJson(".claude.json")).mcpServers).toEqual({});
      const kept = off.connections.find((c) => c.name === "notes")!;
      expect(kept).toMatchObject({ state: "disabled", parked: true, shadowed: false });
      expect(kept.id).toMatch(/^parked:claude:/);
      expect(JSON.stringify(off.change)).not.toContain("sk-secret");
      const mode = (yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(root, "state", "connections", "parked.json")),
      )).mode;
      expect(mode & 0o077).toBe(0);
      yield* managed((d) => d.apply({ action: "enable", connectionId: kept.id }));
      const claude = yield* readJson(".claude.json");
      expect(claude.mcpServers.notes).toEqual(original);
      expect(claude.numStartups).toBe(3);
      expect(
        (yield* managed((d) => d.read())).connections.filter((c) => c.name === "notes"),
      ).toHaveLength(1);
    }),
  );
  it.effect("turns Codex and OpenCode servers off natively and removes entries", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* write("opencode/opencode.json", {
        mcp: { a: { type: "remote", url: "https://a.test" } },
      });
      const snapshot = yield* managed((d) => d.read());
      const a = snapshot.otherTools!.find((t) => t.tool === "opencode")!.connections[0]!;
      yield* managed((d) => d.apply({ action: "disable", connectionId: a.id }));
      expect((yield* readJson("opencode/opencode.json")).mcp.a.enabled).toBe(false);
      yield* managed((d) => d.apply({ action: "enable", connectionId: a.id }));
      expect((yield* readJson("opencode/opencode.json")).mcp.a.enabled).toBe(true);
      const docs = snapshot.connections.find((c) => c.name === "docs")!;
      yield* managed((d) => d.apply({ action: "enable", connectionId: docs.id }));
      yield* managed((d) => d.apply({ action: "disable", connectionId: docs.id }));
      expect(yield* readText("codex/config.toml")).toContain("enabled = false # paused");
      yield* managed((d) => d.apply({ action: "remove", connectionId: docs.id }));
      const text = yield* readText("codex/config.toml");
      expect(text).not.toContain("[mcp_servers.docs]");
      expect(text).toContain("[mcp_servers.computer-use]");
    }),
  );
  it.effect("copies a portable server to every tool that lacks it and can run it", () =>
    Effect.gen(function* () {
      yield* setup;
      const notes = (yield* managed((d) => d.read())).connections.find((c) => c.name === "notes")!;
      const result = yield* managed((d) => d.apply({ action: "copyAll", connectionId: notes.id }));
      expect(result.change?.files.map((f) => f.tool)).toEqual([
        "Codex",
        "Claude Desktop",
        "Cursor",
        "OpenCode",
      ]);
      expect((yield* readJson("opencode/opencode.json")).mcp.notes).toEqual({
        type: "local",
        command: ["notes-mcp"],
        environment: { TOKEN: "sk-secret" },
        enabled: true,
      });
      const again = yield* Effect.flip(
        managed((d) => d.apply({ action: "copyAll", connectionId: notes.id })),
      );
      expect(again.code).toBe("unsupported");
    }),
  );
  it.effect("toggles a Codex plugin and refuses Undo after the file changed", () =>
    Effect.gen(function* () {
      yield* setup;
      const snapshot = yield* managed((d) => d.read());
      expect(snapshot.plugins).toContainEqual({
        provider: "codex",
        key: "computer-use@openai-bundled",
        label: "computer-use",
        enabled: true,
      });
      const off = yield* managed((d) =>
        d.apply({
          action: "plugin",
          provider: "codex",
          pluginKey: "computer-use@openai-bundled",
          enabled: false,
        }),
      );
      expect(off.plugins?.find((p) => p.key === "computer-use@openai-bundled")?.enabled).toBe(
        false,
      );
      const unknown = yield* Effect.flip(
        managed((d) =>
          d.apply({ action: "plugin", provider: "codex", pluginKey: "x@y", enabled: true }),
        ),
      );
      expect(unknown.code).toBe("not_found");
      yield* write("codex/config.toml", `${yield* readText("codex/config.toml")}\n# edited\n`);
      const refused = yield* Effect.flip(
        managed((d) => d.apply({ action: "undo", changeId: off.change!.id! })),
      );
      expect(refused.code).toBe("undo_unavailable");
      expect(yield* readText("codex/config.toml")).toContain("# edited");
    }),
  );
  const stripe = Effect.gen(function* () {
    const remote = "codex/plugins/cache/openai-curated-remote/stripe";
    yield* write(`${remote}/.codex-remote-plugin-install.json`, { schema_version: 1 });
    yield* write(`${remote}/8.0.0/.codex-plugin/plugin.json`, {
      name: "stripe",
      skills: "./skills",
    });
    for (const skill of ["stripe-directory", "stripe-docs", "stripe-pay"])
      yield* write(`${remote}/8.0.0/skills/${skill}/SKILL.md`, `---\nname: ${skill}\n---\n`);
    // A stale local copy Codex never loads, with one skill of its own.
    yield* write(
      "codex/plugins/cache/openai-curated/stripe/0722921d/skills/metronome/SKILL.md",
      "",
    );
  });
  const CONFIG = `${LEGACY_COMPUTER_USE}
[plugins."stripe@openai-curated"]
enabled = true

[[skills.config]]
path = "/Users/me/.codex/skills/stripe-docs/SKILL.md"
enabled = false

[[skills.config]]
name = "stripe:stripe-docs"
enabled = false
`;
  it.effect("turns an account plugin off by its skills and back on, touching nothing else", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* stripe;
      yield* write("codex/config.toml", CONFIG);
      const key = "stripe@openai-curated-remote";
      const before = yield* managed((d) => d.read());
      expect(before.plugins?.find((p) => p.key === key)).toEqual({
        provider: "codex",
        key,
        label: "stripe",
        enabled: true,
        account: true,
      });
      const off = yield* managed((d) =>
        d.apply({ action: "plugin", provider: "codex", pluginKey: key, enabled: false }),
      );
      expect(off.change?.files.map((f) => f.lines)).toEqual([
        [`Turn off the skills of plugin ${key} (4 skills)`],
      ]);
      const written = yield* readText("codex/config.toml");
      expect(written.startsWith(CONFIG)).toBe(true);
      expect(written.slice(CONFIG.length).match(/^name = .*$/gm)).toEqual([
        'name = "stripe:metronome"',
        'name = "stripe:stripe-directory"',
        'name = "stripe:stripe-pay"',
      ]);
      expect(off.plugins?.find((p) => p.key === key)?.enabled).toBe(false);
      // The account copy ignores its table, so none is written for it.
      expect(written).not.toContain("openai-curated-remote");
      const on = yield* managed((d) =>
        d.apply({ action: "plugin", provider: "codex", pluginKey: key, enabled: true }),
      );
      expect(on.plugins?.find((p) => p.key === key)?.enabled).toBe(true);
      expect(yield* readText("codex/config.toml")).toBe(
        CONFIG.replace('\n[[skills.config]]\nname = "stripe:stripe-docs"\nenabled = false\n', ""),
      );
    }),
  );
  it.effect("turns off a stale local plugin together with the account copy of its name", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* stripe;
      yield* write("codex/config.toml", CONFIG);
      const off = yield* managed((d) =>
        d.apply({
          action: "plugin",
          provider: "codex",
          pluginKey: "stripe@openai-curated",
          enabled: false,
        }),
      );
      const written = yield* readText("codex/config.toml");
      expect(written).toContain('[plugins."stripe@openai-curated"]\nenabled = false');
      expect(written.match(/name = "stripe:stripe-docs"/g)).toHaveLength(1);
      expect(written).toContain("/Users/me/.codex/skills/stripe-docs/SKILL.md");
      expect(
        off.plugins?.filter((p) => p.key.startsWith("stripe@")).map((p) => [p.key, p.enabled]),
      ).toEqual([
        ["stripe@openai-curated", false],
        ["stripe@openai-curated-remote", false],
      ]);
      const absent = yield* Effect.flip(
        managed((d) =>
          d.apply({ action: "plugin", provider: "codex", pluginKey: "gone@x", enabled: false }),
        ),
      );
      expect(absent.code).toBe("not_found");
    }),
  );
  it.effect("switches skills when config.toml writes the plugin table or skill list inline", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* stripe;
      const inline = `${LEGACY_COMPUTER_USE}
[plugins]
"stripe@openai-curated" = { enabled = true }

[skills]
config = [ { path = "/x/SKILL.md", enabled = false } ]
`;
      yield* write("codex/config.toml", inline);
      const key = "stripe@openai-curated";
      const off = yield* managed((d) =>
        d.apply({ action: "plugin", provider: "codex", pluginKey: key, enabled: false }),
      );
      expect(off.change?.files.map((f) => f.lines)).toEqual([
        [`Turn off the skills of plugin ${key} (4 skills)`],
      ]);
      const written = yield* readText("codex/config.toml");
      expect(written).toContain('"stripe@openai-curated" = { enabled = true }');
      expect(written).toContain('config = [ { path = "/x/SKILL.md", enabled = false }, { name = ');
      expect(written.match(/enabled = false \}/g)).toHaveLength(5);
      expect(off.plugins?.find((p) => p.key === key)?.enabled).toBe(false);
      yield* managed((d) =>
        d.apply({ action: "plugin", provider: "codex", pluginKey: key, enabled: true }),
      );
      expect(yield* readText("codex/config.toml")).toBe(inline);
      // A plain skills.config table is not a form Codex documents, so it is left alone.
      yield* write("codex/config.toml", '[skills.config]\nname = "stripe:stripe-pay"\n');
      const odd = yield* Effect.flip(
        managed((d) =>
          d.apply({
            action: "plugin",
            provider: "codex",
            pluginKey: "stripe@openai-curated-remote",
            enabled: false,
          }),
        ),
      );
      expect(odd.code).toBe("unsupported");
    }),
  );
  it.effect("offers no switch for an account plugin that ships no skills", () =>
    Effect.gen(function* () {
      yield* setup;
      const remote = "codex/plugins/cache/openai-curated-remote/notes";
      yield* write(`${remote}/.codex-remote-plugin-install.json`, {});
      yield* write(`${remote}/1/.codex-plugin/plugin.json`, { name: "notes" });
      // A non-table value under its key does not hide it.
      yield* write("codex/config.toml", '[plugins]\n"notes@openai-curated-remote" = true\n');
      const key = "notes@openai-curated-remote";
      const read = yield* managed((d) => d.read());
      expect(read.plugins?.find((p) => p.key === key)).toEqual({
        provider: "codex",
        key,
        label: "notes",
        enabled: true,
        account: true,
        switchable: false,
      });
      const refused = yield* Effect.flip(
        managed((d) =>
          d.apply({ action: "plugin", provider: "codex", pluginKey: key, enabled: false }),
        ),
      );
      expect(refused.code).toBe("unsupported");
    }),
  );
  it.effect("keeps a parked copy apart from a live entry of the same name", () =>
    Effect.gen(function* () {
      yield* setup;
      const notes = (yield* managed((d) => d.read())).connections.find((c) => c.name === "notes")!;
      yield* managed((d) => d.apply({ action: "disable", connectionId: notes.id }));
      // The user adds `notes` again by hand while the old one is kept aside.
      yield* write(".claude.json", {
        mcpServers: { notes: { type: "stdio", command: "new-notes" } },
      });
      const both = (yield* managed((d) => d.read())).connections.filter((c) => c.name === "notes");
      const live = both.find((c) => !c.parked)!;
      const kept = both.find((c) => c.parked)!;
      expect(live.id).not.toBe(kept.id);
      expect(kept.shadowed).toBe(true);
      yield* managed((d) => d.apply({ action: "remove", connectionId: kept.id }));
      expect((yield* readJson(".claude.json")).mcpServers.notes.command).toBe("new-notes");
    }),
  );
  it.effect("refuses to rewrite a damaged store of kept servers", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* write("state/connections/parked.json", '{"version":1,"entries":[{"tool":"gemini",');
      const notes = (yield* managed((d) => d.read())).connections.find((c) => c.name === "notes")!;
      const refused = yield* Effect.flip(
        managed((d) => d.apply({ action: "disable", connectionId: notes.id })),
      );
      expect(refused.code).toBe("write_failed");
      expect(yield* readText("state/connections/parked.json")).toContain('"gemini",');
      expect((yield* readJson(".claude.json")).mcpServers.notes).toBeDefined();
    }),
  );
  it.effect("edits one tool while another tool's file is too large to read", () =>
    Effect.gen(function* () {
      yield* setup;
      yield* write(".claude.json", `{"pad":"${"x".repeat(2 * 1024 * 1024)}"}`);
      yield* managed((d) =>
        d.apply({ action: "add", name: "s", tools: ["cursor"], server: { command: "s-mcp" } }),
      );
      expect((yield* readJson("cursor/mcp.json")).mcpServers.s).toEqual({
        command: "s-mcp",
        args: [],
      });
      const refused = yield* Effect.flip(
        managed((d) =>
          d.apply({ action: "add", name: "t", tools: ["claude"], server: { command: "t-mcp" } }),
        ),
      );
      expect(refused.code).toBe("write_failed");
    }),
  );
});

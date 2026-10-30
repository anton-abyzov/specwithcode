import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Discovery from "./NativeConnectionDiscovery.ts";

let root: string;
beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-connections-"));
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});
const put = (path: string, data: string | object) =>
  Effect.promise(async () => {
    const target = NodePath.join(root, path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, typeof data === "string" ? data : JSON.stringify(data));
  });
const scan = (project = false) =>
  Effect.gen(function* () {
    const service = yield* Discovery.NativeConnectionDiscovery;
    return yield* service.read(project ? NodePath.join(root, "repo") : undefined);
  }).pipe(
    Effect.provide(
      Discovery.layer.pipe(
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(
          Layer.succeed(Discovery.NativeConnectionPaths, {
            codexHome: NodePath.join(root, "custom-codex"),
            claudeFile: NodePath.join(root, "custom-claude", ".claude.json"),
            claudeSettings: NodePath.join(root, "custom-claude", "settings.json"),
            otherTools: [],
          }),
        ),
      ),
    ),
  );

describe("native connection configuration discovery", () => {
  it.effect("resolves custom native home paths on the execution host", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", { mcpServers: { custom: { command: "echo" } } });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Discovery.NativeConnectionDiscovery).read();
      }).pipe(
        Effect.provide(Discovery.layerHost),
        Effect.provideService(HostProcessEnvironment, {
          CODEX_HOME: NodePath.join(root, "custom-codex"),
          CLAUDE_CONFIG_DIR: NodePath.join(root, "custom-claude"),
        }),
      );
      expect(result.connections.map((c) => c.name)).toEqual(["custom"]);
    }),
  );
  it.effect("distinguishes absent configuration from an invalid document", () =>
    Effect.gen(function* () {
      yield* put("custom-codex/config.toml", "[broken");
      const result = yield* scan();
      expect(result.sources.map((s) => [s.id, s.status])).toEqual([
        ["codex-user", "invalid"],
        ["claude-user", "missing"],
        ["claude-all-projects", "missing"],
        ["codex-plugins", "read"],
        ["claude-plugins", "read"],
      ]);
      expect(result.connections).toEqual([]);
    }),
  );
  it.effect("projects only bounded metadata and never executes a configured command", () =>
    Effect.gen(function* () {
      const command = `touch ${NodePath.join(root, "must-not-exist")}`;
      yield* put(
        "custom-codex/config.toml",
        `[mcp_servers.posthog]\nurl = "https://example.invalid/mcp?token=private-url-token"\n[mcp_servers.posthog.http_headers]\nAuthorization = "Bearer private-header-token"\n[mcp_servers.local]\ncommand = ${JSON.stringify(command)}\nargs = ["private-arg-token"]\n[mcp_servers.local.env]\nSECRET = "private-env-token"\n`,
      );
      yield* put("custom-claude/.claude.json", {
        mcpServers: {
          posthog: {
            type: "http",
            url: "https://other.invalid",
            headers: { Authorization: "private-claude-token" },
          },
        },
        oauthAccount: { secret: "private-account-token" },
      });
      const result = yield* scan();
      expect(result.connections.map((c) => [c.name, c.provider, c.transport])).toEqual([
        ["posthog", "codex", "http"],
        ["local", "codex", "stdio"],
        ["posthog", "claude", "http"],
      ]);
      expect(JSON.stringify(result)).not.toMatch(
        /private-|example\.invalid|other\.invalid|touch|oauthAccount|Authorization|SECRET/,
      );
      yield* Effect.promise(() =>
        expect(NodeFSP.readFile(NodePath.join(root, "must-not-exist"))).rejects.toMatchObject({
          code: "ENOENT",
        }),
      );
      expect(result.runtime).toBe("unverified");
    }),
  );
  it.effect("reads quoted and inline TOML tables and merges project overrides", () =>
    Effect.gen(function* () {
      yield* put(
        "custom-codex/config.toml",
        '[mcp_servers]\n"with.dot" = { command = "echo", args = ["hello"] }\n[mcp_servers.disabled]\nurl="https://example.invalid"\nenabled=false\n',
      );
      yield* put("repo/.codex/config.toml", '[mcp_servers."with.dot"]\nenabled=false\n');
      const result = yield* scan(true);
      expect(
        result.connections
          .filter((c) => c.name === "with.dot")
          .map((c) => [c.scope, c.state, c.transport, c.shadowed]),
      ).toEqual([
        ["user", "configured", "stdio", true],
        ["project", "disabled", "stdio", false],
      ]);
      expect(result.connections.find((c) => c.name === "disabled")?.state).toBe("disabled");
    }),
  );
  it.effect(
    "isolates registered project paths and applies Claude local over shared over user",
    () =>
      Effect.gen(function* () {
        yield* put("custom-claude/.claude.json", {
          mcpServers: { shared: { command: "user" } },
          projects: {
            [NodePath.join(root, "repo")]: {
              mcpServers: { shared: { type: "http", url: "https://private.invalid" } },
              disabledMcpServers: ["shared"],
            },
            [NodePath.join(root, "other")]: { mcpServers: { foreign: { command: "no" } } },
          },
        });
        yield* put("repo/.mcp.json", {
          mcpServers: { shared: { command: "project" }, onlyProject: { command: "project" } },
        });
        yield* put("repo/.claude/settings.local.json", { disabledMcpjsonServers: ["onlyProject"] });
        const global = yield* scan();
        // Settings lists every project's private declarations beside the user's own.
        expect(global.connections.map((c) => [c.name, c.scope, c.project, c.shadowed])).toEqual([
          ["shared", "user", undefined, false],
          ["shared", "local", "repo", false],
          ["foreign", "local", "other", false],
        ]);
        expect(global.connections[1]?.state).toBe("disabled");
        const result = yield* scan(true);
        const matches = result.connections.filter((c) => c.name === "shared");
        expect(matches.map((c) => [c.scope, c.shadowed])).toEqual([
          ["user", true],
          ["project", true],
          ["local", false],
        ]);
        expect(matches.at(-1)?.state).toBe("disabled");
        expect(result.connections.find((c) => c.name === "onlyProject")?.state).toBe("disabled");
        expect(JSON.stringify(result)).not.toContain("foreign");
      }),
  );
  it.effect("carries only a folder's base name, transport and server name for folder entries", () =>
    Effect.gen(function* () {
      const clientFolder = NodePath.join(root, "home", "anton", "Clients", "acme-portal");
      yield* put("custom-claude/.claude.json", {
        projects: {
          [clientFolder]: {
            mcpServers: {
              figma: {
                type: "http",
                url: "https://mcp.invalid/acme?key=private-url-token",
                headers: { Authorization: "Bearer private-header-token" },
              },
              playwright: {
                command: "/opt/private-bin/playwright",
                args: ["--token", "private-arg-token"],
                env: { API_SECRET: "private-env-token" },
              },
            },
          },
        },
      });
      const result = yield* scan();
      const folder = result.connections.filter((c) => c.sourceId === "claude-all-projects");
      expect(folder.map((c) => [c.name, c.transport, c.project])).toEqual([
        ["figma", "http", "acme-portal"],
        ["playwright", "stdio", "acme-portal"],
      ]);
      for (const entry of folder)
        expect(Object.keys(entry).toSorted()).toEqual([
          "id",
          "name",
          "project",
          "provider",
          "scope",
          "shadowed",
          "sourceId",
          "state",
          "transport",
        ]);
      const payload = JSON.stringify(result);
      expect(payload).not.toMatch(
        /private-|mcp\.invalid|Authorization|API_SECRET|--token|private-bin|Clients|anton/,
      );
      expect(payload).not.toContain(root);
    }),
  );
  it.effect("reads only the given folder's local entries, never another folder's", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", {
        projects: {
          [NodePath.join(root, "repo")]: { mcpServers: { ownServer: { command: "own" } } },
          [NodePath.join(root, "other")]: { mcpServers: { otherServer: { command: "other" } } },
        },
      });
      const result = yield* scan(true);
      expect(
        result.connections.filter((c) => c.scope === "local").map((c) => [c.name, c.project]),
      ).toEqual([["ownServer", undefined]]);
      expect(JSON.stringify(result)).not.toMatch(/otherServer|"other"/);
    }),
  );
  it.effect("marks oversized, non-file, malformed and unsupported sources explicitly", () =>
    Effect.gen(function* () {
      yield* put("custom-codex/config.toml", " ".repeat(2 * 1024 * 1024 + 1));
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(root, "custom-claude", ".claude.json"), { recursive: true }),
      );
      yield* put("repo/.mcp.json", { mcpServers: [] });
      yield* put(
        "repo/.codex/config.toml",
        '[mcp_servers.invalid]\ntype="magic"\nurl="somewhere"\n',
      );
      const result = yield* scan(true);
      expect(result.sources.find((s) => s.id === "codex-user")?.status).toBe("too_large");
      expect(result.sources.find((s) => s.id === "claude-user")?.status).toBe("unreadable");
      expect(result.sources.find((s) => s.id === "claude-project")?.status).toBe("invalid");
      expect(result.connections[0]?.state).toBe("invalid");
    }),
  );
  it.effect("caps server counts and masks secret-shaped or markup server names", () =>
    Effect.gen(function* () {
      const mcpServers = Object.fromEntries(
        Array.from({ length: 205 }, (_, i) => [
          i === 0 ? "sk-privatecredential" : i === 1 ? "<script>bad</script>" : `server-${i}`,
          { command: "echo" },
        ]),
      );
      yield* put("custom-claude/.claude.json", { mcpServers });
      const result = yield* scan();
      expect(result.connections).toHaveLength(200);
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/sk-privatecredential|<script>/);
      expect(result.connections[0]?.name).toMatch(/^Connection /);
    }),
  );
  it.effect("refreshes evidence after changes without retaining removed connections", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", { mcpServers: { old: { command: "echo" } } });
      expect((yield* scan()).connections).toHaveLength(1);
      yield* put("custom-claude/.claude.json", { mcpServers: {} });
      expect((yield* scan()).connections).toEqual([]);
    }),
  );
  it.effect("does not turn invalid JSON root values into a successful empty scan", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", "[]");
      expect((yield* scan()).sources.find((s) => s.id === "claude-user")?.status).toBe("invalid");
    }),
  );
  it.effect.each([null, [], { repo: null }, { repo: [] }])(
    "reports malformed Claude private project data as invalid: %j",
    (projects) =>
      Effect.gen(function* () {
        const data =
          projects && !Array.isArray(projects)
            ? { [NodePath.join(root, "repo")]: projects.repo }
            : projects;
        yield* put("custom-claude/.claude.json", { projects: data });
        expect((yield* scan(true)).sources.find((s) => s.id === "claude-local")?.status).toBe(
          "invalid",
        );
      }),
  );
  it.effect("distinguishes an absent Claude private project from an inspected one", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/.claude.json", { projects: {} });
      expect((yield* scan(true)).sources.find((s) => s.id === "claude-local")?.status).toBe(
        "missing",
      );
      yield* put("custom-claude/.claude.json", { projects: { [NodePath.join(root, "repo")]: {} } });
      expect((yield* scan(true)).sources.find((s) => s.id === "claude-local")?.status).toBe("read");
    }),
  );
});

describe("plugin and other-tool discovery", () => {
  it.effect("lists MCP servers from enabled Codex plugins, newest cached version only", () =>
    Effect.gen(function* () {
      yield* put(
        "custom-codex/config.toml",
        '[plugins."github@curated"]\nenabled = true\n[plugins."off@curated"]\nenabled = false\n[plugins."apps@remote"]\nenabled = true\n[plugins."absent@curated"]\nenabled = true\n[plugins."../escape@curated"]\nenabled = true\n',
      );
      yield* put("custom-codex/plugins/cache/curated/github/old/.mcp.json", {
        mcpServers: { stale: { command: "echo" } },
      });
      yield* Effect.promise(() =>
        NodeFSP.utimes(NodePath.join(root, "custom-codex/plugins/cache/curated/github/old"), 1, 1),
      );
      yield* put("custom-codex/plugins/cache/curated/github/new/.codex-plugin/plugin.json", {
        name: "github",
        mcpServers: "./.mcp.json",
      });
      yield* put("custom-codex/plugins/cache/curated/github/new/.mcp.json", {
        mcpServers: {
          github: { type: "http", url: "https://private.invalid", oauth: { secret: "tok" } },
          review: { command: "/bin/sh", enabled: false },
        },
      });
      yield* put("custom-codex/plugins/cache/curated/github/new/.app.json", {
        apps: { github: { id: "connector_github" } },
      });
      yield* put("custom-codex/plugins/cache/curated/off/v/.mcp.json", {
        mcpServers: { hidden: { command: "echo" } },
      });
      yield* put("custom-codex/plugins/cache/remote/apps/1/.codex-plugin/plugin.json", {
        interface: { displayName: "Marketing Agent" },
      });
      yield* put("custom-codex/plugins/cache/remote/apps/1/.app.json", {
        apps: { "app-69a1247fceb88191a0fde719fd50920d": { id: "x" } },
      });
      const result = yield* scan();
      expect(
        result.connections.map((c) => [c.name, c.plugin, c.transport, c.state, c.portable]),
      ).toEqual([
        ["github", "github", "http", "configured", undefined],
        ["review", "github", "stdio", "disabled", undefined],
        ["Marketing Agent", "Marketing Agent", "http", "configured", undefined],
      ]);
      expect(result.sources.find((s) => s.id === "codex-plugins")?.status).toBe("invalid");
      expect(JSON.stringify(result)).not.toMatch(/stale|hidden|private\.invalid|tok|app-69a1/);
    }),
  );
  it.effect("lists account plugin servers when config.toml has no plugin tables", () =>
    Effect.gen(function* () {
      yield* put("custom-codex/config.toml", 'model = "gpt-5"\n');
      const remote = "custom-codex/plugins/cache/openai-curated-remote";
      yield* put(`${remote}/notion/.codex-remote-plugin-install.json`, { schema_version: 1 });
      yield* put(`${remote}/notion/2.0.0/.codex-plugin/plugin.json`, {
        name: "notion",
        interface: { displayName: "Notion" },
      });
      yield* put(`${remote}/notion/2.0.0/.mcp.json`, {
        mcpServers: { notion: { type: "http", url: "https://private.invalid/mcp" } },
      });
      yield* put(`${remote}/gmail/.codex-remote-plugin-install.json`, {});
      yield* put(`${remote}/gmail/1/.app.json`, { apps: { gmail: { id: "connector_gmail" } } });
      const result = yield* scan();
      expect(result.connections.map((c) => [c.name, c.plugin, c.transport, c.state])).toEqual([
        ["gmail", "gmail", "http", "configured"],
        ["notion", "Notion", "http", "configured"],
      ]);
      expect(result.sources.find((s) => s.id === "codex-plugins")?.status).toBe("read");
      expect(JSON.stringify(result)).not.toMatch(/private\.invalid|connector_gmail/);
    }),
  );
  it.effect("lists account plugins and reads a Codex plugin as off when its skills are", () =>
    Effect.gen(function* () {
      yield* put(
        "custom-codex/config.toml",
        '[plugins."stripe@openai-curated"]\nenabled = true\n[plugins."docs@curated"]\nenabled = true\n\n[[skills.config]]\nname = "stripe:stripe-docs"\nenabled = false\n[[skills.config]]\nname = "stripe:stripe-pay"\nenabled = false\n[[skills.config]]\npath = "/x/docs/SKILL.md"\nenabled = false\n',
      );
      const remote = "custom-codex/plugins/cache/openai-curated-remote";
      yield* put(`${remote}/stripe/.codex-remote-plugin-install.json`, {
        schema_version: 1,
        remote_plugin_id: "plugin_x",
      });
      yield* put(`${remote}/stripe/8.0.0/.codex-plugin/plugin.json`, {
        name: "stripe",
        interface: { displayName: "Stripe" },
        skills: "./skills",
      });
      yield* put(
        `${remote}/stripe/8.0.0/skills/stripe-docs/SKILL.md`,
        "---\nname: stripe-docs\n---\n",
      );
      yield* put(`${remote}/stripe/8.0.0/skills/pay/SKILL.md`, '---\nname: "stripe-pay"\n---\n');
      yield* put(`${remote}/notes/.codex-remote-plugin-install.json`, {});
      yield* put(`${remote}/notes/1/.codex-plugin/plugin.json`, { name: "notes" });
      yield* put(
        "custom-codex/plugins/cache/curated/docs/1/skills/read/SKILL.md",
        "no frontmatter",
      );
      yield* put("custom-codex/plugins/cache/curated/docs/1/skills/empty/notes.txt", "x");
      const result = yield* scan();
      expect(result.plugins?.filter((p) => p.provider === "codex")).toEqual([
        { provider: "codex", key: "stripe@openai-curated", label: "stripe", enabled: false },
        { provider: "codex", key: "docs@curated", label: "docs", enabled: true },
        {
          provider: "codex",
          key: "notes@openai-curated-remote",
          label: "notes",
          enabled: true,
          account: true,
          switchable: false,
        },
        {
          provider: "codex",
          key: "stripe@openai-curated-remote",
          label: "Stripe",
          enabled: false,
          account: true,
        },
      ]);
      // One skill still on keeps the plugin on.
      yield* put(
        `${remote}/stripe/8.0.0/skills/stripe-directory/SKILL.md`,
        "---\nname: stripe-directory\n---\n",
      );
      const more = yield* scan();
      expect(more.plugins?.find((p) => p.key === "stripe@openai-curated-remote")?.enabled).toBe(
        true,
      );
    }),
  );
  it.effect("lists enabled Claude Code plugin servers and ignores installs outside the cache", () =>
    Effect.gen(function* () {
      const plugins = NodePath.join(root, "custom-claude", "plugins");
      yield* put("custom-claude/settings.json", {
        enabledPlugins: { "stripe@official": true, "off@official": false, "evil@x": true },
      });
      yield* put("custom-claude/plugins/installed_plugins.json", {
        version: 2,
        plugins: {
          "stripe@official": [{ scope: "user", installPath: NodePath.join(plugins, "cache/s/1") }],
          "off@official": [{ scope: "user", installPath: NodePath.join(plugins, "cache/o/1") }],
          "evil@x": [{ scope: "user", installPath: NodePath.join(root, "elsewhere") }],
        },
      });
      yield* put("custom-claude/plugins/cache/s/1/.mcp.json", {
        mcpServers: { stripe: { type: "http", url: "https://private.invalid" } },
      });
      yield* put("custom-claude/plugins/cache/o/1/.mcp.json", {
        mcpServers: { hidden: { command: "echo" } },
      });
      yield* put("elsewhere/.mcp.json", { mcpServers: { outside: { command: "echo" } } });
      const result = yield* scan();
      expect(result.connections.map((c) => [c.name, c.provider, c.plugin, c.scope])).toEqual([
        ["stripe", "claude", "stripe", "user"],
      ]);
      expect(result.sources.find((s) => s.id === "claude-plugins")?.status).toBe("read");
    }),
  );
  it.effect("keeps a plugin server beside a same-named user declaration", () =>
    Effect.gen(function* () {
      yield* put("custom-claude/settings.json", { enabledPlugins: { "gh@m": true } });
      yield* put("custom-claude/.claude.json", { mcpServers: { github: { command: "gh" } } });
      const plugins = NodePath.join(root, "custom-claude", "plugins");
      yield* put("custom-claude/plugins/installed_plugins.json", {
        plugins: { "gh@m": [{ scope: "user", installPath: NodePath.join(plugins, "cache/gh") }] },
      });
      yield* put("custom-claude/plugins/cache/gh/.claude-plugin/plugin.json", {
        mcpServers: { github: { type: "http", url: "https://x.invalid" } },
      });
      const result = yield* scan();
      expect(result.connections.map((c) => [c.plugin, c.shadowed])).toEqual([
        [undefined, false],
        ["gh", false],
      ]);
    }),
  );
  it.effect("lists other tools read-only with status, transport and disabled entries", () =>
    Effect.gen(function* () {
      yield* put("gemini.json", {
        mcpServers: { pencil: { command: "pencil" }, remote: { httpUrl: "https://x.invalid" } },
      });
      yield* put("opencode.json", {
        mcp: { local: { type: "local", command: ["run"], enabled: false } },
      });
      yield* put("windsurf.json", "{broken");
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Discovery.NativeConnectionDiscovery).read();
      }).pipe(
        Effect.provide(
          Discovery.layer.pipe(
            Layer.provide(NodeFileSystem.layer),
            Layer.provide(
              Layer.succeed(Discovery.NativeConnectionPaths, {
                codexHome: NodePath.join(root, "codex"),
                claudeFile: NodePath.join(root, "claude.json"),
                claudeSettings: NodePath.join(root, "settings.json"),
                otherTools: [
                  { tool: "gemini", path: NodePath.join(root, "gemini.json") },
                  { tool: "opencode", path: NodePath.join(root, "opencode.json") },
                  { tool: "windsurf", path: NodePath.join(root, "windsurf.json") },
                  { tool: "cursor", path: NodePath.join(root, "cursor.json") },
                ],
              }),
            ),
          ),
        ),
      );
      expect(
        result.otherTools?.map((t) => [
          t.tool,
          t.status,
          t.connections.map((c) => [c.name, c.transport, c.state]),
        ]),
      ).toEqual([
        [
          "gemini",
          "read",
          [
            ["pencil", "stdio", "configured"],
            ["remote", "http", "configured"],
          ],
        ],
        ["opencode", "read", [["local", "stdio", "disabled"]]],
        ["windsurf", "invalid", []],
        ["cursor", "missing", []],
      ]);
      expect(JSON.stringify(result)).not.toContain("x.invalid");
    }),
  );
  it("finds other tools' files under each platform's configuration folder", () => {
    const files = Discovery.otherToolFiles("/h", "darwin", {});
    expect(files.find((f) => f.tool === "claude-desktop")?.path).toBe(
      "/h/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(
      Discovery.otherToolFiles("/h", "linux", { XDG_CONFIG_HOME: "/x" }).find(
        (f) => f.tool === "opencode",
      )?.path,
    ).toBe("/x/opencode/opencode.json");
  });
});

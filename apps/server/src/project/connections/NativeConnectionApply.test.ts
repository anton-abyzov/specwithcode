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
          }),
        ),
      ),
    ),
  );

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

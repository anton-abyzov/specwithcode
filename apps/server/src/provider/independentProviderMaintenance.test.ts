// @effect-diagnostics nodeBuiltinImport:off -- Fixtures use only owned temporary directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { independentProviderMaintenance } from "./independentProviderMaintenance.ts";

const homes: string[] = [];
function fixture(provider = "codex") {
  const home = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-private-provider-")),
  );
  homes.push(home);
  const prefix = NodePath.join(home, ".local/share/specweave/providers");
  const packageName = provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const name = provider === "codex" ? "codex" : "claude";
  const version = provider === "codex" ? "0.160.1" : "2.1.292";
  const manifest = NodePath.join(prefix, "node_modules", packageName, "package.json");
  const entrypoint =
    provider === "codex"
      ? NodePath.join(prefix, "node_modules", packageName, "bin/codex.js")
      : NodePath.join(prefix, "node_modules/@anthropic-ai/claude-code-darwin-arm64/claude");
  const wrapper = NodePath.join(prefix, "bin", name),
    node = NodePath.join(home, ".nvm/versions/node/v22.20.0/bin/node");
  const write = (path: string, value: string) => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, value);
  };
  write(
    NodePath.join(prefix, "package.json"),
    JSON.stringify({ dependencies: { [packageName]: version } }),
  );
  write(manifest, JSON.stringify({ name: packageName, version }));
  write(entrypoint, "fixture-entrypoint");
  write(node, "fixture-node");
  write(
    NodePath.join(prefix, "node_modules/@anthropic-ai/claude-code-darwin-arm64/package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-code-darwin-arm64", version }),
  );
  write(
    wrapper,
    `#!/bin/sh\nset -eu\nexec ${provider === "codex" ? `${node} ` : ""}${entrypoint} "$@"\n`,
  );
  return {
    home,
    prefix,
    wrapper,
    manifest,
    entrypoint,
    node,
    packageName,
    provider,
    context: {
      binaryPath: wrapper,
      resolvedCommandPath: wrapper,
      realCommandPath: wrapper,
      env: {},
      platform: "darwin" as const,
    },
  };
}
const inspect = (value: ReturnType<typeof fixture>) =>
  Effect.runPromise(
    independentProviderMaintenance({
      provider: value.provider,
      packageName: value.packageName,
      context: value.context,
      homeDirectory: value.home,
      architecture: "arm64",
    }).pipe(Effect.provide(NodeServices.layer)),
  );
afterEach(() => {
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});

// The private wrappers are `#!/bin/sh` scripts, a POSIX-only install. The codex
// one execs an absolute node path, which can only be verified without a `\`.
const posixWrapperOnly = process.platform === "win32";
describe("independent private provider ownership", () => {
  it.skipIf(posixWrapperOnly).each(["codex"])(
    "recognizes the exact pinned %s wrapper without executing it",
    async (provider) => {
      expect(await inspect(fixture(provider))).toBe("verified");
    },
  );
  it.each(["claudeAgent"])(
    "recognizes the exact pinned %s wrapper without executing it",
    async (provider) => {
      expect(await inspect(fixture(provider))).toBe("verified");
    },
  );
  it.skipIf(posixWrapperOnly)(
    "keeps a symlink alias to the owned wrapper in the same manual boundary",
    async () => {
      const value = fixture(),
        alias = NodePath.join(value.home, "alias-codex");
      NodeFS.symlinkSync(value.wrapper, alias);
      value.context.resolvedCommandPath = alias;
      expect(await inspect(value)).toBe("verified");
    },
  );
  it("does not claim unrelated custom, native or global installations", async () => {
    const value = fixture();
    for (const path of [
      "tools/custom-codex",
      ".local/bin/codex",
      "global/lib/node_modules/@openai/codex/bin/codex.js",
    ]) {
      value.context.resolvedCommandPath = NodePath.join(value.home, path);
      value.context.realCommandPath = value.context.resolvedCommandPath;
      expect(await inspect(value)).toBeNull();
    }
    expect(await inspect({ ...value, provider: "pi", packageName: "@example/pi" })).toBeNull();
  });
  it("fails closed for a private-prefix symlink ancestor", async () => {
    const value = fixture(),
      redirected = NodePath.join(value.home, "redirected-prefix");
    NodeFS.renameSync(value.prefix, redirected);
    NodeFS.symlinkSync(redirected, value.prefix);
    value.context.realCommandPath = NodeFS.realpathSync(value.wrapper);
    expect(await inspect(value)).toBe("unverified");
  });
  it("fails closed for a redirected package entrypoint", async () => {
    const value = fixture(),
      other = NodePath.join(value.home, "other-entrypoint");
    NodeFS.writeFileSync(other, "other");
    NodeFS.unlinkSync(value.entrypoint);
    NodeFS.symlinkSync(other, value.entrypoint);
    expect(await inspect(value)).toBe("unverified");
  });
  it.each(["malformed", "wrong-package", "unpinned", "oversized"])(
    "does not verify a %s manifest",
    async (kind) => {
      const value = fixture();
      if (kind === "malformed") NodeFS.writeFileSync(value.manifest, "{");
      if (kind === "wrong-package")
        NodeFS.writeFileSync(
          value.manifest,
          JSON.stringify({ name: "@example/wrong", version: "0.160.1" }),
        );
      if (kind === "unpinned")
        NodeFS.writeFileSync(
          NodePath.join(value.prefix, "package.json"),
          JSON.stringify({ dependencies: { [value.packageName]: "^0.160.1" } }),
        );
      if (kind === "oversized") NodeFS.writeFileSync(value.manifest, " ".repeat(20 * 1024));
      expect(await inspect(value)).toBe("unverified");
    },
  );
  it("does not trust extra wrapper commands or a mismatched Claude native package", async () => {
    const codex = fixture();
    NodeFS.appendFileSync(codex.wrapper, "unexpected-command\n");
    expect(await inspect(codex)).toBe("unverified");
    const claude = fixture("claudeAgent");
    NodeFS.writeFileSync(
      NodePath.join(
        claude.prefix,
        "node_modules/@anthropic-ai/claude-code-darwin-arm64/package.json",
      ),
      JSON.stringify({ name: "@anthropic-ai/claude-code-darwin-arm64", version: "2.1.293" }),
    );
    expect(await inspect(claude)).toBe("unverified");
  });
});

// Staged fleet releases install the same `#!/bin/sh` wrapper; Windows has none.
describe.skipIf(posixWrapperOnly)("staged fleet Codex ownership", () => {
  function stagedFixture() {
    const value = fixture();
    const release = NodePath.join(
      value.home,
      ".local/share/specweave/provider-releases/reviewed-release",
    );
    const write = (p: string, value: string) => {
      NodeFS.mkdirSync(NodePath.dirname(p), { recursive: true });
      NodeFS.writeFileSync(p, value);
    };
    const entrypoint = NodePath.join(release, "node_modules/@openai/codex/bin/codex.js");
    write(entrypoint, "codex-entrypoint");
    write(
      NodePath.join(release, "package.json"),
      JSON.stringify({ dependencies: { "@openai/codex": "0.162.1" } }),
    );
    write(
      NodePath.join(release, "node_modules/@openai/codex/package.json"),
      JSON.stringify({ name: "@openai/codex", version: "0.162.1" }),
    );
    const npm = NodePath.resolve(NodePath.dirname(value.node), "../lib/node_modules/npm");
    write(NodePath.join(npm, "package.json"), JSON.stringify({ name: "npm" }));
    write(NodePath.join(npm, "bin/npm-cli.js"), "npm");
    write(value.wrapper, `#!/bin/sh\nset -eu\nexec ${value.node} ${entrypoint} "$@"\n`);
    return { ...value, stagedEntrypoint: entrypoint };
  }
  it("recognizes the actual release wrapper and its owning Node/npm toolchain", async () => {
    const value = stagedFixture();
    expect(await inspect(value)).toMatchObject({
      wrapperPath: value.wrapper,
      nodePath: value.node,
    });
  });
  it("does not authorize arbitrary shell commands or unrelated release locations", async () => {
    const value = stagedFixture();
    NodeFS.appendFileSync(value.wrapper, "echo unexpected\n");
    expect(await inspect(value)).toBe("unverified");
  });
  it("refuses a redirected staged entrypoint", async () => {
    const value = stagedFixture();
    NodeFS.unlinkSync(value.stagedEntrypoint);
    NodeFS.symlinkSync(value.entrypoint, value.stagedEntrypoint);
    expect(await inspect(value)).toBe("unverified");
  });
});

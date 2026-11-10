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
      provider: "codex",
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

// The fleet's Claude wrapper runs the native binary; the pinned Node/npm that
// stages its update is the one the Codex wrapper beside it runs.
describe.skipIf(posixWrapperOnly)("staged fleet Claude ownership", () => {
  const write = (p: string, value: string) => {
    NodeFS.mkdirSync(NodePath.dirname(p), { recursive: true });
    NodeFS.writeFileSync(p, value);
  };
  function claudeFixture(layout: "prefix" | "release") {
    const value = fixture("claudeAgent");
    const releases = NodePath.join(value.home, ".local/share/specweave/provider-releases");
    NodeFS.mkdirSync(releases, { recursive: true });
    const npm = NodePath.resolve(NodePath.dirname(value.node), "../lib/node_modules/npm");
    write(NodePath.join(npm, "package.json"), JSON.stringify({ name: "npm" }));
    write(NodePath.join(npm, "bin/npm-cli.js"), "npm");
    write(
      NodePath.join(value.prefix, "bin/codex"),
      `#!/bin/sh\nset -eu\nexec ${value.node} ${NodePath.join(releases, "r1/node_modules/@openai/codex/bin/codex.js")} "$@"\n`,
    );
    let entrypoint = value.entrypoint;
    if (layout === "release") {
      const release = NodePath.join(releases, "reviewed-release");
      const version = "2.1.295";
      write(
        NodePath.join(release, "package.json"),
        JSON.stringify({ dependencies: { "@anthropic-ai/claude-code": version } }),
      );
      for (const name of ["@anthropic-ai/claude-code", "@anthropic-ai/claude-code-darwin-arm64"])
        write(
          NodePath.join(release, "node_modules", name, "package.json"),
          JSON.stringify({ name, version }),
        );
      entrypoint = NodePath.join(
        release,
        "node_modules/@anthropic-ai/claude-code-darwin-arm64/claude",
      );
      write(entrypoint, "native");
      write(value.wrapper, `#!/bin/sh\nset -eu\nexec ${entrypoint} "$@"\n`);
    }
    return { ...value, releases, stagedEntrypoint: entrypoint };
  }
  it.each(["prefix", "release"] as const)(
    "stages an update for the %s layout with the fleet's Node/npm",
    async (layout) => {
      const value = claudeFixture(layout);
      expect(await inspect(value)).toMatchObject({
        provider: "claude",
        wrapperPath: value.wrapper,
        releasesDirectory: value.releases,
        nodePath: value.node,
      });
    },
  );
  it("stages the original prefix before any release folder exists", async () => {
    const value = claudeFixture("prefix");
    NodeFS.rmSync(value.releases, { recursive: true });
    expect(await inspect(value)).toMatchObject({
      provider: "claude",
      releasesDirectory: value.releases,
    });
  });
  it("stays manual without the pinned toolchain", async () => {
    const value = claudeFixture("prefix");
    NodeFS.unlinkSync(NodePath.join(value.prefix, "bin/codex"));
    expect(await inspect(value)).toBe("verified");
    expect(await inspect(claudeFixture("release"))).toMatchObject({ provider: "claude" });
    const release = claudeFixture("release");
    NodeFS.unlinkSync(NodePath.join(release.prefix, "bin/codex"));
    expect(await inspect(release)).toBe("unverified");
  });
  it("refuses extra commands, redirected binaries and mismatched packages", async () => {
    const extra = claudeFixture("release");
    NodeFS.appendFileSync(extra.wrapper, "echo unexpected\n");
    expect(await inspect(extra)).toBe("unverified");
    const redirected = claudeFixture("release");
    NodeFS.unlinkSync(redirected.stagedEntrypoint);
    NodeFS.symlinkSync(redirected.entrypoint, redirected.stagedEntrypoint);
    expect(await inspect(redirected)).toBe("unverified");
    const mismatched = claudeFixture("release");
    write(
      NodePath.join(NodePath.dirname(mismatched.stagedEntrypoint), "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code-darwin-arm64", version: "2.1.294" }),
    );
    expect(await inspect(mismatched)).toBe("unverified");
  });
  it("stages a release provisioned with only the platform package", async () => {
    const value = claudeFixture("release");
    const release = NodePath.join(value.releases, "reviewed-release");
    NodeFS.rmSync(NodePath.join(release, "node_modules/@anthropic-ai/claude-code"), {
      recursive: true,
    });
    write(
      NodePath.join(release, "package.json"),
      JSON.stringify({ dependencies: { "@anthropic-ai/claude-code-darwin-arm64": "2.1.295" } }),
    );
    expect(await inspect(value)).toMatchObject({ provider: "claude", wrapperPath: value.wrapper });
    write(
      NodePath.join(release, "package.json"),
      JSON.stringify({ dependencies: { "@anthropic-ai/claude-code-darwin-arm64": "2.1.294" } }),
    );
    expect(await inspect(value)).toBe("unverified");
  });
  it("is not offered off Apple silicon", async () => {
    const value = claudeFixture("release");
    expect(
      await Effect.runPromise(
        independentProviderMaintenance({
          provider: value.provider,
          packageName: value.packageName,
          context: value.context,
          homeDirectory: value.home,
          architecture: "x64",
        }).pipe(Effect.provide(NodeServices.layer)),
      ),
    ).toBe("unverified");
  });
});

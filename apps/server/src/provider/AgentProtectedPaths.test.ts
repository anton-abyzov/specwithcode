// @effect-diagnostics-next-line nodeBuiltinImport:off -- the case probe must run before tests are declared.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  agentProtectedPathsForConfig,
  claudeAgentSecretDenyForConfig,
  claudeAgentSecretDenyRules,
  claudeRulePath,
  isAgentProtectedPath,
  makeAgentPathGuard,
  withClaudeAgentSecretDenySettings,
  type AgentPathOps,
} from "./AgentProtectedPaths.ts";

// APFS (macOS default) folds case with full Unicode folding: `SECRETS` and
// `ſecrets` (U+017F) open the stored `secrets` folder.
const tempVolumeFoldsCase =
  HostProcessPlatform.defaultValue() === "darwin" &&
  NodeFS.existsSync(NodeOS.tmpdir().toUpperCase());

const homeLayout = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-protected-paths-" }),
  );
  const stateDir = path.join(baseDir, "userdata");
  const secretsDir = path.join(stateDir, "secrets");
  yield* fileSystem.makeDirectory(secretsDir, { recursive: true });
  yield* fileSystem.writeFileString(path.join(secretsDir, "anthropic-api-key.bin"), "fake");
  yield* fileSystem.writeFileString(path.join(baseDir, "studio-fleet.json"), "{}");
  yield* fileSystem.makeDirectory(path.join(stateDir, "logs"), { recursive: true });
  yield* fileSystem.writeFileString(path.join(stateDir, "logs", "server.log"), "log");
  const config = { baseDir, stateDir, secretsDir };
  return { fileSystem, path, config, paths: agentProtectedPathsForConfig(config, path) };
});

describe("AgentProtectedPaths", () => {
  it.effect("refuses the secrets folder, the fleet file and links into them", () =>
    Effect.gen(function* () {
      const { fileSystem, path, config, paths } = yield* homeLayout;
      const isProtected = (target: string, cwd?: string) =>
        isAgentProtectedPath(fileSystem, path, paths, target, cwd);
      const secret = path.join(config.secretsDir, "anthropic-api-key.bin");

      assert.isTrue(yield* isProtected(secret));
      assert.isTrue(yield* isProtected(config.secretsDir));
      assert.isTrue(yield* isProtected(path.join(config.secretsDir, "new-key.bin")));
      assert.isTrue(yield* isProtected(path.join(config.baseDir, "studio-fleet.json")));
      assert.isTrue(yield* isProtected("userdata/secrets/anthropic-api-key.bin", config.baseDir));
      assert.isTrue(
        yield* isProtected(path.join(config.stateDir, "server-browser", "profiles", "Cookies")),
      );
      assert.isTrue(
        yield* isProtected(
          path.join(config.stateDir, "providers", "antigravity", "3f2a", "oauth_creds.json"),
        ),
        "an Antigravity instance's Google sign-in",
      );
      // Relative paths resolve against the request's folder only.
      assert.isFalse(yield* isProtected("userdata/secrets/anthropic-api-key.bin", config.stateDir));
      assert.isTrue(yield* isProtected("secrets/anthropic-api-key.bin", config.stateDir));

      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-ws-" });
      const fileLink = path.join(workspace, "notes.txt");
      yield* fileSystem.symlink(secret, fileLink);
      assert.isTrue(yield* isProtected(fileLink), "a link to a secret file");
      const dirLink = path.join(workspace, "keys");
      yield* fileSystem.symlink(config.secretsDir, dirLink);
      assert.isTrue(yield* isProtected(path.join(dirLink, "anthropic-api-key.bin")));
      const dangling = path.join(workspace, "planted.bin");
      yield* fileSystem.symlink(path.join(config.secretsDir, "planted.bin"), dangling);
      assert.isTrue(yield* isProtected(dangling), "a dangling link into the secrets folder");
      const fleetLink = path.join(workspace, "fleet.json");
      yield* fileSystem.symlink(path.join(config.baseDir, "studio-fleet.json"), fleetLink);
      assert.isTrue(yield* isProtected(fleetLink), "a link to the fleet file");

      // A home reached through a link protects the same folder.
      const aliasHome = path.join(workspace, "home-alias");
      yield* fileSystem.symlink(config.baseDir, aliasHome);
      assert.isTrue(
        yield* isProtected(path.join(aliasHome, "userdata", "secrets", "anthropic-api-key.bin")),
      );

      const platform = yield* HostProcessPlatform;
      if (platform === "darwin" || platform === "win32") {
        assert.isTrue(
          yield* isProtected(path.join(config.stateDir, "SECRETS", "anthropic-api-key.bin")),
          "another letter case of the same folder",
        );
      }

      // The rest of the data home stays readable.
      assert.isFalse(yield* isProtected(path.join(config.stateDir, "logs", "server.log")));
      assert.isFalse(yield* isProtected(path.join(config.stateDir, "settings.json")));
      assert.isFalse(yield* isProtected(path.join(config.stateDir, "secrets-notes.txt")));
      assert.isFalse(yield* isProtected(path.join(config.baseDir, "studio-fleet.json.md")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!tempVolumeFoldsCase)(
    "refuses other spellings the volume folds to the secrets folder",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, config, paths } = yield* homeLayout;
        const guard = makeAgentPathGuard(fileSystem, path, paths);
        for (const folder of ["SECRETS", "\u017Fecrets", "\u017FECRETS"]) {
          const alias = path.join(config.stateDir, folder, "anthropic-api-key.bin");
          assert.strictEqual(yield* fileSystem.readFileString(alias), "fake", folder);
          assert.isTrue(yield* guard.isProtected(alias), folder);
        }
        const fleet = path.join(config.baseDir, "\u017Ftudio-fleet.json");
        assert.isTrue(yield* guard.isProtected(fleet), "the fleet file spelled with U+017F");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a hard link to the fleet file or a secret by file identity", () =>
    Effect.gen(function* () {
      const { fileSystem, path, config, paths } = yield* homeLayout;
      const guard = makeAgentPathGuard(fileSystem, path, paths);
      const workspace = path.join(config.baseDir, "projects");
      yield* fileSystem.makeDirectory(workspace);
      const fleetLink = path.join(workspace, "notes.json");
      yield* fileSystem.link(path.join(config.baseDir, "studio-fleet.json"), fleetLink);
      const secretLink = path.join(workspace, "notes.bin");
      yield* fileSystem.link(path.join(config.secretsDir, "anthropic-api-key.bin"), secretLink);
      // Nothing about these spellings names a protected entry.
      assert.isTrue(yield* guard.isProtected(fleetLink), "a hard link to the fleet file");
      // Known gap: a hard link to one file inside a protected folder is not
      // recognised (only folders and the fleet file are compared by identity).
      // Only a shell command can create one, and shell is not covered anyway.
      assert.isFalse(yield* guard.isProtected(secretLink));
      assert.isFalse(yield* guard.isProtected(path.join(workspace, "other.json")));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("treats a folder that holds a protected entry as exposing it", () =>
    Effect.gen(function* () {
      const { fileSystem, path, config, paths } = yield* homeLayout;
      const guard = makeAgentPathGuard(fileSystem, path, paths);
      for (const folder of [config.stateDir, config.baseDir, path.dirname(config.baseDir)]) {
        assert.strictEqual(yield* guard.firstExposing([folder]), folder);
      }
      const alias = path.join(yield* fileSystem.makeTempDirectoryScoped(), "home");
      yield* fileSystem.symlink(config.baseDir, alias);
      assert.strictEqual(yield* guard.firstExposing([alias]), alias, "a link to the data home");
      const logs = path.join(config.stateDir, "logs");
      assert.isUndefined(yield* guard.firstExposing([logs, path.join(logs, "server.log")]));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("builds Claude deny rules from the configured paths", () =>
    Effect.gen(function* () {
      const { fileSystem, path, config } = yield* homeLayout;
      const deny = yield* claudeAgentSecretDenyForConfig({
        fileSystem,
        path,
        config,
        homeDir: config.baseDir,
      });
      const fleet = path.join(config.baseDir, "studio-fleet.json");
      for (const rule of [
        `Read(${claudeRulePath(config.secretsDir)})`,
        `Read(${claudeRulePath(config.secretsDir)}/**)`,
        `Edit(${claudeRulePath(config.secretsDir)}/**)`,
        `Read(${claudeRulePath(fleet)})`,
        `Edit(${claudeRulePath(fleet)})`,
        `Bash(*${config.secretsDir}/*)`,
        `Bash(*${config.secretsDir})`,
        `Bash(*${fleet}*)`,
        "Bash(*~/userdata/secrets/*)",
        "Bash(*$HOME/userdata/secrets)",
        `Read(${claudeRulePath(path.join(config.stateDir, "providers", "antigravity"))}/**)`,
        `Bash(*${path.join(config.stateDir, "providers", "antigravity")}/*)`,
        "Bash(*$HOME/studio-fleet.json*)",
        "Bash(*${HOME}/studio-fleet.json*)",
      ]) {
        assert.include(deny.rules, rule);
      }
      assert.isFalse(
        deny.rules.some((rule) => rule.startsWith("Write(")),
        "Claude Code matches file edits by Edit rules only",
      );
      assert.include(deny.sandboxPaths, config.secretsDir);
      assert.include(deny.sandboxPaths, fleet);
      assert.notInclude(deny.sandboxPaths, config.stateDir);
      assert.notInclude(deny.sandboxPaths, config.baseDir);
      assert.include(deny.sandboxPaths, path.join(config.stateDir, "providers", "antigravity"));
      assert.notInclude(deny.rules, `Bash(*${config.secretsDir}*)`, "would refuse siblings");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  // Known gap, recorded rather than hidden: Bash rules only refuse commands
  // that spell a protected path out. Claude's sandbox, when the user turns it
  // on, is what stops the rest at the filesystem.
  it.effect("Bash rules catch spelled-out paths and miss cd, globs and quoting (known gap)", () =>
    Effect.gen(function* () {
      const home = "/home/a";
      const rules = claudeAgentSecretDenyRules(
        yield* Path.Path,
        {
          directories: [`${home}/.specwithcode/userdata/secrets`],
          files: [`${home}/.specwithcode/studio-fleet.json`],
        },
        home,
      );
      // Claude matches a Bash rule as a glob over the whole command, `*` being any text.
      const bashPatterns = rules.flatMap((rule) => {
        const match = /^Bash\((.+)\)$/u.exec(rule);
        if (match === null) return [];
        const pattern = match[1]!
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
          .join(".*");
        return [new RegExp(`^${pattern}$`, "su")];
      });
      const refused = (command: string) => bashPatterns.some((pattern) => pattern.test(command));

      assert.isTrue(refused(`cat ${home}/.specwithcode/userdata/secrets/x.bin`));
      assert.isTrue(refused("cat ~/.specwithcode/userdata/secrets/x.bin"));
      assert.isTrue(refused("cat $HOME/.specwithcode/studio-fleet.json"));
      assert.isTrue(refused("cat ${HOME}/.specwithcode/studio-fleet.json"));
      assert.isTrue(refused("ls ~/.specwithcode/userdata/secrets"));
      assert.isTrue(
        refused("cp ~/.specwithcode/studio-fleet.json.bak /tmp"),
        "file rules match any suffix",
      );

      // A sibling of a protected folder is not refused.
      assert.isFalse(refused("ls ~/.specwithcode/userdata/secrets-backup"));
      assert.isFalse(refused(`cat ${home}/.specwithcode/userdata/secrets-old/x.bin`));

      // Not blocked by these rules: shell commands can still reach the files.
      assert.isFalse(refused("cd ~/.specwithcode/userdata && cat secrets/x.bin"));
      assert.isFalse(refused("cat ~/.specwithcode/userdata/secret?/x.bin"));
      assert.isFalse(refused('cat "$HOME"/.specwithcode/userdata/secrets/x.bin'));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("writes Windows drives as Claude absolute rule paths", () => {
    const rules = claudeAgentSecretDenyRules(
      {
        relative: () => "..",
        isAbsolute: () => true,
        join: (...parts: Array<string>) => parts.join("\\"),
        resolve: (part: string) => part,
        dirname: (part: string) => part,
        basename: (part: string) => part,
      } satisfies AgentPathOps,
      { directories: ["C:\\Users\\a\\.specwithcode\\userdata\\secrets"], files: [] },
      undefined,
    );
    assert.include(rules, "Read(//c/Users/a/.specwithcode/userdata/secrets/**)");
  });

  it("keeps existing settings rules while adding the deny rules", () => {
    const settings = withClaudeAgentSecretDenySettings(
      {
        enableWorkflows: true,
        permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm -rf:*)"] },
        sandbox: { enabled: true, filesystem: { denyRead: ["/etc/shadow"] } },
      },
      { rules: ["Read(//s/secrets/**)"], sandboxPaths: ["/s/secrets"] },
    );
    assert.deepEqual(settings.permissions?.allow, ["Bash(npm test)"]);
    assert.deepEqual(settings.permissions?.deny, ["Bash(rm -rf:*)", "Read(//s/secrets/**)"]);
    assert.equal(settings.sandbox?.enabled, true);
    assert.deepEqual(settings.sandbox?.filesystem?.denyRead, ["/etc/shadow", "/s/secrets"]);
    assert.deepEqual(settings.sandbox?.filesystem?.denyWrite, ["/s/secrets"]);
    assert.equal(settings.enableWorkflows, true);
  });
});

// @effect-diagnostics nodeBuiltinImport:off - the fake home must exist before the layer builds.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import { symlinksSupported } from "@specweave-studio/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSensitivePaths from "./WorkspaceSensitivePaths.ts";

// A private home and server base: these tests never look at the real ~/.specwithcode.
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-sensitive-reads-"));
const homeDir = NodePath.join(scratch, "home");
const baseDir = NodePath.join(scratch, "server-home");
const codexHome = NodePath.join(scratch, "codex-work");
NodeFS.mkdirSync(homeDir, { recursive: true });
afterAll(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));

// APFS (the macOS default) treats `S`, `s` and `ſ` (U+017F) as one letter; the
// spelling tests need a file system that does.
const probe = NodePath.join(scratch, "fold-probe-s");
NodeFS.writeFileSync(probe, "");
const foldsSpelling =
  NodeFS.existsSync(NodePath.join(scratch, "FOLD-PROBE-S")) &&
  NodeFS.existsSync(NodePath.join(scratch, "fold-probe-\u017f"));
const LONG_S = "\u017f";

// macOS shows the data volume again under /System/Volumes/Data (a firmlink);
// the native realpath keeps that prefix.
const DATA_VOLUME = "/System/Volumes/Data";
const viaDataVolume = (target: string) => `${DATA_VOLUME}${NodeFS.realpathSync.native(target)}`;
const dataVolumeFirmlink =
  process.platform === "darwin" &&
  NodeFS.existsSync(`${DATA_VOLUME}${NodeFS.realpathSync.native(scratch)}`);

// macOS volfs opens any file as /.vol/<device>/<inode>/...; no realpath resolves it.
// Only macOS has the folder.
const volfsAvailable = NodeFS.existsSync(`/.vol/${NodeFS.statSync(scratch).dev}/2`);
const viaVolfs = (target: string) => {
  const real = NodeFS.realpathSync.native(target);
  return `/.vol/${NodeFS.statSync(real).dev}/2${real}`;
};

const searchAll = (cwd: string, query: string, options: { limit?: number; regex?: boolean } = {}) =>
  Effect.gen(function* () {
    const entries = yield* WorkspaceEntries.WorkspaceEntries;
    return yield* entries.searchContents({
      cwd,
      query,
      limit: options.limit ?? 100,
      caseSensitive: true,
      wholeWord: false,
      useRegex: options.regex ?? false,
    });
  });

const write = (absolutePath: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
  NodeFS.writeFileSync(absolutePath, contents);
  return absolutePath;
};

const layerEntries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));
const layerTest = Layer.empty.pipe(
  Layer.provideMerge(
    WorkspaceFileSystem.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(layerEntries),
    ),
  ),
  Layer.provideMerge(layerEntries),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.ServerConfig.layerTest(scratch, baseDir)),
  Layer.provideMerge(Layer.succeed(WorkspaceSensitivePaths.SensitivePathsHomeDirectory, homeDir)),
  // Each test plants its own protected files, so identities are read fresh every time.
  Layer.provideMerge(Layer.succeed(WorkspaceSensitivePaths.SensitivePathsIdentityCacheMillis, 0)),
  Layer.provideMerge(Layer.succeed(HostProcessEnvironment, { CODEX_HOME: codexHome })),
  Layer.provideMerge(NodeServices.layer),
);

const read = (relativePath: string, cwd = scratch) =>
  Effect.gen(function* () {
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    return yield* files.readFile({ cwd, relativePath });
  });

const expectRefused = (relativePath: string, cwd = scratch) =>
  Effect.gen(function* () {
    const error = yield* read(relativePath, cwd).pipe(Effect.flip);
    expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
    expect(error).toMatchObject({ operation: "open", reason: "protected" });
    expect(error.message).not.toContain("sk-test-");
  });

const expectWriteRefused = (relativePath: string, cwd: string) =>
  Effect.gen(function* () {
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    const error = yield* files
      .writeFile({ cwd, relativePath, contents: "ssh-ed25519 AAAA attacker" })
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(WorkspaceFileSystem.WorkspaceFileSystemOperationError);
    expect(error).toMatchObject({ operation: "write-file", reason: "protected" });
  });

const writeTo = (relativePath: string, cwd: string) =>
  Effect.gen(function* () {
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    return yield* files.writeFile({ cwd, relativePath, contents: "written\n" });
  });

it.layer(layerTest, { excludeTestServices: true })("sensitive workspace paths", (it) => {
  describe("app homes anywhere in a path", () => {
    it.effect("refuses an instance home inside a checkout, for reads and writes", () =>
      Effect.gen(function* () {
        // ~/.specwithcode/m4/scratch/<project>/.specwithcode/userdata/... is a real layout.
        const checkout = NodePath.join(homeDir, ".specwithcode", "m4", "scratch", "x");
        const nestedState = NodePath.join(checkout, ".specwithcode", "userdata");
        yield* expectRefused(write(NodePath.join(nestedState, "secrets", "k.bin"), "sk-test-n"));
        yield* expectRefused(write(NodePath.join(nestedState, "settings.json"), "{}"));
        yield* expectWriteRefused(".specwithcode/userdata/secrets/k.bin", checkout);

        const worktree = NodePath.join(baseDir, "worktrees", "p", "b");
        const devSettings = write(
          NodePath.join(worktree, ".specwithcode", "dev", "settings.json"),
          "{}",
        );
        yield* expectRefused(devSettings);
        yield* expectRefused(".specwithcode/dev/settings.json", worktree);
        yield* expectWriteRefused(".specwithcode/dev/settings.json", worktree);
      }),
    );

    it.effect("keeps project folders named dev, userdata or backups usable", () =>
      Effect.gen(function* () {
        const projects = NodePath.join(baseDir, "projects");
        const readme = write(NodePath.join(projects, "dev", "README.md"), "# dev\n");
        expect((yield* read(readme)).contents).toBe("# dev\n");
        yield* writeTo("dev/NOTES.md", projects);
        const scratchFolder = NodePath.join(baseDir, "scratch");
        const backup = write(NodePath.join(scratchFolder, "backups", "x"), "kept\n");
        expect((yield* read(backup)).contents).toBe("kept\n");
        yield* writeTo("backups/y", scratchFolder);
        yield* writeTo("userdata/z.md", projects);
        expect(NodeFS.readFileSync(NodePath.join(projects, "userdata", "z.md"), "utf8")).toBe(
          "written\n",
        );
      }),
    );

    it.effect("refuses writes into the service runtime but still reads it", () =>
      Effect.gen(function* () {
        const runtimeFile = write(
          NodePath.join(baseDir, "runtime", "versions", "1.0.0", "bin.mjs"),
          "export {};\n",
        );
        expect((yield* read(runtimeFile)).contents).toBe("export {};\n");
        yield* expectWriteRefused("runtime/versions/1.0.0/bin.mjs", baseDir);
        yield* expectWriteRefused(
          "runtime/versions/1.0.0/bin.mjs",
          NodePath.join(homeDir, ".specwithcode", "m4"),
        );
      }),
    );
  });

  describe("readFile", () => {
    it.effect("refuses the server's secret store by absolute path", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* expectRefused(
          write(NodePath.join(config.secretsDir, "provider-openai.bin"), "sk-test-not-real"),
        );
      }),
    );

    it.effect("refuses other provider and git credential files", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* expectRefused(
          write(NodePath.join(homeDir, ".local", "share", "opencode", "auth.json"), "{}"),
        );
        yield* expectRefused(write(NodePath.join(homeDir, ".pi", "agent", "auth.json"), "{}"));
        yield* expectRefused(write(NodePath.join(homeDir, ".config", "git", "credentials"), "x"));
        const profiles = NodePath.join(homeDir, ".local", "share", "specweave", "account-profiles");
        yield* expectRefused(write(NodePath.join(profiles, "work", "codex", "auth.json"), "{}"));
        yield* expectRefused(write(NodePath.join(profiles, "work", ".credentials.json"), "{}"));
        const profileNote = write(NodePath.join(profiles, "work", "README.md"), "profile\n");
        expect((yield* read(profileNote)).contents).toBe("profile\n");
        // Terminal output and provider traffic logs need more than file access.
        yield* expectRefused(write(NodePath.join(config.terminalLogsDir, "t1.log"), "$ ls\n"));
        yield* expectRefused(write(NodePath.join(config.providerLogsDir, "events.log"), "{}"));
      }),
    );

    it.effect("refuses settings.json, the live database and studio-fleet.json", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* expectRefused(write(config.settingsPath, '{"token":"sk-test-settings"}'));
        yield* expectRefused(write(`${config.dbPath}-wal`, "wal"));
        yield* expectRefused(write(NodePath.join(baseDir, "studio-fleet.json"), "{}"));
      }),
    );

    it.effect("refuses the whole state folder except the readable subfolders", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const state = config.stateDir;
        yield* expectRefused(write(NodePath.join(state, "backup-20261018", "settings.json"), "{}"));
        yield* expectRefused(write(NodePath.join(state, "connections", "backups", "a.json"), "{}"));
        yield* expectRefused(
          write(NodePath.join(state, "providers", "codex", "i1", "shadow", "auth.json"), "{}"),
        );
        yield* expectRefused(
          write(NodePath.join(state, "browser-extension", "pairing.json"), "{}"),
        );
        yield* expectRefused(write(NodePath.join(state, "remote-workers.json"), "{}"));
        // What clients do open there stays readable.
        const log = write(NodePath.join(config.logsDir, "note.txt"), "log line\n");
        expect((yield* read(log)).contents).toBe("log line\n");
        const attachment = write(NodePath.join(config.attachmentsDir, "notes.md"), "attached\n");
        expect((yield* read(attachment)).contents).toBe("attached\n");
      }),
    );

    it.effect("refuses sibling installs and their backups under ~/.specwithcode", () =>
      Effect.gen(function* () {
        const appRoot = NodePath.join(homeDir, ".specwithcode");
        const stage = NodePath.join(appRoot, "stage");
        yield* expectRefused(
          write(NodePath.join(stage, "userdata", "secrets", "k.bin"), "sk-test-stage"),
        );
        yield* expectRefused(write(NodePath.join(stage, "userdata", "settings.json"), "{}"));
        yield* expectRefused(write(NodePath.join(stage, "dev", "statev2.sqlite-wal"), "wal"));
        yield* expectRefused(write(NodePath.join(stage, "studio-fleet.json"), "{}"));
        yield* expectRefused(write(NodePath.join(appRoot, "studio-fleet.json"), "{}"));
        yield* expectRefused(
          write(NodePath.join(appRoot, "backups", "pre-abc-20261018", "settings.json"), "{}"),
        );
        yield* expectRefused(
          write(NodePath.join(stage, "runtime", "db-backup", "u1", "statev2.sqlite"), "db"),
        );
        yield* expectRefused(
          write(NodePath.join(homeDir, ".specweave-studio", "userdata", "settings.json"), "{}"),
        );
        // Project checkouts in a sibling home, even one named "dev", stay readable.
        const checkout = write(
          NodePath.join(stage, "worktrees", "dev", "userdata", "README.md"),
          "# Project\n",
        );
        expect((yield* read(checkout)).contents).toBe("# Project\n");
      }),
    );

    it.effect("refuses credential files in the home, including ~/.ssh", () =>
      Effect.gen(function* () {
        yield* expectRefused(write(NodePath.join(homeDir, ".ssh", "id_ed25519"), "PRIVATE KEY"));
        yield* expectRefused(write(NodePath.join(homeDir, ".codex", "auth.json"), "{}"));
        yield* expectRefused(write(NodePath.join(homeDir, ".grok", "auth.json"), "{}"));
        yield* expectRefused(write(NodePath.join(homeDir, ".npmrc"), "//registry:_authToken=x"));
        yield* expectRefused(write(NodePath.join(homeDir, ".config", "gh", "hosts.yml"), "x"));
        yield* expectRefused(
          write(NodePath.join(homeDir, ".config", "glab-cli", "config.yml"), "token: x"),
        );
        yield* expectRefused(
          write(NodePath.join(homeDir, ".local", "share", "forgejo-cli", "keys.json"), "{}"),
        );
        yield* expectRefused(
          write(
            NodePath.join(homeDir, "Library", "Application Support", "glab-cli", "config.yml"),
            "token: x",
          ),
        );
        yield* expectRefused(write(NodePath.join(homeDir, ".config", "tea", "config.yml"), "x"));
      }),
    );

    it.effect("refuses provider credentials in a home moved by the server's environment", () =>
      Effect.gen(function* () {
        yield* expectRefused(write(NodePath.join(codexHome, "auth.json"), "{}"));
        const config = write(NodePath.join(codexHome, "config.toml"), 'model = "x"\n');
        expect((yield* read(config)).contents).toBe('model = "x"\n');
      }),
    );

    it.effect("refuses a credential file named relative to a workspace root", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        write(NodePath.join(config.secretsDir, "relative.bin"), "sk-test-relative");
        yield* expectRefused("secrets/relative.bin", config.stateDir);
        write(NodePath.join(homeDir, ".ssh", "config"), "Host *");
        yield* expectRefused(".ssh/config", homeDir);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("refuses a symlink that points at a secret", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const secret = write(NodePath.join(config.secretsDir, "linked.bin"), "sk-test-linked");
        const outsideLink = NodePath.join(scratch, "report-link.md");
        NodeFS.symlinkSync(secret, outsideLink);
        // With the home as the workspace root the link stays inside the root, so only
        // the protected-path check stands between the client and the key.
        NodeFS.symlinkSync(NodePath.join(homeDir, ".ssh"), NodePath.join(homeDir, "keys"));
        write(NodePath.join(homeDir, ".ssh", "id_rsa"), "PRIVATE KEY");

        yield* expectRefused(outsideLink);
        yield* expectRefused("keys/id_rsa", homeDir);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a protected path that became a symlink after the guard was built",
      () =>
        Effect.gen(function* () {
          // ~/.aws did not exist when the layer started; it now points elsewhere, so
          // its realpath is outside every protected folder. The requested path is not.
          const elsewhere = NodePath.join(scratch, "elsewhere-aws");
          write(NodePath.join(elsewhere, "credentials"), "aws_secret_access_key=sk-test-aws");
          NodeFS.symlinkSync(elsewhere, NodePath.join(homeDir, ".aws"));

          yield* expectRefused(NodePath.join(homeDir, ".aws", "credentials"));
          yield* expectRefused(".aws/credentials", homeDir);
        }),
    );

    it.effect.skipIf(!foldsSpelling)(
      "refuses other spellings of protected paths where the file system folds them",
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          write(NodePath.join(homeDir, ".ssh", "id_rsa"), "PRIVATE KEY sk-test-ssh");
          write(NodePath.join(config.secretsDir, "spelled.bin"), "sk-test-spelled");
          write(config.settingsPath, '{"key":"sk-test-settings"}');
          const checkout = NodePath.join(homeDir, "code", "spelled");
          write(NodePath.join(checkout, ".specwithcode", "userdata", "settings.json"), "{}");

          yield* expectRefused(NodePath.join(homeDir, `.${LONG_S}sh`, "id_rsa"));
          yield* expectRefused(NodePath.join(homeDir, ".SSH", "ID_RSA"));
          yield* expectRefused(`.${LONG_S}sh/id_rsa`, homeDir);
          yield* expectRefused(`.Ssh/id_rsa`, homeDir);
          yield* expectRefused(`${LONG_S}ecrets/spelled.bin`, config.stateDir);
          yield* expectRefused("SECRETS/spelled.bin", config.stateDir);
          yield* expectRefused(`${LONG_S}ettings.json`, config.stateDir);
          yield* expectRefused(`.${LONG_S}pecwithcode/userdata/settings.json`, checkout);
          yield* expectRefused(".SPECWITHCODE/USERDATA/settings.json", checkout);
        }),
    );

    it.effect("refuses a hard link to a protected file", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const secret = write(NodePath.join(config.secretsDir, "linked.bin"), "sk-test-hard");
        const key = write(NodePath.join(homeDir, ".ssh", "id_hard"), "PRIVATE KEY sk-test-k");
        const project = NodePath.join(scratch, "hard-link-project");
        NodeFS.mkdirSync(project, { recursive: true });
        NodeFS.linkSync(secret, NodePath.join(project, "notes.txt"));
        NodeFS.linkSync(key, NodePath.join(project, "key.txt"));
        NodeFS.linkSync(config.settingsPath, NodePath.join(project, "settings-copy.json"));

        yield* expectRefused("notes.txt", project);
        yield* expectRefused("key.txt", project);
        yield* expectRefused(NodePath.join(project, "settings-copy.json"));
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const error = yield* files
          .writeFile({ cwd: project, relativePath: "key.txt", contents: "replaced\n" })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ operation: "write-file" });
        expect(NodeFS.readFileSync(key, "utf8")).toBe("PRIVATE KEY sk-test-k");
      }),
    );

    it.effect("still reads an ordinary temp file and project-relative files", () =>
      Effect.gen(function* () {
        const report = write(NodePath.join(scratch, "tmp", "cleanup-report.md"), "# Report\n");
        expect((yield* read(report)).contents).toBe("# Report\n");

        const project = NodePath.join(scratch, "project");
        write(NodePath.join(project, "src", "index.ts"), "export {};\n");
        // A project's own .npmrc is not the home one.
        write(NodePath.join(project, ".npmrc"), "save-exact=true\n");
        expect((yield* read("src/index.ts", project)).contents).toBe("export {};\n");
        expect((yield* read(".npmrc", project)).contents).toBe("save-exact=true\n");

        const notes = write(NodePath.join(homeDir, "notes.md"), "hello\n");
        expect((yield* read(notes)).contents).toBe("hello\n");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("refuses ~/.ssh/authorized_keys and the app's settings.json", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        yield* expectWriteRefused(".ssh/authorized_keys", homeDir);
        yield* expectWriteRefused("settings.json", config.stateDir);
        // Writes get no state subfolder exception: a mod written there could run.
        yield* expectWriteRefused("mods/evil/mod.json", config.stateDir);
        expect(NodeFS.existsSync(NodePath.join(homeDir, ".ssh", "authorized_keys"))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(config.stateDir, "mods", "evil"))).toBe(false);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses writes through a symlinked folder or a dangling symlinked file",
      () =>
        Effect.gen(function* () {
          const project = NodePath.join(scratch, "write-project");
          NodeFS.mkdirSync(project, { recursive: true });
          NodeFS.symlinkSync(NodePath.join(homeDir, ".ssh"), NodePath.join(project, "ssh-dir"));
          NodeFS.symlinkSync(
            NodePath.join(homeDir, ".ssh", "authorized_keys"),
            NodePath.join(project, "keys.txt"),
          );

          yield* expectWriteRefused("ssh-dir/authorized_keys", project);
          yield* expectWriteRefused("keys.txt", project);
          expect(NodeFS.existsSync(NodePath.join(homeDir, ".ssh", "authorized_keys"))).toBe(false);
        }),
    );

    it.effect("refuses writes to files that start programs, but still reads them", () =>
      Effect.gen(function* () {
        const zshrc = write(NodePath.join(homeDir, ".zshrc"), "export PATH\n");
        expect((yield* read(zshrc)).contents).toBe("export PATH\n");
        for (const relativePath of [
          ".zshrc",
          ".bash_profile",
          ".gitconfig",
          ".config/git/config",
          ".codex/config.toml",
          ".claude/settings.json",
          ".claude/settings.local.json",
          "Library/LaunchAgents/com.example.agent.plist",
          ".config/autostart/x.desktop",
          ".bash_login",
          ".zlogout",
          ".config/fish/config.fish",
          ".config/environment.d/10-path.conf",
        ]) {
          yield* expectWriteRefused(relativePath, homeDir);
        }
        yield* expectWriteRefused("config.toml", codexHome);
        expect(NodeFS.readFileSync(zshrc, "utf8")).toBe("export PATH\n");
        // Other files in a provider home stay writable, such as an instructions file.
        yield* writeTo(".claude/CLAUDE.md", homeDir);
      }),
    );

    it.effect.skipIf(!foldsSpelling)("refuses writes to other spellings of protected paths", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        NodeFS.mkdirSync(NodePath.join(homeDir, ".ssh"), { recursive: true });
        NodeFS.mkdirSync(config.secretsDir, { recursive: true });
        const checkout = NodePath.join(homeDir, "code", "spelled-write");
        NodeFS.mkdirSync(NodePath.join(checkout, ".specwithcode", "userdata"), {
          recursive: true,
        });

        yield* expectWriteRefused(`.${LONG_S}sh/authorized_keys`, homeDir);
        yield* expectWriteRefused(".SSH/authorized_keys", homeDir);
        yield* expectWriteRefused(`${LONG_S}ecrets/planted.bin`, config.stateDir);
        yield* expectWriteRefused("Secrets/planted.bin", config.stateDir);
        yield* expectWriteRefused(`${LONG_S}ettings.json`, config.stateDir);
        yield* expectWriteRefused(`.${LONG_S}pecwithcode/userdata/settings.json`, checkout);
        yield* expectWriteRefused(".SpecWithCode/userdata/settings.json", checkout);
        yield* expectWriteRefused(`.z${LONG_S}hrc`, homeDir);
        // ~/.zshenv does not exist, so no realpath can correct the spelling; zsh
        // would still open the planted file as ~/.zshenv.
        expect(NodeFS.existsSync(NodePath.join(homeDir, ".zshenv"))).toBe(false);
        yield* expectWriteRefused(`.z${LONG_S}henv`, homeDir);
        expect(NodeFS.existsSync(NodePath.join(homeDir, ".zshenv"))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(homeDir, ".ssh", "authorized_keys"))).toBe(false);
        expect(NodeFS.existsSync(NodePath.join(config.secretsDir, "planted.bin"))).toBe(false);
      }),
    );

    it.effect("refuses a write when a path on the way exists but cannot be resolved", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const project = NodePath.join(scratch, "unresolvable-write");
        NodeFS.mkdirSync(NodePath.join(project, "docs"), { recursive: true });
        // What macOS volfs does: realpath says ENOENT for a folder that is there.
        const realpathMissing =
          (fails: (target: string) => boolean) =>
          (target: string): Promise<string> =>
            fails(target)
              ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))
              : WorkspaceSensitivePaths.realpathNative(target);

        const error = yield* files
          .writeFile({ cwd: project, relativePath: "docs/a.md", contents: "x\n" })
          .pipe(
            Effect.provideService(
              WorkspaceSensitivePaths.SensitivePathsRealpath,
              realpathMissing((target) => target === NodePath.join(project, "docs")),
            ),
            Effect.flip,
          );
        expect(error).toMatchObject({ operation: "write-file" });
        expect(NodeFS.existsSync(NodePath.join(project, "docs", "a.md"))).toBe(false);

        // A folder that really is missing is skipped over and created.
        yield* files.writeFile({ cwd: project, relativePath: "fresh/a.md", contents: "ok\n" }).pipe(
          Effect.provideService(
            WorkspaceSensitivePaths.SensitivePathsRealpath,
            realpathMissing((target) => target === NodePath.join(project, "fresh")),
          ),
        );
        expect(NodeFS.readFileSync(NodePath.join(project, "fresh", "a.md"), "utf8")).toBe("ok\n");
      }),
    );

    it.effect.skipIf(!volfsAvailable)("refuses every path under /.vol on macOS", () =>
      Effect.gen(function* () {
        const zshrc = write(NodePath.join(homeDir, ".zshrc"), "export PATH\n");
        write(NodePath.join(homeDir, "notes.txt"), "plain\n");
        const home = viaVolfs(homeDir);
        for (const relativePath of [
          ".zshrc",
          "Library/LaunchAgents/com.example.agent.plist",
          ".claude/settings.json",
          "notes.txt",
        ]) {
          yield* expectWriteRefused(relativePath, home);
        }
        yield* expectRefused("notes.txt", home);
        yield* expectRefused(NodePath.join(home, "notes.txt"));
        expect(NodeFS.readFileSync(zshrc, "utf8")).toBe("export PATH\n");
        expect(NodeFS.existsSync(NodePath.join(homeDir, "Library", "LaunchAgents"))).toBe(false);
      }),
    );

    it.effect("still writes ordinary project files", () =>
      Effect.gen(function* () {
        const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
        const project = NodePath.join(scratch, "write-ok");
        NodeFS.mkdirSync(project, { recursive: true });
        yield* files.writeFile({ cwd: project, relativePath: "docs/a.md", contents: "ok\n" });
        expect(NodeFS.readFileSync(NodePath.join(project, "docs", "a.md"), "utf8")).toBe("ok\n");
      }),
    );
  });

  describe("searchContents", () => {
    it.effect("drops matches inside protected files", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        write(NodePath.join(config.secretsDir, "search.bin"), "needle-sk-test\n");
        write(config.settingsPath, '{"needle":"sk-test"}\n');
        write(NodePath.join(config.logsDir, "plain.txt"), "needle here\n");

        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* entries.searchContents({
          cwd: config.stateDir,
          query: "needle",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches.map((match) => match.path)).toEqual(["logs/plain.txt"]);
      }),
    );

    it.effect.skipIf(!foldsSpelling)(
      "drops matches when the root names a protected folder in another spelling",
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          write(NodePath.join(config.secretsDir, "spelled-search.bin"), "spelledneedle sk-test\n");
          write(NodePath.join(homeDir, ".ssh", "id_search"), "spelledneedle PRIVATE KEY\n");
          const entries = yield* WorkspaceEntries.WorkspaceEntries;
          const search = (cwd: string) =>
            entries.searchContents({
              cwd,
              query: "spelledneedle",
              limit: 100,
              caseSensitive: false,
              wholeWord: false,
              useRegex: false,
            });
          const stateParent = NodePath.dirname(config.secretsDir);
          for (const cwd of [
            NodePath.join(stateParent, `${LONG_S}ecrets`),
            NodePath.join(stateParent, "SECRETS"),
            NodePath.join(homeDir, `.${LONG_S}sh`),
            NodePath.join(homeDir, ".SSH"),
          ]) {
            expect((yield* search(cwd)).matches).toEqual([]);
          }
        }),
    );

    it.effect("drops matches inside a hard link to a protected file", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const secret = write(
          NodePath.join(config.secretsDir, "hard-search.bin"),
          "hardneedle sk-test\n",
        );
        const project = NodePath.join(scratch, "hard-link-search");
        write(NodePath.join(project, "src", "a.ts"), "// hardneedle in a project file\n");
        NodeFS.linkSync(secret, NodePath.join(project, "notes.txt"));

        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* entries.searchContents({
          cwd: project,
          query: "hardneedle",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches.map((match) => match.path)).toEqual(["src/a.ts"]);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("drops matches reached through links to secrets", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        write(NodePath.join(config.secretsDir, "linked-search.bin"), "haystack-sk-test\n");
        const project = NodePath.join(scratch, "search-link-project");
        write(NodePath.join(project, "src", "a.ts"), "// no match here\n");
        NodeFS.symlinkSync(config.secretsDir, NodePath.join(project, "link"));
        NodeFS.symlinkSync(
          NodePath.join(config.secretsDir, "linked-search.bin"),
          NodePath.join(project, "linked-file.txt"),
        );

        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        const result = yield* entries.searchContents({
          cwd: project,
          query: "haystack",
          limit: 100,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });

        expect(result.matches).toEqual([]);
      }),
    );
  });

  describe("other names for protected paths", () => {
    it.effect.skipIf(!dataVolumeFirmlink)(
      "refuses paths through the macOS data-volume firmlink",
      () =>
        Effect.gen(function* () {
          const key = write(NodePath.join(homeDir, ".ssh", "id_firm"), "firmneedle PRIVATE KEY");
          write(NodePath.join(homeDir, ".codex", "auth.json"), '{"firmneedle":"sk-test"}');
          write(NodePath.join(homeDir, ".npmrc"), "firmneedle //registry:_authToken=x");
          write(NodePath.join(homeDir, "firm-notes.md"), "firmneedle in notes\n");

          yield* expectRefused(viaDataVolume(key));
          yield* expectRefused(viaDataVolume(NodePath.join(homeDir, ".codex", "auth.json")));
          yield* expectRefused(viaDataVolume(NodePath.join(homeDir, ".npmrc")));
          yield* expectRefused(".ssh/id_firm", viaDataVolume(homeDir));
          yield* expectWriteRefused(".ssh/authorized_keys", viaDataVolume(homeDir));
          expect(NodeFS.existsSync(NodePath.join(homeDir, ".ssh", "authorized_keys"))).toBe(false);

          const fromHome = yield* searchAll(viaDataVolume(homeDir), "firmneedle");
          expect(fromHome.matches.map((match) => match.path)).toEqual(["firm-notes.md"]);
          const fromKeys = yield* searchAll(viaDataVolume(NodePath.join(homeDir, ".ssh")), "firm");
          expect(fromKeys).toEqual({ matches: [], truncated: false });
        }),
    );

    it.effect("gives the same search result whether a protected file matches or not", () =>
      Effect.gen(function* () {
        // A key the search can see, as a control: an unprotected copy finds it.
        const control = NodePath.join(scratch, "oracle-control");
        write(NodePath.join(control, "keys", "id_oracle"), "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n");
        const config = yield* ServerConfig.ServerConfig;
        write(NodePath.join(config.secretsDir, "oracle.txt"), "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n");
        // Readable files that sort after the secret store, so its match comes first.
        write(NodePath.join(config.stateDir, "themes", "oracle-a.txt"), "github.com ssh-rsa\n");
        write(NodePath.join(config.stateDir, "themes", "oracle-b.txt"), "github.com again\n");
        const home = homeDir;
        write(NodePath.join(home, ".ssh", "id_oracle"), "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n");

        const entries = yield* WorkspaceEntries.WorkspaceEntries;
        for (const cwd of [home, config.stateDir]) {
          // Earlier tests indexed these roots; pick up the files written here.
          yield* entries.refresh(cwd);
          for (const limit of [1, 2, 100]) {
            const ask = (prefix: string) =>
              searchAll(cwd, `^${prefix}|^github\\.com`, { limit, regex: true });
            const hit = yield* ask("b3BlbnNzaC1rZXktdjEAAAAAB");
            const miss = yield* ask("b3BlbnNzaC1rZXktdjEAAAAAZ");
            expect(hit).toEqual(miss);
          }
        }
        // A root inside a refused folder is not searched at all.
        expect(yield* searchAll(NodePath.join(home, ".ssh"), "b3BlbnNzaC")).toEqual({
          matches: [],
          truncated: false,
        });
        expect(yield* searchAll(config.secretsDir, "b3BlbnNzaC")).toEqual({
          matches: [],
          truncated: false,
        });
        expect((yield* searchAll(control, "b3BlbnNzaC")).matches).toHaveLength(1);
      }),
    );
  });

  describe("machine handoff worktrees", () => {
    it.effect("keeps a received worktree under the state folder a usable project", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const handoffs = NodePath.join(config.stateDir, "machine-handoffs");
        const workspace = NodePath.join(handoffs, "git", "op-1", "workspace");
        write(NodePath.join(workspace, "src", "a.ts"), "export const handoff = 1;\n");

        expect((yield* read("src/a.ts", workspace)).contents).toBe("export const handoff = 1;\n");
        yield* writeTo("src/b.ts", workspace);
        expect(NodeFS.readFileSync(NodePath.join(workspace, "src", "b.ts"), "utf8")).toBe(
          "written\n",
        );
        const found = yield* searchAll(workspace, "handoff");
        expect(found.matches.map((match) => match.path)).toEqual(["src/a.ts"]);

        // The retained context the launch prompt links may be read, not written.
        const context = write(NodePath.join(handoffs, "context-op-1"), '{"intent":"x"}');
        expect((yield* read(context)).contents).toBe('{"intent":"x"}');
        yield* expectWriteRefused("context-op-1", handoffs);
        // Other handoff records stay refused.
        yield* expectRefused(write(NodePath.join(handoffs, "op-1.json"), '{"k":"sk-test-h"}'));
        yield* expectWriteRefused("git/op-1.json", handoffs);
      }),
    );
  });

  describe("git metadata", () => {
    it.effect("refuses writes that would make git run a program", () =>
      Effect.gen(function* () {
        const project = NodePath.join(scratch, "git-meta-project");
        write(NodePath.join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
        for (const relativePath of [
          ".git/config",
          ".git/hooks/pre-commit",
          ".git/hooks/nested/x",
          ".git/info/attributes",
          ".git/info/exclude",
          ".git/HEAD",
          ".git/modules/sub/config",
          ".git/worktrees/wt/config.worktree",
          // A linked worktree's pointers: rewritten, they send git to a planted repository.
          ".git/worktrees/wt/commondir",
          ".git/worktrees/wt/gitdir",
          ".git",
          "sub/.git",
          "sub/.git/config",
          // Case-insensitive file systems open .GIT as .git.
          ...(process.platform === "darwin" || process.platform === "win32"
            ? [".GIT/config", ".Git", "sub/.GIT"]
            : []),
        ]) {
          yield* expectWriteRefused(relativePath, project);
        }
        expect(NodeFS.existsSync(NodePath.join(project, ".git", "config"))).toBe(false);
        expect(NodeFS.readFileSync(NodePath.join(project, ".git", "HEAD"), "utf8")).toBe(
          "ref: refs/heads/main\n",
        );

        // A linked worktree's `.git` file cannot be pointed at a planted git folder.
        const worktree = NodePath.join(scratch, "git-meta-worktree");
        write(NodePath.join(worktree, ".git"), `gitdir: ${NodePath.join(project, ".git")}\n`);
        yield* expectWriteRefused(".git", worktree);
        expect(NodeFS.readFileSync(NodePath.join(worktree, ".git"), "utf8")).toBe(
          `gitdir: ${NodePath.join(project, ".git")}\n`,
        );
        // Nor reached through a symlinked folder.
        if (symlinksSupported) {
          NodeFS.symlinkSync(NodePath.join(project, ".git"), NodePath.join(worktree, "meta"));
          yield* expectWriteRefused("meta/config", worktree);
          expect(NodeFS.existsSync(NodePath.join(project, ".git", "config"))).toBe(false);
        }
        // Reads of git metadata and ordinary files named like it are unaffected.
        expect((yield* read(".git/HEAD", project)).contents).toBe("ref: refs/heads/main\n");
        yield* writeTo("config", project);
        yield* writeTo("docs/hooks/readme.md", project);
        yield* writeTo(".github/config", project);
      }),
    );
  });

  describe("identity backstop", () => {
    it.effect("refuses hard links to backups, the fleet file, protected logs and profiles", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const state = config.stateDir;
        const protectedFiles = [
          write(NodePath.join(baseDir, "backups", "statev2-1.sqlite"), "sk-test-backup"),
          write(NodePath.join(baseDir, "runtime", "db-backup", "statev2.sqlite"), "sk-test-db"),
          write(NodePath.join(baseDir, "studio-fleet.json"), '{"token":"sk-test-fleet"}'),
          write(NodePath.join(state, "logs", "terminals", "t1.log"), "sk-test-terminal"),
          write(NodePath.join(state, "logs", "provider", "p1.log"), "sk-test-provider"),
          write(NodePath.join(state, "composer-drafts", "d1.json"), "sk-test-draft"),
          write(NodePath.join(state, "server-browser", "profiles", "Cookies"), "sk-test-cookie"),
          write(NodePath.join(state, "remote-workers.json"), "sk-test-workers"),
          write(
            NodePath.join(homeDir, ".specwithcode", "stage", "userdata", "secrets", "k.bin"),
            "sk-test-stage",
          ),
          write(
            NodePath.join(homeDir, ".specwithcode", "stage", "backups", "settings.json"),
            "sk-test-stage-backup",
          ),
          write(
            NodePath.join(
              homeDir,
              ".local",
              "share",
              "specweave",
              "account-profiles",
              "codex",
              "work",
              "auth.json",
            ),
            "sk-test-profile",
          ),
        ];
        const project = NodePath.join(scratch, "identity-backstop-project");
        NodeFS.mkdirSync(project, { recursive: true });
        for (const [index, protectedFile] of protectedFiles.entries()) {
          const name = `linked-${index}.txt`;
          NodeFS.linkSync(protectedFile, NodePath.join(project, name));
          yield* expectRefused(name, project);
          yield* expectRefused(NodePath.join(project, name));
        }
        const result = yield* searchAll(project, "sk-test-");
        expect(result.matches).toEqual([]);
      }),
    );

    it.effect("refuses writes through hard links to files that run code, but reads them", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const writeOnly = [
          write(NodePath.join(homeDir, ".zshrc"), "export PATH\n"),
          write(NodePath.join(homeDir, "Library", "LaunchAgents", "com.example.plist"), "<plist/>"),
          write(NodePath.join(homeDir, ".config", "autostart", "x.desktop"), "[Desktop Entry]"),
          write(NodePath.join(homeDir, ".claude", "settings.json"), "{}"),
          write(NodePath.join(codexHome, "config.toml"), "model = 'x'"),
          write(NodePath.join(homeDir, ".specwithcode", "m4", "launch.sh"), "#!/bin/sh"),
          write(NodePath.join(homeDir, ".specwithcode", "m4", "installation.json"), "{}"),
          write(NodePath.join(baseDir, "install", "updater.sh"), "#!/bin/sh"),
          write(NodePath.join(baseDir, "runtime", "versions", "1", "server.mjs"), "run()"),
          write(NodePath.join(homeDir, ".local", "bin", "specwithcode-m4"), "#!/bin/sh"),
          write(
            NodePath.join(homeDir, ".local", "share", "specweave", "providers", "codex", "codex"),
            "#!/bin/sh",
          ),
          write(NodePath.join(config.stateDir, "attachments", "a.txt"), "attached"),
        ];
        const project = NodePath.join(scratch, "write-identity-project");
        NodeFS.mkdirSync(project, { recursive: true });
        for (const [index, target] of writeOnly.entries()) {
          const name = `linked-${index}.txt`;
          const before = NodeFS.readFileSync(target, "utf8");
          NodeFS.linkSync(target, NodePath.join(project, name));
          yield* expectWriteRefused(name, project);
          expect(NodeFS.readFileSync(target, "utf8")).toBe(before);
          expect((yield* read(name, project)).contents).toBe(before);
        }
        yield* writeTo("plain.txt", project);
      }),
    );

    it.effect.skipIf(!dataVolumeFirmlink)(
      "recognises a write-only folder under another name by its identity",
      () =>
        Effect.gen(function* () {
          const guard = yield* WorkspaceSensitivePaths.sensitivePathGuard;
          const agents = NodePath.join(homeDir, "Library", "LaunchAgents");
          NodeFS.mkdirSync(agents, { recursive: true });
          const planted = NodePath.join(viaDataVolume(agents), "planted.plist");
          expect(
            yield* Effect.promise(() =>
              guard.matchesProtectedIdentity(planted, new Map(), "write"),
            ),
          ).toBe(true);
          expect(yield* Effect.promise(() => guard.matchesProtectedIdentity(planted))).toBe(false);
        }),
    );

    it.effect.skipIf(!dataVolumeFirmlink)(
      "recognises a protected folder under another name by its identity",
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const guard = yield* WorkspaceSensitivePaths.sensitivePathGuard;
          const backup = write(NodePath.join(baseDir, "backups", "alias.sqlite"), "x");
          const terminalLog = write(NodePath.join(config.stateDir, "logs", "terminals", "a"), "x");
          const draft = write(NodePath.join(config.stateDir, "composer-drafts", "a.json"), "x");
          const readableLog = write(NodePath.join(config.logsDir, "alias.txt"), "x");
          // The identity check alone, without the name rules that strip the prefix.
          for (const target of [backup, terminalLog, draft]) {
            expect(
              yield* Effect.promise(() => guard.matchesProtectedIdentity(viaDataVolume(target))),
            ).toBe(true);
          }
          expect(
            yield* Effect.promise(() => guard.matchesProtectedIdentity(viaDataVolume(readableLog))),
          ).toBe(false);
        }),
    );
  });

  describe("Antigravity's temp folder", () => {
    it.effect("reads files the agent left there but never writes them", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const report = write(
          NodePath.join(config.stateDir, "antigravity-tmp", "0123456789ab", "report.md"),
          "# report\n",
        );
        expect((yield* read(report)).contents).toBe("# report\n");
        yield* expectWriteRefused("antigravity-tmp/0123456789ab/report.md", config.stateDir);
        expect(NodeFS.readFileSync(report, "utf8")).toBe("# report\n");
      }),
    );
  });

  describe("files the service runs", () => {
    it.effect(
      "refuses writes to launchers, installer records, the release store and CLI wrappers",
      () =>
        Effect.gen(function* () {
          const appRoot = NodePath.join(homeDir, ".specwithcode");
          const identityHome = NodePath.join(appRoot, "m4");
          const launcher = write(NodePath.join(identityHome, "launch.sh"), "#!/bin/sh\n");
          write(NodePath.join(identityHome, "installation.json"), "{}");
          write(NodePath.join(appRoot, "installation.json"), "{}");
          write(NodePath.join(appRoot, "install", "updater", "update_agent.py"), "");
          yield* expectWriteRefused("launch.sh", identityHome);
          yield* expectWriteRefused("installation.json", identityHome);
          yield* expectWriteRefused("installation.json", appRoot);
          yield* expectWriteRefused("launch.sh", appRoot);
          yield* expectWriteRefused("install/updater/update_agent.py", appRoot);
          yield* expectWriteRefused("install/releases/abc/bin.mjs", appRoot);
          yield* expectWriteRefused(
            "specweave/providers/codex/bin/codex",
            NodePath.join(homeDir, ".local", "share"),
          );
          yield* expectWriteRefused(
            "specweave-studio/releases/x",
            NodePath.join(homeDir, ".local", "share"),
          );
          const bin = NodePath.join(homeDir, ".local", "bin");
          for (const name of [
            "specwithcode",
            "specweave-studio",
            "specwithcode-m4",
            "specweave-studio-m4",
          ]) {
            yield* expectWriteRefused(name, bin);
          }
          yield* writeTo("other-tool", bin);
          yield* expectWriteRefused("mcp.json", NodePath.join(homeDir, ".cursor"));
          const mcp = write(NodePath.join(homeDir, ".cursor", "mcp.json"), '{"mcpServers":{}}');
          expect((yield* read(mcp)).contents).toBe('{"mcpServers":{}}');
          // Reading what the service runs is fine.
          expect((yield* read(launcher)).contents).toBe("#!/bin/sh\n");
          expect(NodeFS.readFileSync(launcher, "utf8")).toBe("#!/bin/sh\n");
        }),
    );
  });

  describe("agent output under the state folder's provider homes", () => {
    it.effect("reads Antigravity plans and Codex transcripts but not the profiles' sign-ins", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const profile = NodePath.join(config.stateDir, "providers", "antigravity", "ab12cd");
        const session = "5f0c3a52-8a51-4c1e-9d1e-0c4c2b7d9e11";
        const plan = write(
          NodePath.join(profile, "antigravity-acp", "brain", session, "implementation_plan.md"),
          "# Plan\n",
        );
        const shadow = NodePath.join(config.stateDir, "providers", "codex", "work", "shadow");
        const transcript = write(
          NodePath.join(shadow, "sessions", "2026", "10", "19", "rollout.jsonl"),
          "{}\n",
        );
        const memory = write(NodePath.join(shadow, "memories", "notes.md"), "remember\n");
        const refused = [
          write(NodePath.join(profile, "oauth_creds.json"), '{"token":"sk-test-google"}'),
          write(NodePath.join(profile, "google_accounts.json"), "sk-test-accounts"),
          write(
            NodePath.join(profile, "antigravity-acp", "conversations", `${session}.db`),
            "sk-test-conversation",
          ),
          write(NodePath.join(shadow, "auth.json"), '{"token":"sk-test-codex"}'),
          write(NodePath.join(shadow, "config.toml"), "sk-test-config"),
          write(NodePath.join(shadow, "sqlite", "state.db"), "sk-test-sqlite"),
        ];

        expect((yield* read(plan)).contents).toBe("# Plan\n");
        expect((yield* read(transcript)).contents).toBe("{}\n");
        expect((yield* read(memory)).contents).toBe("remember\n");
        for (const target of refused) yield* expectRefused(target);
        // Readable, never writable.
        yield* expectWriteRefused(NodePath.basename(plan), NodePath.dirname(plan));
        yield* expectWriteRefused("rollout.jsonl", NodePath.dirname(transcript));
        // A hard link to a profile credential is still caught by identity.
        const project = NodePath.join(scratch, "provider-state-project");
        NodeFS.mkdirSync(project, { recursive: true });
        NodeFS.linkSync(refused[0]!, NodePath.join(project, "creds.txt"));
        yield* expectRefused("creds.txt", project);
      }),
    );
  });

  describe("built-in browser files", () => {
    it.effect("reads downloads but not saved profiles, and writes neither", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const browser = NodePath.join(config.stateDir, "server-browser");
        const download = write(NodePath.join(browser, "downloads", "run-1", "report.csv"), "a,b\n");
        expect((yield* read(download)).contents).toBe("a,b\n");
        expect(
          (yield* read("server-browser/downloads/run-1/report.csv", config.stateDir)).contents,
        ).toBe("a,b\n");
        yield* expectRefused(
          write(NodePath.join(browser, "profiles", "Default", "Cookies"), "sk-test-cookies"),
        );
        yield* expectRefused(write(NodePath.join(browser, "state.json"), "sk-test-browser"));
        yield* expectWriteRefused("server-browser/downloads/run-1/report.csv", config.stateDir);
        expect(NodeFS.readFileSync(download, "utf8")).toBe("a,b\n");
      }),
    );
  });

  describe("refusal errors", () => {
    it.effect.skipIf(!symlinksSupported)(
      "name the path as requested, never where a link leads",
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const secret = write(NodePath.join(config.secretsDir, "named.bin"), "sk-test-named");
          const project = NodePath.join(scratch, "refusal-path-project");
          NodeFS.mkdirSync(project, { recursive: true });
          NodeFS.symlinkSync(secret, NodePath.join(project, "link.txt"));
          const requested = NodePath.join(project, "link.txt");

          const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
          for (const relativePath of ["link.txt", requested]) {
            const error = yield* read(relativePath, project).pipe(Effect.flip);
            expect(error).toMatchObject({
              operation: "open",
              resolvedPath: requested,
              operationPath: requested,
            });
            expect(JSON.stringify(error)).not.toContain("secrets");
          }
          const writeError = yield* files
            .writeFile({ cwd: project, relativePath: "link.txt", contents: "x" })
            .pipe(Effect.flip);
          expect(writeError).toMatchObject({
            operation: "write-file",
            resolvedPath: requested,
            operationPath: requested,
          });
          expect(JSON.stringify(writeError)).not.toContain("secrets");
        }),
    );
  });

  describe("a path that changes between the check and the open", () => {
    /** File reads whose guard runs `swap` right after each identity check of `name`. */
    const layerSwapping = (name: string, swap: () => void) =>
      // Fresh, so the file service is built again around the swapping guard.
      Layer.fresh(
        WorkspaceFileSystem.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(layerEntries),
          Layer.provide(
            Layer.effect(
              WorkspaceSensitivePaths.SensitivePaths,
              Effect.map(
                WorkspaceSensitivePaths.makeServerSensitivePathGuardSnapshot,
                ({ guard }) => ({
                  ...guard,
                  matchesProtectedIdentity: async (resolvedPath, statCache) => {
                    const verdict = await guard.matchesProtectedIdentity(resolvedPath, statCache);
                    if (NodePath.basename(resolvedPath) === name) swap();
                    return verdict;
                  },
                }),
              ),
            ),
          ),
        ),
      );
    /** An editor's atomic save: a new file renamed over the old one. */
    const atomicSave = (target: string, contents: string) => {
      NodeFS.writeFileSync(`${target}.tmp`, contents);
      NodeFS.renameSync(`${target}.tmp`, target);
    };

    it.effect("refuses a file swapped for a hard link to a secret after the check", () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const secret = write(NodePath.join(config.secretsDir, "swapped.bin"), "sk-test-swapped");
        const project = NodePath.join(scratch, "swap-project");
        const notes = write(NodePath.join(project, "notes.txt"), "plain notes\n");
        const layerSwapped = layerSwapping("notes.txt", () => {
          NodeFS.rmSync(notes);
          NodeFS.linkSync(secret, notes);
        });
        const error = yield* read("notes.txt", project).pipe(
          Effect.flip,
          Effect.provide(layerSwapped),
        );
        expect(error).toMatchObject({ operation: "open" });
        expect(JSON.stringify(error)).not.toContain("sk-test-swapped");
        expect(String(error.cause)).toContain("protected");
        // Without a swap the same read succeeds.
        const kept = write(NodePath.join(project, "kept.txt"), "kept\n");
        expect((yield* read(kept).pipe(Effect.provide(layerSwapped))).contents).toBe("kept\n");
      }),
    );

    it.effect("checks an ordinary replacement again and reads it", () =>
      Effect.gen(function* () {
        const project = NodePath.join(scratch, "atomic-save-project");
        const draft = write(NodePath.join(project, "draft.md"), "first\n");
        let saves = 0;
        const layerSaved = layerSwapping("draft.md", () => {
          if (saves++ === 0) atomicSave(draft, "second\n");
        });
        const result = yield* read("draft.md", project).pipe(Effect.provide(layerSaved));
        expect(result.contents).toBe("second\n");
      }),
    );

    it.effect("gives a plain retryable error when the file keeps changing", () =>
      Effect.gen(function* () {
        const project = NodePath.join(scratch, "busy-save-project");
        const busy = write(NodePath.join(project, "busy.md"), "0\n");
        let saves = 0;
        const layerBusy = layerSwapping("busy.md", () => atomicSave(busy, `${++saves}\n`));
        const error = yield* read("busy.md", project).pipe(Effect.flip, Effect.provide(layerBusy));
        expect(error).toMatchObject({
          operation: "open",
          resolvedPath: busy,
          cause: { code: "EAGAIN" },
        });
        expect("reason" in error && error.reason).toBeFalsy();
        expect(saves).toBe(2);
      }),
    );
  });

  describe("paths that cannot be resolved", () => {
    const failingRealpath =
      (failing: (target: string) => boolean) =>
      (target: string): Promise<string> =>
        failing(target)
          ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
          : WorkspaceSensitivePaths.realpathNative(target);

    it.effect("search returns nothing when the root cannot be resolved", () =>
      Effect.gen(function* () {
        const project = NodePath.join(scratch, "unresolvable-root");
        write(NodePath.join(project, "a.txt"), "rootneedle\n");
        expect((yield* searchAll(project, "rootneedle")).matches).toHaveLength(1);
        const result = yield* searchAll(project, "rootneedle").pipe(
          Effect.provideService(
            WorkspaceSensitivePaths.SensitivePathsRealpath,
            failingRealpath((target) => target === project),
          ),
        );
        expect(result).toEqual({ matches: [], truncated: false });
      }),
    );

    it.effect("search drops a matched file whose folder cannot be resolved", () =>
      Effect.gen(function* () {
        const project = NodePath.join(scratch, "unresolvable-match");
        write(NodePath.join(project, "a.txt"), "fileneedle\n");
        write(NodePath.join(project, "locked", "b.txt"), "fileneedle\n");
        // Files are resolved through their folder, so the folder is what fails.
        const result = yield* searchAll(project, "fileneedle").pipe(
          Effect.provideService(
            WorkspaceSensitivePaths.SensitivePathsRealpath,
            failingRealpath((target) => target.endsWith(`${NodePath.sep}locked`)),
          ),
        );
        expect(result.matches.map((match) => match.path)).toEqual(["a.txt"]);
      }),
    );
  });
});

describe("makeSensitivePathGuard", () => {
  const roots = {
    baseDir: "/srv/app",
    stateDir: "/srv/app/userdata",
    secretsDir: "/srv/app/userdata/secrets",
    settingsPath: "/srv/app/userdata/settings.json",
    dbPath: "/srv/app/userdata/statev2.sqlite",
    homeDir: "/home/owner",
  };

  it("matches case-insensitively where the file system does", () => {
    const mac = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "darwin");
    const linux = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    expect(mac.isDenied("/home/owner/.SSH/id_rsa")).toBe(true);
    expect(linux.isDenied("/home/owner/.SSH/id_rsa")).toBe(false);
    expect(linux.isDenied("/home/owner/.ssh/id_rsa")).toBe(true);
    // APFS folds U+017F (long s) to `s`; toLowerCase() alone keeps it.
    expect(mac.isDenied("/home/owner/.\u017fsh/id_rsa")).toBe(true);
    expect(mac.isDenied("/srv/app/userdata/\u017fecrets/key.bin")).toBe(true);
    expect(mac.isDenied("/work/x/.\u017fpecwithcode/userdata/settings.json")).toBe(true);
    expect(mac.isDenied("/srv/app/USERDATA/\u017fettings.json")).toBe(true);
    expect(mac.isDenied("/home/owner/.z\u017fhenv", "write")).toBe(true);
    expect(mac.isDenied("/home/owner/.Z\u017fHENV", "write")).toBe(true);
    expect(linux.isDenied("/home/owner/.\u017fsh/id_rsa")).toBe(false);
    expect(mac.isDenied("/System/Volumes/Data/home/owner/.ssh/id_rsa")).toBe(true);
    expect(mac.isDenied("/System/Volumes/Data/srv/app/userdata/settings.json")).toBe(true);
  });

  it("refuses every write to git metadata, however the name is spelled", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, platform);
      for (const target of [
        "/p/wt/.git",
        "/p/repo/.git/worktrees/wt/commondir",
        "/p/repo/.git/worktrees/wt/gitdir",
        "/p/repo/.git/config",
        "/p/repo/.git/info/exclude",
        "/p/repo/.git/objects/ab/cdef",
        "/p/repo/sub/.git/modules/x/config",
      ]) {
        expect(guard.isDenied(target, "write")).toBe(true);
        expect(guard.isDenied(target)).toBe(false);
      }
      expect(guard.isDenied("/p/repo/.github/workflows/ci.yml", "write")).toBe(false);
      expect(guard.isDenied("/p/repo/.gitignore", "write")).toBe(false);
      expect(guard.isDenied("/p/repo/.gitattributes", "write")).toBe(false);
      expect(guard.isDenied("/p/repo/notes.git", "write")).toBe(false);
    }
    const mac = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "darwin");
    expect(mac.isDenied("/p/wt/.GIT", "write")).toBe(true);
    expect(mac.isDenied("/p/repo/.Git/worktrees/wt/commondir", "write")).toBe(true);
    const linux = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    expect(linux.isDenied("/p/wt/.GIT", "write")).toBe(false);
    // NTFS opens `.git.`, `.git ` and `.git::$DATA` as `.git`.
    const windows = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "win32");
    expect(windows.isDenied("/p/wt/.git.", "write")).toBe(true);
    expect(windows.isDenied("/p/wt/.GIT ", "write")).toBe(true);
    expect(windows.isDenied("/p/wt/.git::$DATA", "write")).toBe(true);
    expect(windows.isDenied("/p/wt/.git. /config", "write")).toBe(true);
  });

  it("refuses more CLI and provider credential files", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    for (const relative of [
      "Library/Preferences/.wrangler/config/default.toml",
      ".wrangler/config/default.toml",
      ".config/.wrangler/config/default.toml",
      ".config/configstore/firebase-tools.json",
      ".terraform.d/credentials.tfrc.json",
      ".cargo/credentials.toml",
      ".cargo/credentials",
      ".vault-token",
      ".config/rclone/rclone.conf",
      ".codex/mcp-oauth-tokens.json",
      ".config/gh/hosts.yml",
      "Library/Application Support/forgejo-cli.forgejo-cli/keys.json",
      "Library/Application Support/Cyborus.forgejo-cli/keys.json",
      ".local/share/forgejo-cli/keys.json",
      "AppData/Roaming/Cyborus/forgejo-cli/data/keys.json",
      ".config/glab-cli/config.yml",
      "Library/Application Support/glab-cli/config.yml",
      ".config/tea/config.yml",
      "Library/Application Support/tea/config.yml",
      ".tea/tea.yml",
    ]) {
      expect(guard.isDenied(`/home/owner/${relative}`)).toBe(true);
    }
    expect(guard.isDenied("/work/app/.wrangler/state/v3/d1.sqlite")).toBe(false);
    expect(guard.isDenied("/home/owner/.cargo/config.toml")).toBe(false);
  });

  it("refuses source-control CLI tokens where the environment moves them", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(
      {
        ...roots,
        environment: {
          XDG_CONFIG_HOME: "/cfg",
          XDG_DATA_HOME: "~/data",
          APPDATA: "/win/roaming",
          LOCALAPPDATA: "/win/local",
          GH_CONFIG_DIR: "/gh",
          GLAB_CONFIG_DIR: "/glab",
        },
      },
      "linux",
    );
    for (const target of [
      "/cfg/gh/hosts.yml",
      "/cfg/glab-cli/config.yml",
      "/cfg/tea/config.yml",
      "/home/owner/data/forgejo-cli/keys.json",
      "/home/owner/data/opencode/auth.json",
      "/win/roaming/forgejo-cli/forgejo-cli/data/keys.json",
      "/win/roaming/Cyborus/forgejo-cli/data/keys.json",
      "/win/roaming/glab-cli/config.yml",
      "/win/local/glab-cli/config.yml",
      "/win/local/tea/config.yml",
      "/gh/hosts.yml",
      "/glab/config.yml",
    ]) {
      expect(guard.isDenied(target)).toBe(true);
    }
    expect(guard.isDenied("/cfg/glab-cli/aliases.yml")).toBe(false);
    expect(guard.isDenied("/home/owner/data/forgejo-cli/README.md")).toBe(false);
  });

  it("refuses writes to common shell start-up files and folders", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    for (const relative of [
      ".bash_login",
      ".bash_logout",
      ".zlogin",
      ".zlogout",
      ".zshenv",
      ".zprofile",
      ".config/fish/config.fish",
      ".config/fish/conf.d/env.fish",
      ".config/fish/functions/ls.fish",
      ".config/environment.d/10-path.conf",
    ]) {
      expect(guard.isDenied(`/home/owner/${relative}`, "write")).toBe(true);
      expect(guard.isDenied(`/home/owner/${relative}`)).toBe(false);
    }
    expect(guard.isDenied("/home/owner/.config/fishing/notes.md", "write")).toBe(false);
  });

  it("keeps the home's own folders when the base folder is the home", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(
      {
        ...roots,
        baseDir: "/home/owner",
        stateDir: "/home/owner/userdata",
        secretsDir: "/home/owner/userdata/secrets",
        settingsPath: "/home/owner/userdata/settings.json",
        dbPath: "/home/owner/userdata/statev2.sqlite",
      },
      "linux",
    );
    expect(guard.isDenied("/home/owner/dev/project/notes.md")).toBe(false);
    expect(guard.isDenied("/home/owner/dev/project/notes.md", "write")).toBe(false);
    expect(guard.isDenied("/home/owner/backups/photos.zip")).toBe(false);
    expect(guard.isDenied("/home/owner/runtime/notes.md", "write")).toBe(false);
    expect(guard.isDenied("/home/owner/userdata/settings.json")).toBe(true);
    expect(guard.isDenied("/home/owner/userdata/secrets/k.bin")).toBe(true);
    expect(guard.isDenied("/home/owner/studio-fleet.json")).toBe(true);
    // App homes under it keep their rules.
    expect(guard.isDenied("/home/owner/.specwithcode/m4/backups/x")).toBe(true);
  });

  it("reads built-in browser downloads but not its profiles", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    const browser = "/srv/app/userdata/server-browser";
    expect(guard.isDenied(`${browser}/downloads/run/report.pdf`)).toBe(false);
    expect(guard.isDenied(`${browser}/downloads/run/report.pdf`, "write")).toBe(true);
    expect(guard.isDenied(`${browser}/downloads`)).toBe(true);
    expect(guard.isDenied(`${browser}/profiles/Default/Cookies`)).toBe(true);
    expect(guard.isDenied(`${browser}/state.json`)).toBe(true);
    expect(
      guard.isDenied("/home/owner/.specwithcode/m4/userdata/server-browser/downloads/a.png"),
    ).toBe(false);
  });

  it("retries a failed native realpath with the JS one on Windows only", async () => {
    const failing = (code: string) => () =>
      Promise.reject(Object.assign(new Error(code), { code }));
    const fallback = (target: string) => Promise.resolve(`js:${target}`);
    for (const code of ["EISDIR", "EPERM", "UNKNOWN"]) {
      const realpath = WorkspaceSensitivePaths.makeRealpath(true, failing(code), fallback);
      expect(await realpath("R:\\work\\a.txt")).toBe("js:R:\\work\\a.txt");
    }
    // A missing path stays missing; both failing fails, so callers refuse the path.
    let fallbackCalls = 0;
    const counted = (target: string) => {
      fallbackCalls++;
      return fallback(target);
    };
    await expect(
      WorkspaceSensitivePaths.makeRealpath(true, failing("ENOENT"), counted)("R:\\gone"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(fallbackCalls).toBe(0);
    await expect(
      WorkspaceSensitivePaths.makeRealpath(true, failing("EPERM"), failing("EPERM"))("R:\\x"),
    ).rejects.toMatchObject({ code: "EPERM" });
    await expect(
      WorkspaceSensitivePaths.makeRealpath(false, failing("EPERM"), fallback)("/x"),
    ).rejects.toMatchObject({ code: "EPERM" });
  });

  it("reads provider agent output in the state folder only where it is agent output", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    const providers = "/srv/app/userdata/providers";
    expect(guard.isDenied(`${providers}/antigravity/k1/antigravity-acp/brain/s1/plan.md`)).toBe(
      false,
    );
    expect(guard.isDenied(`${providers}/codex/i1/shadow/sessions/2026/r.jsonl`)).toBe(false);
    for (const target of [
      `${providers}/antigravity/k1/antigravity-acp/brain`,
      `${providers}/antigravity/k1/oauth_creds.json`,
      `${providers}/antigravity/k1/antigravity-acp/conversations/s1.db`,
      `${providers}/antigravity/k1/brain/s1/plan.md`,
      `${providers}/codex/i1/shadow/auth.json`,
      `${providers}/codex/i1/shadow/config.toml`,
      `${providers}/codex/i1/shadow/sqlite/state.db`,
      `${providers}/codex/i1/auth.json`,
      `${providers}/claude/i1/sessions/x.jsonl`,
    ]) {
      expect(guard.isDenied(target)).toBe(true);
    }
    expect(
      guard.isDenied(`${providers}/antigravity/k1/antigravity-acp/brain/s1/plan.md`, "write"),
    ).toBe(true);
  });

  it("refuses every path under /.vol on macOS", () => {
    const mac = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "darwin");
    const linux = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    for (const access of ["read", "write"] as const) {
      expect(mac.isDenied("/.vol/16777230/2/home/owner/notes.txt", access)).toBe(true);
      expect(mac.isDenied("/.VOL/16777230/2/home/owner/.zshrc", access)).toBe(true);
      expect(mac.isDenied("/System/Volumes/Data/.vol/1/2/x", access)).toBe(true);
      expect(linux.isDenied("/.vol/16777230/2/home/owner/notes.txt", access)).toBe(false);
    }
    expect(mac.isDenied("/.volume/notes.txt")).toBe(false);
    expect(mac.isInsideDeniedFolder("/.vol/16777230/2")).toBe(true);
  });

  it("treats a configured worktree folder in an app home as projects", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    const repoDev = "/home/owner/.specwithcode/wt/dev/src/a.ts";
    const repoBackups = "/srv/app/wt/backups/notes.md";
    expect(guard.isDenied(repoDev)).toBe(true);
    expect(guard.isDenied(repoBackups)).toBe(true);
    guard.setWorktreesDirectories(["~/.specwithcode/wt", "/srv/app/wt"]);
    for (const access of ["read", "write"] as const) {
      expect(guard.isDenied(repoDev, access)).toBe(false);
      expect(guard.isDenied(repoBackups, access)).toBe(false);
    }
    // App homes inside a checkout there, and everything outside it, still count.
    expect(
      guard.isDenied("/home/owner/.specwithcode/wt/repo/.specwithcode/dev/settings.json"),
    ).toBe(true);
    expect(guard.isDenied("/home/owner/.specwithcode/m3/userdata/settings.json")).toBe(true);
    expect(guard.isDenied("/srv/app/backups/statev2.sqlite")).toBe(true);
    // A worktree setting naming an app home, or a folder holding the base, is ignored.
    guard.setWorktreesDirectories(["/home/owner/.specwithcode", "/srv"]);
    expect(guard.isDenied("/home/owner/.specwithcode/m3/userdata/settings.json")).toBe(true);
    expect(guard.isDenied(repoBackups)).toBe(true);
    expect(
      WorkspaceSensitivePaths.worktreesDirectoriesFromSettings({
        worktreesDirectory: "~/wt",
        previousWorktreesDirectories: ["/old", " "],
      }),
    ).toEqual(["~/wt", "/old"]);
  });

  it("does not read identity homes out of a configured worktree folder", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-worktree-home-"));
    try {
      const file = write(
        NodePath.join(home, ".specwithcode", "wt", "dev", "src", "a.ts"),
        "export {};\n",
      );
      const base = NodePath.join(home, "server");
      const guardRoots = {
        baseDir: base,
        stateDir: NodePath.join(base, "userdata"),
        secretsDir: NodePath.join(base, "userdata", "secrets"),
        settingsPath: NodePath.join(base, "userdata", "settings.json"),
        dbPath: NodePath.join(base, "userdata", "statev2.sqlite"),
        homeDir: home,
        identityCacheMillis: 0,
      };
      const real = NodeFS.realpathSync.native(file);
      const plain = WorkspaceSensitivePaths.makeSensitivePathGuard(guardRoots, "linux");
      expect(await plain.matchesProtectedIdentity(real)).toBe(true);
      const withWorktrees = WorkspaceSensitivePaths.makeSensitivePathGuard(
        { ...guardRoots, worktreesDirectories: [NodePath.join(home, ".specwithcode", "wt")] },
        "linux",
      );
      expect(await withWorktrees.matchesProtectedIdentity(real)).toBe(false);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not treat a sibling with a shared prefix as inside a denied folder", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    expect(guard.isDenied("/home/owner/.ssh-notes/readme.md")).toBe(false);
    expect(guard.isDenied("/srv/app/userdata-export/notes.txt")).toBe(false);
    expect(guard.isDenied("/srv/app/userdata/secrets/key.bin")).toBe(true);
    expect(guard.isDenied("/srv/app/worktrees/dev/userdata/settings.json")).toBe(false);
  });

  it("does not treat projects as app homes when the base folder holds the home", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(
      { ...roots, baseDir: "/home", stateDir: "/home/userdata" },
      "linux",
    );
    expect(guard.isDenied("/home/owner/project/dev/notes.md")).toBe(false);
    expect(guard.isDenied("/home/userdata/settings.json")).toBe(true);
  });

  it("refuses the credential files of provider homes named in settings", () => {
    const guard = WorkspaceSensitivePaths.makeSensitivePathGuard(roots, "linux");
    const homes = WorkspaceSensitivePaths.providerHomesFromSettings({
      providers: { codex: { homePath: "~/.codex-work", shadowHomePath: "/opt/codex-shadow" } },
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          config: { homePath: "/data/claude-work" },
          environment: [{ name: "CODEX_HOME", value: "/data/codex-env", sensitive: false }],
        },
      },
    });
    expect(homes).toEqual([
      "~/.codex-work",
      "/opt/codex-shadow",
      "/data/claude-work",
      "/data/codex-env",
    ]);
    expect(guard.isDenied("/home/owner/.codex-work/auth.json")).toBe(false);
    guard.setProviderHomes(homes);
    expect(guard.isDenied("/home/owner/.codex-work/auth.json")).toBe(true);
    expect(guard.isDenied("/opt/codex-shadow/auth.json")).toBe(true);
    expect(guard.isDenied("/data/claude-work/.credentials.json")).toBe(true);
    expect(guard.isDenied("/data/codex-env/auth.json")).toBe(true);
    expect(guard.isDenied("/data/claude-work/settings.json")).toBe(false);
    expect(guard.isDenied("/data/claude-work/settings.json", "write")).toBe(true);
    expect(guard.isDenied("/opt/codex-shadow/config.toml", "write")).toBe(true);
    expect(guard.isDenied("/data/claude-work/CLAUDE.md", "write")).toBe(false);
    guard.setProviderHomes([]);
    expect(guard.isDenied("/data/claude-work/.credentials.json")).toBe(false);
  });
});

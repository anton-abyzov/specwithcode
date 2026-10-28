// @effect-diagnostics nodeBuiltinImport:off - Real files and the installers' own renderers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HostProcessEnvironment, HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  parseShellLauncher,
  readRegularFile,
  replaceRegularFile,
  shellQuote,
} from "./shellLauncher.ts";
import { repointShellLaunchers } from "./update.ts";

const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const FLEET = NodePath.join(REPO, "scripts/studio-fleet");
const NODE = process.execPath;

/** install.sh's own render_cli_wrapper, run with this home and release. */
const installShLauncher = (input: { home: string; studioHome: string; versionDir: string }) => {
  const functions = NodeChildProcess.execFileSync(
    "sed",
    ["-n", "/^py_quote() {/,/^}/p;/^runtime_path() {/,/^}/p;/^render_cli_wrapper() {/,/^}/p"],
    { input: NodeFS.readFileSync(NodePath.join(REPO, "scripts/install.sh")), encoding: "utf8" },
  );
  return NodeChildProcess.execFileSync("sh", ["-c", `${functions}\nrender_cli_wrapper`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: input.home,
      TMPDIR: "/tmp",
      node: NODE,
      studio_home: input.studioHome,
      target_dir: input.versionDir,
    },
  });
};

/**
 * scripts/studio-fleet/launcher.py render_cli on install.py's prefix: the identity home and the
 * release store from studio_paths, the entry `release` names (or one given outright).
 */
const fleetLauncher = (input: { home: string; identity: string; entry?: string }) =>
  JSON.parse(
    NodeChildProcess.execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `import json, os, sys
sys.path.insert(0, ${JSON.stringify(FLEET)})
import launcher, studio_paths
home, identity, node, entry = sys.argv[1:5]
studio_home = studio_paths.identity_home(home, identity)
release = studio_paths.install_root(home) / 'releases' / ('a' * 20)
env = {'HOME': home, 'USER': 'u', 'LOGNAME': 'u', 'PATH': launcher.runtime_path(__import__('pathlib').Path(home), __import__('pathlib').Path(node)),
       'LANG': 'en_US.UTF-8', 'TMPDIR': '/tmp', 'STUDIO_HOME': str(studio_home), 'STUDIO_HOST': '127.0.0.1',
       'STUDIO_PORT': '4321', 'STUDIO_MODE': 'web', 'STUDIO_NO_BROWSER': 'true',
       'STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': 'false', 'PWDEBUG': '0', 'PLAYWRIGHT_HTML_OPEN': 'never'}
prefix = ['/usr/bin/env', '-i'] + [k + '=' + v for k, v in env.items()] + [node, entry or str(release / 'bin.mjs')]
print(json.dumps({'text': launcher.render_cli(prefix), 'studioHome': str(studio_home), 'release': str(release)}))`,
        input.home,
        input.identity,
        NODE,
        input.entry ?? "",
      ],
      { encoding: "utf8" },
    ),
  ) as { text: string; studioHome: string; release: string };

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** A home whose name needs quoting: an apostrophe, a space and a dollar sign. */
const makeHome = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shell-launcher-"));
  roots.push(root);
  const home = NodePath.join(root, "O'Brien $home");
  NodeFS.mkdirSync(NodePath.join(home, ".local/bin"), { recursive: true });
  return { root, home };
};

/** A runnable bin.mjs that prints its version. */
const release = (dir: string, version: string) => {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "bin.mjs"), `console.log(${JSON.stringify(version)});\n`);
};

const install = (file: string, text: string, mode: number) => {
  NodeFS.writeFileSync(file, text);
  NodeFS.chmodSync(file, mode);
};

const run = (launcher: string) =>
  NodeChildProcess.spawnSync(launcher, [], { encoding: "utf8", env: {} });

const repoint = (input: { baseDir: string; versionDir: string; env: Record<string, string> }) =>
  repointShellLaunchers({
    baseDir: input.baseDir,
    versionsDir: NodePath.dirname(input.versionDir),
    versionDir: input.versionDir,
  }).pipe(
    Effect.provideService(HostProcessEnvironment, input.env),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

const windowsHost = HostProcessPlatform.defaultValue() === "win32";

it.layer(NodeServices.layer)("shell launchers", (it) => {
  it.skipIf(windowsHost)("quotes and splits operands as the installers do", () => {
    for (const value of ["", "plain/path", "O'Brien $home", "a=b", "/backup=/x y/bin.mjs"]) {
      const text = `#!/bin/sh\nset -eu\numask 077\nexec /usr/bin/env -i ${shellQuote(`HOME=${value}`)} ${shellQuote(NODE)} ${shellQuote(`${value}/bin.mjs`)} "$@"\n`;
      const parsed = parseShellLauncher(text);
      expect(parsed?.environment.get("HOME")).toBe(value);
      expect(parsed?.prefix.at(-1)).toBe(`${value}/bin.mjs`);
      expect(parsed?.render(parsed.prefix)).toBe(text);
    }
    // A custom or edited script is not a launcher, even when it runs the same release.
    expect(
      parseShellLauncher(
        `#!/bin/sh\nset -eu\nexec /usr/bin/env -i HOME=/h ${NODE} /h/bin.mjs "$@"\n`,
      ),
    ).toBeUndefined();
    expect(
      parseShellLauncher(
        `#!/bin/sh\nset -eu\numask 077\nexec /usr/bin/env -i HOME=/h ${NODE}  /h/bin.mjs "$@"\n`,
      ),
    ).toBeUndefined();
  });

  it.effect.skipIf(windowsHost)(
    "repoints install.sh's launchers to the new version and keeps their modes",
    () =>
      Effect.gen(function* () {
        const { home } = makeHome();
        const baseDir = NodePath.join(home, ".specwithcode");
        const versions = NodePath.join(baseDir, "runtime/versions");
        release(NodePath.join(versions, "1.0.0"), "1.0.0");
        release(NodePath.join(versions, "2.0.0"), "2.0.0");
        const old = installShLauncher({
          home,
          studioHome: baseDir,
          versionDir: NodePath.join(versions, "1.0.0"),
        });
        const wanted = installShLauncher({
          home,
          studioHome: baseDir,
          versionDir: NodePath.join(versions, "2.0.0"),
        });
        const ours = NodePath.join(home, ".local/bin/specwithcode");
        const alias = NodePath.join(home, ".local/bin/specweave-studio");
        install(ours, old, 0o700);
        install(alias, old, 0o755);
        expect(run(ours).stdout).toBe("1.0.0\n");

        const repointed = yield* repoint({
          baseDir,
          versionDir: NodePath.join(versions, "2.0.0"),
          env: { PATH: "/nonexistent", HOME: home },
        });

        expect([...repointed].sort()).toEqual([alias, ours].sort());
        for (const launcher of [ours, alias]) {
          expect(NodeFS.readFileSync(launcher, "utf8")).toBe(wanted);
          expect(run(launcher).stdout).toBe("2.0.0\n");
        }
        expect(NodeFS.statSync(ours).mode & 0o777).toBe(0o700);
        expect(NodeFS.statSync(alias).mode & 0o777).toBe(0o755);
        expect(NodeFS.readdirSync(NodePath.join(home, ".local/bin")).sort()).toEqual([
          "specweave-studio",
          "specwithcode",
        ]);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "repoints the fleet installer's launcher for this identity only",
    () =>
      Effect.gen(function* () {
        const { home, root } = makeHome();
        const mine = fleetLauncher({ home, identity: "m4" });
        const other = fleetLauncher({ home, identity: "stage" });
        release(mine.release, "1.0.0");
        // The release store is shared: install.py puts it under ~/.specwithcode/install/releases.
        expect(mine.release).toBe(
          NodePath.join(home, ".specwithcode/install/releases", "a".repeat(20)),
        );
        const versionDir = NodePath.join(mine.studioHome, "runtime/versions/2.0.0");
        release(versionDir, "2.0.0");
        const ours = NodePath.join(home, ".local/bin/specwithcode");
        install(ours, mine.text, 0o700);
        const otherBin = NodePath.join(root, "other-bin");
        NodeFS.mkdirSync(otherBin);
        install(NodePath.join(otherBin, "specwithcode"), other.text, 0o700);
        expect(run(ours).stdout).toBe("1.0.0\n");

        const repointed = yield* repoint({
          baseDir: mine.studioHome,
          versionDir,
          env: { PATH: otherBin, HOME: home },
        });

        expect(repointed).toEqual([ours]);
        expect(run(ours).stdout).toBe("2.0.0\n");
        expect(parseShellLauncher(NodeFS.readFileSync(ours, "utf8"))?.prefix.at(-1)).toBe(
          NodePath.join(versionDir, "bin.mjs"),
        );
        // Another identity's launcher on the same release store stays as it was.
        expect(NodeFS.readFileSync(NodePath.join(otherBin, "specwithcode"), "utf8")).toBe(
          other.text,
        );
      }),
  );

  it.effect.skipIf(windowsHost)(
    "leaves a quoted path that only contains this home's tree after '='",
    () =>
      Effect.gen(function* () {
        const { home } = makeHome();
        const baseDir = NodePath.join(home, ".specwithcode");
        const versions = NodePath.join(baseDir, "runtime/versions");
        // Same STUDIO_HOME; only the entry differs: `/backup=<this tree>/1.0.0/bin.mjs`.
        const foreign = {
          text: installShLauncher({
            home,
            studioHome: baseDir,
            versionDir: `/backup=${versions}/1.0.0`,
          }),
        };
        expect(parseShellLauncher(foreign.text)?.prefix.at(-1)).toBe(
          `/backup=${versions}/1.0.0/bin.mjs`,
        );
        release(NodePath.join(versions, "1.0.0"), "1.0.0");
        release(NodePath.join(versions, "2.0.0"), "2.0.0");
        const launcher = NodePath.join(home, ".local/bin/specwithcode");
        install(launcher, foreign.text, 0o700);

        const repointed = yield* repoint({
          baseDir,
          versionDir: NodePath.join(versions, "2.0.0"),
          env: { PATH: "/nonexistent", HOME: home },
        });

        expect(repointed).toEqual([]);
        expect(NodeFS.readFileSync(launcher, "utf8")).toBe(foreign.text);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "leaves another home's, an edited, or an unready launcher alone",
    () =>
      Effect.gen(function* () {
        const { home, root } = makeHome();
        const baseDir = NodePath.join(home, ".specwithcode");
        const versions = NodePath.join(baseDir, "runtime/versions");
        release(NodePath.join(versions, "1.0.0"), "1.0.0");
        const old = installShLauncher({
          home,
          studioHome: baseDir,
          versionDir: NodePath.join(versions, "1.0.0"),
        });
        const launcher = NodePath.join(home, ".local/bin/specwithcode");
        install(launcher, old, 0o700);
        // The new version has no bin.mjs yet.
        NodeFS.mkdirSync(NodePath.join(versions, "2.0.0"));
        expect(
          yield* repoint({
            baseDir,
            versionDir: NodePath.join(versions, "2.0.0"),
            env: { PATH: "/nonexistent", HOME: home },
          }),
        ).toEqual([]);
        release(NodePath.join(versions, "2.0.0"), "2.0.0");
        // Another home's launcher names this tree but sets its own STUDIO_HOME.
        const otherHome = installShLauncher({
          home,
          studioHome: NodePath.join(root, "elsewhere"),
          versionDir: NodePath.join(versions, "1.0.0"),
        });
        install(launcher, otherHome, 0o700);
        expect(
          yield* repoint({
            baseDir,
            versionDir: NodePath.join(versions, "2.0.0"),
            env: { PATH: "/nonexistent", HOME: home },
          }),
        ).toEqual([]);
        // An edited copy of ours.
        const edited = old.replace("umask 077\n", "umask 077\necho hi\n");
        install(launcher, edited, 0o700);
        expect(
          yield* repoint({
            baseDir,
            versionDir: NodePath.join(versions, "2.0.0"),
            env: { PATH: "/nonexistent", HOME: home },
          }),
        ).toEqual([]);
        expect(NodeFS.readFileSync(launcher, "utf8")).toBe(edited);
      }),
  );

  it.effect.skipIf(windowsHost)(
    "skips a launcher in a folder this user cannot write, leaving nothing behind",
    () =>
      Effect.gen(function* () {
        const { home } = makeHome();
        const baseDir = NodePath.join(home, ".specwithcode");
        const versions = NodePath.join(baseDir, "runtime/versions");
        release(NodePath.join(versions, "1.0.0"), "1.0.0");
        release(NodePath.join(versions, "2.0.0"), "2.0.0");
        const bin = NodePath.join(home, ".local/bin");
        const old = installShLauncher({
          home,
          studioHome: baseDir,
          versionDir: NodePath.join(versions, "1.0.0"),
        });
        install(NodePath.join(bin, "specwithcode"), old, 0o700);
        NodeFS.chmodSync(bin, 0o500);
        try {
          expect(
            yield* repoint({
              baseDir,
              versionDir: NodePath.join(versions, "2.0.0"),
              env: { PATH: "/nonexistent", HOME: home },
            }),
          ).toEqual([]);
        } finally {
          NodeFS.chmodSync(bin, 0o700);
        }
        expect(NodeFS.readFileSync(NodePath.join(bin, "specwithcode"), "utf8")).toBe(old);
        expect(NodeFS.readdirSync(bin)).toEqual(["specwithcode"]);
      }),
  );

  it.effect.skipIf(windowsHost)("passes over a FIFO named like a launcher without waiting", () =>
    Effect.gen(function* () {
      const { home } = makeHome();
      const baseDir = NodePath.join(home, ".specwithcode");
      const versions = NodePath.join(baseDir, "runtime/versions");
      release(NodePath.join(versions, "2.0.0"), "2.0.0");
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(home, ".local/bin/specwithcode")]);
      const repointed = yield* repoint({
        baseDir,
        versionDir: NodePath.join(versions, "2.0.0"),
        env: { PATH: "/nonexistent", HOME: home },
      }).pipe(Effect.timeout("5 seconds"));
      expect(repointed).toEqual([]);
    }),
  );

  it.effect.skipIf(windowsHost)("treats a home reached through a link as the same home", () =>
    Effect.gen(function* () {
      const { home } = makeHome();
      const baseDir = NodePath.join(home, ".specwithcode");
      const versions = NodePath.join(baseDir, "runtime/versions");
      release(NodePath.join(versions, "1.0.0"), "1.0.0");
      release(NodePath.join(versions, "2.0.0"), "2.0.0");
      // The legacy name, kept as a link to the branded home.
      const linked = NodePath.join(home, ".specweave-studio");
      NodeFS.symlinkSync(baseDir, linked);
      const old = installShLauncher({
        home,
        studioHome: linked,
        versionDir: NodePath.join(linked, "runtime/versions/1.0.0"),
      });
      const launcher = NodePath.join(home, ".local/bin/specwithcode");
      install(launcher, old, 0o700);
      const repointed = yield* repoint({
        baseDir,
        versionDir: NodePath.join(versions, "2.0.0"),
        env: { PATH: "/nonexistent", HOME: home },
      });
      expect(repointed).toEqual([launcher]);
      expect(run(launcher).stdout).toBe("2.0.0\n");
    }),
  );
});

describe.skipIf(windowsHost)("replaceRegularFile", () => {
  it("never writes through the old predictable temporary name", async () => {
    const { root } = makeHome();
    const launcher = NodePath.join(root, "specwithcode");
    install(launcher, "old\n", 0o700);
    const document = NodePath.join(root, "document");
    install(document, "KEEP THIS DOCUMENT\n", 0o600);
    // What the reviewed head wrote through: `${launcher}.${process.pid}.tmp`.
    NodeFS.symlinkSync(document, `${launcher}.${process.pid}.tmp`);

    await replaceRegularFile(launcher, "new\n", (await readRegularFile(launcher, 1024))!);

    expect(NodeFS.readFileSync(launcher, "utf8")).toBe("new\n");
    expect(NodeFS.lstatSync(launcher).isFile()).toBe(true);
    expect(NodeFS.statSync(launcher).mode & 0o777).toBe(0o700);
    expect(NodeFS.readFileSync(document, "utf8")).toBe("KEEP THIS DOCUMENT\n");
    expect(NodeFS.statSync(document).mode & 0o777).toBe(0o600);
  });

  it("refuses a launcher replaced since it was read and removes only its own entry", async () => {
    const { root } = makeHome();
    const launcher = NodePath.join(root, "specwithcode");
    install(launcher, "old\n", 0o700);
    const read = (await readRegularFile(launcher, 1024))!;
    install(`${launcher}.other`, "someone else's\n", 0o755);
    NodeFS.renameSync(`${launcher}.other`, launcher);

    await expect(replaceRegularFile(launcher, "new\n", read)).rejects.toThrow(/changed/);

    expect(NodeFS.readFileSync(launcher, "utf8")).toBe("someone else's\n");
    expect(NodeFS.readdirSync(root).filter((name) => name !== "O'Brien $home")).toEqual([
      "specwithcode",
    ]);
  });

  it("refuses a launcher edited in place since it was read", async () => {
    const { root } = makeHome();
    const launcher = NodePath.join(root, "specwithcode");
    install(launcher, "old\n", 0o700);
    const read = (await readRegularFile(launcher, 1024))!;
    // Same inode, new bytes.
    NodeFS.writeFileSync(launcher, "edited\n");
    expect(NodeFS.statSync(launcher).ino).toBe(read.ino);

    await expect(replaceRegularFile(launcher, "new\n", read)).rejects.toThrow(/changed/);

    expect(NodeFS.readFileSync(launcher, "utf8")).toBe("edited\n");
    expect(NodeFS.readdirSync(root).filter((name) => name !== "O'Brien $home")).toEqual([
      "specwithcode",
    ]);
  });

  it("reads no link and nothing over the size limit", async () => {
    const { root } = makeHome();
    const target = NodePath.join(root, "target");
    install(target, "x".repeat(10), 0o600);
    NodeFS.symlinkSync(target, NodePath.join(root, "link"));
    expect(await readRegularFile(NodePath.join(root, "link"), 1024)).toBeUndefined();
    expect(await readRegularFile(target, 5)).toBeUndefined();
    expect((await readRegularFile(target, 10))?.text).toBe("x".repeat(10));
  });
});

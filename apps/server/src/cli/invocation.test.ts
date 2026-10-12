import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  formatCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/dev/.npm/_npx/abc123/node_modules/specweave-studio/dist/bin.mjs", "npx specweave-studio serve"],
    [
      "C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\specweave-studio\\dist\\bin.mjs",
      "npx specweave-studio serve",
    ],
    ["/home/dev/.cache/pnpm/dlx/abc/node_modules/specweave-studio/dist/bin.mjs", "pnpm dlx specweave-studio serve"],
    [
      "/home/dev/.local/share/pnpm/.pnpm/dlx/abc/node_modules/specweave-studio/dist/bin.mjs",
      "pnpm dlx specweave-studio serve",
    ],
    [
      "C:\\Users\\dev\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\specweave-studio\\dist\\bin.mjs",
      "pnpm dlx specweave-studio serve",
    ],
    ["/home/dev/.bun/install/cache/specweave-studio@0.0.31/dist/bin.mjs", "bunx specweave-studio serve"],
    ["/tmp/bunx-1000-specweave-studio@latest/node_modules/specweave-studio/dist/bin.mjs", "bunx specweave-studio serve"],
    [
      "C:\\Users\\dev\\AppData\\Local\\Temp\\bunx-0-specweave-studio@latest\\node_modules\\specweave-studio\\dist\\bin.mjs",
      "bunx specweave-studio serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/specweave-studio/dist/bin.mjs",
    "/home/dev/Code/work/studio/apps/server/dist/bin.mjs",
    "/home/dev/.specweave-studio/runtime/0.0.31/node_modules/specweave-studio/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "specweave-studio serve",
    );
  }
});

it("re-suggests the prerelease channel only for prerelease builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx specweave-studio@nightly serve"],
    ["0.0.31-preview.20260729.1", "npx specweave-studio@preview serve"],
    ["0.0.31-foo-preview.20260729.1", "npx specweave-studio serve"],
    ["0.0.31", "npx specweave-studio serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/dev/.npm/_npx/abc123/node_modules/specweave-studio/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/dev/.npm/_npx/abc/node_modules/specweave-studio/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx specweave-studio@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-specweave-studio@latest/node_modules/specweave-studio/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx specweave-studio serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/specweave-studio/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "specweave-studio serve",
  );
});

it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
  Effect.gen(function* () {
    const command = (node: string, entry: string) =>
      resolveRootCliCommand("browser setup").pipe(
        Effect.provideService(HostProcessExecutablePath, node),
        Effect.provideService(HostProcessArguments, [node, entry]),
      );
    const npx = "/home/dev/.npm/_npx/abc/node_modules/specweave-studio/dist/bin.mjs";
    // sudo's secure_path already has a system Node.
    expect(yield* command("/usr/bin/node", npx)).toBe("sudo npx specweave-studio browser setup");
    // nvm, fnm, and tarball installs are dropped by sudo's PATH reset.
    expect(yield* command("/home/dev/.nvm/versions/node/v24/bin/node", npx)).toBe(
      'sudo env "PATH=$PATH" npx specweave-studio browser setup',
    );
    expect(
      yield* command(
        "/home/dev/.local/node/bin/node",
        "/home/dev/.local/lib/node_modules/specweave-studio/dist/bin.mjs",
      ),
    ).toBe('sudo env "PATH=$PATH" specweave-studio browser setup');
  }),
);

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for both script and executable packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/specweave-studio/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/@specweave-studio/studio-linux-x64/specweave-studio", "npx"],
        ["pnpm/dlx/hash/node_modules/specweave-studio/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/studio/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcessArguments, ["node", entry]),
          Effect.provideService(HostProcessExecutablePath, entry),
          Effect.provideService(HostProcessIsExecutable, entry.endsWith("/specweave-studio")),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The resolver reports the prefix of the real entry path, and macOS temp
      // directories sit behind the `/var` -> `/private/var` symlink.
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/specweave-studio");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/specweave-studio");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"specweave-studio","version":"0.0.45","bin":{"specweave-studio":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessArguments, ["node", entry]),
        Effect.provideService(HostProcessIsExecutable, false),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated specweave-studio command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcessPlatform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the native executable belongs to the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The resolver reports the prefix of the real entry path, and macOS temp
      // directories sit behind the `/var` -> `/private/var` symlink.
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/specweave-studio");
      const launcher = path.join(packageRoot, "bin/specweave-studio.js");
      const entry = path.join(packageRoot, "node_modules/@specweave-studio/studio-linux-x64/specweave-studio");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"specweave-studio","version":"0.0.45","bin":{"specweave-studio":"./bin/specweave-studio.js"},"optionalDependencies":{"@specweave-studio/studio-linux-x64":"0.0.45"}}',
      );
      yield* fs.symlink(launcher, path.join(prefix, "bin/specweave-studio"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcessExecutablePath, entry),
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      for (const [version, expected] of [
        ["0.0.44", null],
        ["0.0.45", { kind: "npm-global", prefix }],
      ]) {
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "package.json"),
          `{"name":"@specweave-studio/studio-linux-x64","version":"${version}"}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/specweave-studio/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".specweave-studio/runtime/0.0.45/specweave-studio",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcessArguments, ["node", entry]),
            Effect.provideService(HostProcessIsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});

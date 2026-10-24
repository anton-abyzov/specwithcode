// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import { execFileSync, spawnSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import * as FS from "node:fs";
import { createRequire } from "node:module";
import * as OS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";

import {
  assertReplaceable,
  parseBundleIdentity,
  removeTree,
  resolveRunningAppBundle,
  sha512Base64,
  SWAP_SCRIPT,
} from "./macSwapInstall.ts";

const scratch: string[] = [];
const makeScratch = () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "studio-swap-"));
  scratch.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of scratch.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

// A pid that has already exited, so the script does not wait.
const exitedPid = () => {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  return child.pid ?? 999_999;
};

const runSwap = (dir: string, current: string, staged: string, target?: string) => {
  const script = Path.join(dir, "swap.sh");
  FS.writeFileSync(script, SWAP_SCRIPT, { mode: 0o700 });
  execFileSync("/bin/sh", [
    script,
    String(exitedPid()),
    current,
    staged,
    "0",
    ...(target === undefined ? [] : [target]),
  ]);
};

// A real asar archive: Electron's fs treats a file like this as a folder.
const writeAsar = (file: string) => {
  const json = JSON.stringify({ files: { "a.txt": { size: 2, offset: "0" } } });
  const text = Buffer.from(json);
  const padded = Math.ceil(text.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(text.length, 12);
  text.copy(header, 16);
  FS.writeFileSync(file, Buffer.concat([header, Buffer.from("hi")]));
};

const makeAppZip = (dir: string, version: string) => {
  const app = Path.join(dir, "build", "Studio.app");
  FS.mkdirSync(Path.join(app, "Contents", "Resources"), { recursive: true });
  FS.writeFileSync(
    Path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  writeAsar(Path.join(app, "Contents", "Resources", "app.asar"));
  const zip = Path.join(dir, "Studio.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  return zip;
};

// The Electron binary, when this checkout has downloaded all of it. A runtime that is
// still extracting, or was cut off mid-download, has a binary on disk that dyld kills
// at launch, and every such launch pops a macOS "Electron quit unexpectedly" dialog.
const electronBinary = (() => {
  if (process.env.STUDIO_TEST_ELECTRON) return process.env.STUDIO_TEST_ELECTRON;
  try {
    const binary = createRequire(import.meta.url)("electron") as unknown;
    if (typeof binary !== "string" || !FS.existsSync(binary)) return null;
    const runtimeCheck = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../scripts/ensure-electron-runtime.mjs", import.meta.url)),
        "--check",
      ],
      { encoding: "utf8" },
    );
    return runtimeCheck.status === 0 ? binary : null;
  } catch {
    return null;
  }
})();

// The swap script and `/bin/rm` cleanup are macOS updater steps; Windows has no `/bin/sh`.
const itPosix = it.skipIf(HostProcessPlatform.defaultValue() === "win32");

describe("macSwapInstall", () => {
  it("finds the app bundle from the running executable", () => {
    expect(
      resolveRunningAppBundle("/Applications/SpecWeave Studio.app/Contents/MacOS/SpecWeave Studio"),
    ).toBe("/Applications/SpecWeave Studio.app");
    expect(resolveRunningAppBundle("/usr/local/bin/electron")).toBeNull();
  });

  it("reads the bundle id and version from Info.plist JSON", () => {
    expect(
      parseBundleIdentity(
        JSON.stringify({
          CFBundleIdentifier: "com.specweave.studio",
          CFBundleShortVersionString: "0.2.1",
        }),
      ),
    ).toEqual({ bundleId: "com.specweave.studio", version: "0.2.1" });
    expect(parseBundleIdentity("not json")).toEqual({ bundleId: null, version: null });
  });

  it("hashes files the way electron-builder manifests do", async () => {
    const dir = makeScratch();
    const file = Path.join(dir, "a.zip");
    FS.writeFileSync(file, "hello");
    expect(await sha512Base64(file)).toBe(
      "m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==",
    );
  });

  it("refuses to update a copy macOS is running from a temporary location", () => {
    expect(() =>
      assertReplaceable("/private/var/folders/x/AppTranslocation/ABC/d/SpecWeave Studio.app"),
    ).toThrow("Applications");
    expect(() => assertReplaceable("/Volumes/SpecWeave Studio/SpecWeave Studio.app")).toThrow(
      "disk image",
    );
  });

  itPosix("swaps the new bundle in and removes the old one", () => {
    const dir = makeScratch();
    const current = Path.join(dir, "Studio.app");
    const staged = Path.join(dir, "pending", "Studio.app");
    FS.mkdirSync(current, { recursive: true });
    FS.writeFileSync(Path.join(current, "version"), "old");
    FS.mkdirSync(staged, { recursive: true });
    FS.writeFileSync(Path.join(staged, "version"), "new");

    runSwap(dir, current, staged);

    expect(FS.readFileSync(Path.join(current, "version"), "utf8")).toBe("new");
    expect(FS.existsSync(staged)).toBe(false);
    expect(FS.existsSync(`${current}.studio-update-old`)).toBe(false);
  });

  itPosix("puts the old bundle back when the new one cannot be moved in", () => {
    const dir = makeScratch();
    const current = Path.join(dir, "Studio.app");
    FS.mkdirSync(current, { recursive: true });
    FS.writeFileSync(Path.join(current, "version"), "old");

    runSwap(dir, current, Path.join(dir, "missing", "Studio.app"));

    expect(FS.readFileSync(Path.join(current, "version"), "utf8")).toBe("old");
    expect(FS.existsSync(`${current}.studio-update-old`)).toBe(false);
  });

  itPosix("installs the new bundle under its new name and leaves no old copy behind", () => {
    const dir = makeScratch();
    const current = Path.join(dir, "SpecWeave Studio (Alpha).app");
    const staged = Path.join(dir, "pending", "SpecWithCode.app");
    const target = Path.join(dir, "SpecWithCode.app");
    FS.mkdirSync(current, { recursive: true });
    FS.writeFileSync(Path.join(current, "version"), "old");
    FS.mkdirSync(staged, { recursive: true });
    FS.writeFileSync(Path.join(staged, "version"), "new");

    runSwap(dir, current, staged, target);

    expect(FS.readFileSync(Path.join(target, "version"), "utf8")).toBe("new");
    expect(FS.existsSync(current)).toBe(false);
    expect(FS.existsSync(staged)).toBe(false);
    expect(FS.existsSync(`${current}.studio-update-old`)).toBe(false);
    expect(FS.readdirSync(dir).filter((name) => name.endsWith(".app"))).toEqual([
      "SpecWithCode.app",
    ]);
  });

  itPosix("replaces the bundle in place when the new name is already taken", () => {
    const dir = makeScratch();
    const current = Path.join(dir, "SpecWeave Studio (Alpha).app");
    const staged = Path.join(dir, "pending", "SpecWithCode.app");
    const target = Path.join(dir, "SpecWithCode.app");
    FS.mkdirSync(current, { recursive: true });
    FS.writeFileSync(Path.join(current, "version"), "old");
    FS.mkdirSync(staged, { recursive: true });
    FS.writeFileSync(Path.join(staged, "version"), "new");
    FS.mkdirSync(target, { recursive: true });
    FS.writeFileSync(Path.join(target, "version"), "someone else's");

    runSwap(dir, current, staged, target);

    expect(FS.readFileSync(Path.join(current, "version"), "utf8")).toBe("new");
    expect(FS.readFileSync(Path.join(target, "version"), "utf8")).toBe("someone else's");
    expect(FS.existsSync(`${current}.studio-update-old`)).toBe(false);
  });

  itPosix("deletes a folder holding an app bundle", async () => {
    const dir = makeScratch();
    const resources = Path.join(dir, "staged", "Studio.app", "Contents", "Resources");
    FS.mkdirSync(resources, { recursive: true });
    writeAsar(Path.join(resources, "app.asar"));

    await removeTree(Path.join(dir, "staged"));

    expect(FS.existsSync(Path.join(dir, "staged"))).toBe(false);
  });

  it.skipIf(process.platform !== "darwin" || electronBinary === null)(
    "replaces a leftover staged bundle when running inside Electron",
    () => {
      const dir = makeScratch();
      const zip = makeAppZip(dir, "0.2.10");
      const staged = Path.join(dir, "pending-update", "staged");
      const leftover = Path.join(staged, "Studio.app", "Contents", "Resources");
      FS.mkdirSync(leftover, { recursive: true });
      writeAsar(Path.join(leftover, "app.asar"));
      const runner = Path.join(dir, "runner.mjs");
      const modulePath = fileURLToPath(new URL("./macSwapInstall.ts", import.meta.url));
      FS.writeFileSync(
        runner,
        `const { unpackAppZip, readBundleIdentity } = await import(${JSON.stringify(modulePath)});
const bundle = await unpackAppZip(process.argv[2], process.argv[3]);
console.log(JSON.stringify(await readBundleIdentity(bundle)));`,
      );

      const output = execFileSync(electronBinary ?? "", [runner, zip, staged], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(JSON.parse(output.trim().split("\n").at(-1) ?? "{}")).toEqual({
        bundleId: null,
        version: "0.2.10",
      });
    },
    40_000,
  );
});

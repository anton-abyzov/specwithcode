import { afterEach, describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import { join } from "node:path";
import * as Option from "effect/Option";
import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-home-selection-"));
  homes.push(dir);
  return dir;
};
describe("desktop home selection", () => {
  it("keeps the branded profile after a legacy managed service is added", () => {
    const dir = home();
    mkdirSync(join(dir, ".specwithcode", "userdata"), { recursive: true });
    const resolve = () =>
      resolveDesktopBaseDir({ homeDirectory: dir, joinPath: join, studioHome: Option.none() });
    expect(resolve()).toBe(join(dir, ".specwithcode"));
    mkdirSync(join(dir, ".specweave-studio", "m4", "userdata"), { recursive: true });
    expect(resolve()).toBe(join(dir, ".specwithcode"));
  });
  it("preserves explicit STUDIO_HOME even when both standalone roots exist", () => {
    const dir = home();
    for (const root of [".specwithcode", ".specweave-studio"])
      mkdirSync(join(dir, root, "userdata"), { recursive: true });
    const custom = join(dir, "explicit-store");
    expect(
      resolveDesktopBaseDir({
        homeDirectory: dir,
        joinPath: join,
        studioHome: Option.some(custom),
      }),
    ).toBe(custom);
  });
});

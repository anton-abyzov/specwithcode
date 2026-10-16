import { afterEach, describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native disk fixtures independently verify bootstrap profile-root selection.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native disk fixtures independently verify bootstrap profile-root selection.
import { join } from "node:path";
import {
  canonicalStudioPath,
  studioDefaultHome,
  studioIdentityHome,
  studioInstallDirectory,
  STUDIO_NAME,
  studioRootDirectory,
} from "./studioIdentity.ts";
const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "specwithcode-home-"));
  homes.push(dir);
  return dir;
};
afterEach(() => homes.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
describe("SpecWithCode storage", () => {
  it("uses the public name for fresh installations", () => {
    const dir = home();
    expect(STUDIO_NAME).toBe("SpecWithCode");
    expect(studioDefaultHome(dir)).toBe(join(dir, ".specwithcode"));
  });
  it.each(["userdata", "dev"])(
    "keeps real legacy standalone %s authoritative when both roots exist",
    (state) => {
      const dir = home();
      mkdirSync(join(dir, ".specweave-studio", state), { recursive: true });
      mkdirSync(join(dir, ".specwithcode", "userdata"), { recursive: true });
      expect(studioDefaultHome(dir)).toBe(join(dir, ".specweave-studio"));
    },
  );
  it("retains a legacy-only default", () => {
    const dir = home();
    mkdirSync(join(dir, ".specweave-studio"));
    expect(studioDefaultHome(dir)).toBe(join(dir, ".specweave-studio"));
  });
  it("does not hide branded standalone history when a managed identity is installed", () => {
    const dir = home();
    const branded = join(dir, ".specwithcode");
    mkdirSync(join(branded, "userdata"), { recursive: true });
    const history = join(branded, "userdata", "history-proof.txt");
    writeFileSync(history, "retained standalone history");
    expect(studioDefaultHome(dir)).toBe(branded);
    const managed = join(dir, ".specweave-studio", "m4");
    mkdirSync(join(managed, "userdata"), { recursive: true });
    writeFileSync(join(managed, "installation.json"), "{}\n");
    expect(studioDefaultHome(dir)).toBe(branded);
    expect(studioDefaultHome(dir)).toBe(branded);
    expect(readFileSync(history, "utf8")).toBe("retained standalone history");
  });
  it("retains branded storage when the legacy root is only an empty or managed container", () => {
    const dir = home();
    mkdirSync(join(dir, ".specweave-studio"));
    mkdirSync(join(dir, ".specwithcode"));
    expect(studioDefaultHome(dir)).toBe(join(dir, ".specwithcode"));
  });
  it("resolves a symlinked (migrated) legacy root to the branded one", () => {
    const dir = home();
    const branded = join(dir, ".specwithcode");
    mkdirSync(join(branded, "userdata"), { recursive: true });
    symlinkSync(branded, join(dir, ".specweave-studio"));
    expect(studioRootDirectory(dir)).toBe(branded);
    expect(studioDefaultHome(dir)).toBe(branded);
  });
});

describe("SpecWithCode install directory", () => {
  const legacyInstall = (dir: string) => join(dir, ".local", "share", "specweave-studio");
  it("uses <root>/install on a fresh machine", () => {
    const dir = home();
    expect(studioInstallDirectory(dir)).toBe(join(dir, ".specwithcode", "install"));
  });
  it("keeps the legacy install directory before migration", () => {
    const dir = home();
    mkdirSync(join(legacyInstall(dir), "releases"), { recursive: true });
    expect(studioInstallDirectory(dir)).toBe(legacyInstall(dir));
  });
  it("uses the branded install directory once it exists or the legacy one is a link", () => {
    const dir = home();
    const branded = join(dir, ".specwithcode", "install");
    mkdirSync(branded, { recursive: true });
    mkdirSync(join(dir, ".local", "share"), { recursive: true });
    symlinkSync(branded, legacyInstall(dir));
    expect(studioInstallDirectory(dir)).toBe(branded);
    const other = home();
    mkdirSync(legacyInstall(other), { recursive: true });
    mkdirSync(join(other, ".specwithcode", "install"), { recursive: true });
    expect(studioInstallDirectory(other)).toBe(join(other, ".specwithcode", "install"));
  });
  it("is resolved independently of the profile root", () => {
    const dir = home();
    mkdirSync(join(dir, ".specweave-studio", "userdata"), { recursive: true });
    expect(studioRootDirectory(dir)).toBe(join(dir, ".specweave-studio"));
    expect(studioInstallDirectory(dir)).toBe(join(dir, ".specwithcode", "install"));
  });
});

describe("SpecWithCode identity homes", () => {
  it("uses the branded identity home by default", () => {
    const dir = home();
    expect(studioIdentityHome(dir, "m4")).toBe(join(dir, ".specwithcode", "m4"));
  });
  it("keeps an unmigrated legacy service beside a fresh branded profile", () => {
    const dir = home();
    mkdirSync(join(dir, ".specwithcode", "userdata"), { recursive: true });
    mkdirSync(join(dir, ".specweave-studio", "m4"), { recursive: true });
    expect(studioIdentityHome(dir, "m4")).toBe(join(dir, ".specweave-studio", "m4"));
    expect(studioIdentityHome(dir, "m1")).toBe(join(dir, ".specwithcode", "m1"));
  });
  it("prefers the branded identity home once it exists or the legacy root is a link", () => {
    const dir = home();
    mkdirSync(join(dir, ".specweave-studio", "m4"), { recursive: true });
    mkdirSync(join(dir, ".specwithcode", "m4"), { recursive: true });
    expect(studioIdentityHome(dir, "m4")).toBe(join(dir, ".specwithcode", "m4"));
    const linked = home();
    mkdirSync(join(linked, ".specwithcode", "m1"), { recursive: true });
    symlinkSync(join(linked, ".specwithcode"), join(linked, ".specweave-studio"));
    expect(studioIdentityHome(linked, "m1")).toBe(join(linked, ".specwithcode", "m1"));
  });
});

describe("canonicalStudioPath", () => {
  it("rewrites paths under a linked legacy root to the branded root", () => {
    const dir = home();
    mkdirSync(join(dir, ".specwithcode", "install"), { recursive: true });
    symlinkSync(join(dir, ".specwithcode"), join(dir, ".specweave-studio"));
    mkdirSync(join(dir, ".local", "share"), { recursive: true });
    symlinkSync(
      join(dir, ".specwithcode", "install"),
      join(dir, ".local", "share", "specweave-studio"),
    );
    expect(canonicalStudioPath(join(dir, ".specweave-studio"), dir)).toBe(
      join(dir, ".specwithcode"),
    );
    expect(canonicalStudioPath(join(dir, ".specweave-studio", "m4", "worktrees", "a"), dir)).toBe(
      join(dir, ".specwithcode", "m4", "worktrees", "a"),
    );
    expect(
      canonicalStudioPath(join(dir, ".local", "share", "specweave-studio", "releases", "x"), dir),
    ).toBe(join(dir, ".specwithcode", "install", "releases", "x"));
  });
  it("leaves real legacy paths, look-alike siblings and other paths alone", () => {
    const dir = home();
    mkdirSync(join(dir, ".specweave-studio", "m4"), { recursive: true });
    const legacy = join(dir, ".specweave-studio", "m4");
    expect(canonicalStudioPath(legacy, dir)).toBe(legacy);
    const linked = home();
    mkdirSync(join(linked, ".specwithcode"), { recursive: true });
    symlinkSync(join(linked, ".specwithcode"), join(linked, ".specweave-studio"));
    const sibling = join(linked, ".specweave-studio-other", "x");
    expect(canonicalStudioPath(sibling, linked)).toBe(sibling);
    expect(canonicalStudioPath("/elsewhere/.specweave-studio/x", linked)).toBe(
      "/elsewhere/.specweave-studio/x",
    );
  });
});

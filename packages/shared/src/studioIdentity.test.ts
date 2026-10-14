import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studioDefaultHome, STUDIO_NAME } from "./studioIdentity";
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
});

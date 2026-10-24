// @effect-diagnostics nodeBuiltinImport:off - The identity checks run against real folders.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { afterEach, assert, it } from "@effect/vitest";
import { nodePath as NodePath } from "../nodePath.ts";
import {
  approvedFolderReaching,
  exposesProtectedFolder,
  exposesProtectedLocation,
} from "./ProjectEnvironmentPaths.ts";

/** The spelling checks run on POSIX paths; the identity checks below use the native ones. */
const posix = NodePath.posix;
const home = "/Users/person";

it("refuses root, home, its ancestors and credential folders as approved project folders", () => {
  for (const folder of [
    "/",
    "/Users",
    home,
    `${home}/.ssh`,
    `${home}/.ssh/keys`,
    `${home}/.aws`,
    `${home}/.config/gh`,
    `${home}/.config`,
    `${home}/.codex/sessions`,
    `${home}/Library/Keychains`,
    `${home}/Library`,
  ])
    assert.isTrue(exposesProtectedLocation(folder, home, posix), folder);
});

it("accepts ordinary project and data folders", () => {
  for (const folder of [
    `${home}/Projects/app`,
    `${home}/.config/app-settings`,
    `${home}/Library/Application Support/app`,
    `${home}/Documents/contracts`,
    "/srv/data",
  ])
    assert.isFalse(exposesProtectedLocation(folder, home, posix), folder);
});

/** Native path semantics, matching the real paths the identity checks read and return. */
const path = NodePath;
const scratch: string[] = [];
afterEach(() => {
  for (const folder of scratch.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

/** A real temporary tree with a home folder holding `.ssh` and a project. */
const tree = () => {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(path.join(NodeOS.tmpdir(), "env-paths-")));
  scratch.push(base);
  const dir = (name: string) => {
    NodeFS.mkdirSync(path.join(base, name), { recursive: true });
    return path.join(base, name);
  };
  return { base, dir, home: dir("home"), ssh: dir("home/.ssh"), project: dir("home/project") };
};

/** Whether `base` sits on a case-insensitive volume, where `Ab` and `ab` are one folder. */
const caseInsensitive = (base: string) => {
  NodeFS.mkdirSync(path.join(base, "case-probe-Ab"));
  return NodeFS.existsSync(path.join(base, "case-probe-ab"));
};

it("refuses another letter case of home or a credential folder by identity", async () => {
  const { base, home, ssh, project } = tree();
  for (const folder of [
    home,
    ssh,
    path.join(ssh, "keys"),
    path.join(home, ".SSH"),
    home.toUpperCase(),
    base,
    "/",
  ])
    assert.isTrue(await exposesProtectedFolder(folder, home, path), folder);
  assert.isFalse(await exposesProtectedFolder(project, home, path));
  assert.isTrue(await exposesProtectedFolder(path.join(base, "missing"), home, path));
});

it("refuses folders holding a credential folder that does not exist yet", async () => {
  const { dir, home } = tree();
  for (const folder of [dir("home/.config"), dir("home/Library")])
    assert.isTrue(await exposesProtectedFolder(folder, home, path), folder);
  for (const folder of [dir("home/.config/app-settings"), dir("home/Projects/x")])
    assert.isFalse(await exposesProtectedFolder(folder, home, path), folder);
});

it("refuses folders holding a credential folder inside home by identity", async () => {
  const { base, dir, home } = tree();
  const config = path.dirname(dir("home/.config/gh"));
  const library = path.dirname(dir("home/Library/Keychains"));
  const spellings = [config, library];
  if (caseInsensitive(base)) spellings.push(path.join(home, ".CONFIG"), path.join(home, "library"));
  for (const folder of spellings)
    assert.isTrue(await exposesProtectedFolder(folder, home, path), folder);
  for (const folder of [dir("home/.config/app-settings"), dir("home/Projects/x")])
    assert.isFalse(await exposesProtectedFolder(folder, home, path), folder);
});

it("refuses a second mount of home, its holders and its credential folders on macOS", async (context) => {
  const data = "/System/Volumes/Data";
  if (process.platform !== "darwin" || !NodeFS.existsSync(data)) return context.skip();
  const { dir, home, ssh, project } = tree();
  const config = path.dirname(dir("home/.config/gh"));
  const segments = home.split(path.sep).filter(Boolean);
  // `/System/Volumes/Data/<tmp>/home` is the same folder as `<tmp>/home`, and its realpath
  // keeps the long spelling, so only identity can tell.
  assert.strictEqual(NodeFS.realpathSync.native(`${data}${ssh}`), `${data}${ssh}`);
  for (const folder of [
    `${data}${ssh}`,
    `${data}${ssh}/keys`,
    `${data}${config}`,
    `${data}${home}`,
    `${data}/${segments[0]}`,
    data,
    "/System/Volumes",
    "/System",
  ])
    assert.isTrue(await exposesProtectedFolder(folder, home, path), folder);
  assert.isFalse(await exposesProtectedFolder(`${data}${project}`, home, path));
});

it("refuses the folders holding the real home on macOS", async (context) => {
  const home = NodeOS.homedir();
  if (process.platform !== "darwin" || !NodeFS.existsSync(`/System/Volumes/Data${home}`))
    return context.skip();
  for (const folder of ["/System", "/System/Volumes", "/System/Volumes/Data", "/Users", "/"])
    assert.isTrue(await exposesProtectedFolder(folder, home, path), folder);
});

it("checks only by spelling against a home that does not exist", async () => {
  const { base, dir } = tree();
  const gone = path.join(base, "gone");
  assert.isFalse(await exposesProtectedFolder(dir("project"), gone, path));
  for (const folder of [base, "/"])
    assert.isTrue(await exposesProtectedFolder(folder, gone, path), folder);
});

it("accepts a folder holding a symlink spelled like the path to home", async () => {
  const { base, dir, home } = tree();
  const name = path.basename(home);
  const decoy = dir("decoy");
  NodeFS.symlinkSync(home, path.join(decoy, name));
  const nested = dir(path.join("nested", path.basename(base)));
  NodeFS.symlinkSync(home, path.join(nested, name));
  for (const folder of [decoy, path.dirname(nested)])
    assert.isFalse(await exposesProtectedFolder(folder, home, path), folder);
});

it("refuses a credential folder linked outside home, inside it or above it", async () => {
  const { base, dir, home, project } = tree();
  const vault = dir("vault/keys");
  NodeFS.rmSync(path.join(home, ".ssh"), { recursive: true });
  NodeFS.symlinkSync(path.dirname(vault), path.join(home, ".ssh"));
  for (const folder of [path.dirname(vault), vault, base])
    assert.isTrue(await exposesProtectedFolder(folder, home, path), folder);
  assert.isFalse(await exposesProtectedFolder(project, home, path));
  assert.isFalse(await exposesProtectedFolder(dir("elsewhere"), home, path));
});

it("finds the approved folder that already reaches a folder by identity", async () => {
  const { dir, project } = tree();
  const src = dir("home/project/src");
  const other = dir("other");
  assert.deepStrictEqual(await approvedFolderReaching(project, [other, project], path), {
    folder: project,
    same: true,
  });
  assert.deepStrictEqual(await approvedFolderReaching(src, [project], path), {
    folder: project,
    same: false,
  });
  assert.isUndefined(await approvedFolderReaching(other, [project, `${project}-gone`], path));
});

it("tells distinct folders apart by letter case only on a case-sensitive volume", async () => {
  const { base, dir } = tree();
  const upper = dir("Proj");
  if (caseInsensitive(base)) {
    // One folder under two spellings: already reachable.
    assert.deepStrictEqual(await approvedFolderReaching(path.join(base, "proj"), [upper], path), {
      folder: upper,
      same: true,
    });
    return;
  }
  const lower = dir("proj");
  assert.isUndefined(await approvedFolderReaching(lower, [upper], path));
  const home = dir("home");
  dir("home/.ssh");
  assert.isFalse(await exposesProtectedFolder(dir("home/.SSH"), home, path));
});

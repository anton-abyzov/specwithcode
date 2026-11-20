// @effect-diagnostics nodeBuiltinImport:off - looks for tools and marker files by name on this machine.
/**
 * Whether this machine has the command-line tool a credential's commands run,
 * where, and the commands as this machine must type them. A sign-in command
 * for a tool that is not installed fails, so a row names the install first.
 *
 * A tool is looked for in three places, in this order: the folders a new
 * Terminal window searches, the app's own tool folders, and the project's own
 * copy (a folder whose `package.json` lists it, with `node_modules/.bin`).
 * Nothing here runs anything: tools are found by name and files are seen, at
 * most a `package.json` is read.
 *
 * Every command is built from the app's list. The pieces that come from
 * outside it are folder paths: the real path of a folder found under a
 * project registered on this machine, and the folder a tool was found in.
 * Each is written as one shell word. A command for a tool a new Terminal
 * window would not find starts by adding the tool's folder to PATH, so it
 * runs as written: most of these tools are scripts that look for `node`.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  ProjectCredentialId,
  ProjectCredentialTool,
  ProjectCredentialToolState,
} from "@specweave-studio/contracts";

import {
  CREDENTIAL_HOME_FILES,
  CREDENTIAL_XDG_FILES,
  type CredentialEntry,
  type CredentialTool,
  signInCommand,
} from "./catalog.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_FOLDER_LENGTH = 4096;
/** The longest folder, as a shell word, a command is built around. Longer ones are not offered. */
const MAX_FOLDER_WORD = 2048;
/** What the wire allows for a command and for a path. */
const MAX_COMMAND = 4700;
const MAX_PATH = 4096;
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** macOS and Windows folders ignore case: `/Users/Me/App` is `/users/me/app` there. */
const comparable = (path: string, platform: NodeJS.Platform) =>
  platform === "darwin" || platform === "win32" ? path.normalize("NFC").toLowerCase() : path;

const inside = (root: string, value: string) => {
  const relative = NodePath.relative(root, value);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/**
 * Project folders as they really are on disk, so a root stored through a link
 * still matches a tool's real path. An empty root, a relative one and the top
 * of the disk are dropped: the first two would be read against the server's
 * own folder, the last would rule out every tool.
 */
async function realProjectRoots(
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Promise<Array<string>> {
  const roots: Array<string> = [];
  for (const root of projectRoots) {
    if (root.trim() === "" || !NodePath.isAbsolute(root)) continue;
    const resolved = NodePath.resolve(root);
    const real = await NodeFSP.realpath(resolved).catch(() => resolved);
    for (const candidate of new Set([resolved, real]))
      if (candidate !== NodePath.parse(candidate).root) roots.push(comparable(candidate, platform));
  }
  return roots;
}

/** Whether a path, links followed, is inside any registered project. */
export async function insideProjects(
  path: string,
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (!NodePath.isAbsolute(path)) return false;
  const roots = await realProjectRoots(projectRoots, platform);
  const resolved = NodePath.resolve(path);
  const real = await NodeFSP.realpath(resolved).catch(() => resolved);
  return [resolved, real].some((candidate) =>
    roots.some((root) => inside(root, comparable(candidate, platform))),
  );
}

/**
 * The folders that are not inside a registered project. A tool run by full
 * path still finds `node` or `python` through PATH, so a project folder on
 * PATH would hand the project the check.
 */
export async function foldersOutsideProjects(
  folders: ReadonlyArray<string>,
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Promise<Array<string>> {
  const kept: Array<string> = [];
  for (const folder of folders)
    if (NodePath.isAbsolute(folder) && !(await insideProjects(folder, projectRoots, platform)))
      kept.push(folder);
  return kept;
}

export interface FoundTool {
  /** The folder of the list it was found in. */
  readonly folder: string;
  /** As a person would type it: that folder and the name. */
  readonly path: string;
  /** Where it really is, links followed. */
  readonly real: string;
}

/**
 * The first folder that has the tool as an executable file. A copy whose real
 * location is inside one of `projectRoots` is passed over: a project never
 * supplies the tool that is asked about the person's sign-ins.
 */
export async function findTool(
  binary: string,
  folders: ReadonlyArray<string>,
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Promise<FoundTool | null> {
  if (binary === "" || binary.includes("/") || binary.includes("\\")) return null;
  const roots = await realProjectRoots(projectRoots, platform);
  for (const folder of folders) {
    if (!NodePath.isAbsolute(folder)) continue;
    const path = NodePath.join(folder, binary);
    const real = await NodeFSP.realpath(path).catch(() => null);
    if (real === null) continue;
    if (roots.some((root) => inside(root, comparable(real, platform)))) continue;
    const usable = await NodeFSP.stat(real)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (!usable) continue;
    const executable = await NodeFSP.access(real, NodeFS.constants.X_OK).then(
      () => true,
      () => false,
    );
    if (executable) return { folder, path, real };
  }
  return null;
}

/** The tool's real path, from the first folder that has it. */
export const resolveProbeBinary = (
  binary: string,
  folders: ReadonlyArray<string>,
  projectRoots: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Promise<string | null> =>
  findTool(binary, folders, projectRoots, platform).then((found) => found?.real ?? null);

/** Absolute folders of a PATH value, in order, each once. A relative entry would be read against a project. */
export function pathFolders(value: string | undefined, platform: NodeJS.Platform): Array<string> {
  const folders: Array<string> = [];
  for (const entry of (value ?? "").split(platform === "win32" ? ";" : ":")) {
    const folder = entry.trim();
    if (folder === "" || !NodePath.isAbsolute(folder) || folders.includes(folder)) continue;
    folders.push(folder);
  }
  return folders;
}

/** One shell word: as it is when plain, single-quoted otherwise. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** `command` with the tool's name, wherever it starts a command, typed as `as`. */
export function commandWithTool(command: string, binary: string, as: string): string {
  const name = new RegExp(`(^|&&\\s*|\\|\\|\\s*|;\\s*)${escapeRegExp(binary)}(?=\\s|$)`, "gu");
  return command.replace(name, (_, before: string) => `${before}${as}`);
}

/** A source's folder as path parts under a project, or null for anything that could leave it. */
export function relativeFolderParts(folder: string): Array<string> | null {
  if (folder === "" || folder.length > MAX_FOLDER_LENGTH) return null;
  // Control characters have no place in a folder shown beside a command.
  if (UNPRINTABLE.test(folder)) return null;
  if (folder.startsWith("/") || folder.startsWith("\\") || /^[A-Za-z]:/u.test(folder)) return null;
  const parts = folder.split("/").filter((part) => part !== "" && part !== ".");
  return parts.some((part) => part === ".." || part.includes("\\")) ? null : parts;
}

/** Reads a small regular file without following a link; null for anything else. */
async function readSmallFile(absolute: string): Promise<string | null> {
  let handle: NodeFSP.FileHandle | null = null;
  try {
    handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsePackageJson = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** Whether a `package.json` lists the package as a dependency of any kind. */
export function declaresPackage(text: string, npmPackage: string): boolean {
  const manifest = parsePackageJson(text);
  if (manifest === null) return false;
  return DEPENDENCY_FIELDS.some((field) => {
    const listed = manifest[field];
    return isRecord(listed) && Object.hasOwn(listed, npmPackage);
  });
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

/** `folder` and each folder above it, up to and including `root`. */
function upTo(root: string, folder: string): Array<string> {
  const folders: Array<string> = [];
  for (let current = folder; inside(root, current); current = NodePath.dirname(current)) {
    folders.push(current);
    if (current === root || current === NodePath.dirname(current)) break;
  }
  return folders;
}

export interface ProjectPackage {
  /** The real folder whose `package.json` lists the tool. */
  readonly folder: string;
  /** The tool as `npx` would find it from that folder, or null before the project's install. */
  readonly bin: string | null;
  /** Where that link really leads, checked to be inside the project: the file a check runs. */
  readonly binReal: string | null;
  readonly manager: PackageManager;
}

/**
 * The project's own copy of a tool: the first of `folders` (project-relative,
 * from the machine the project came from) that exists under `root`, stays
 * under it once links are followed, and whose own `package.json` lists the
 * package. What the other machine said is a hint; this machine's files decide.
 */
export async function projectPackage(input: {
  readonly root: string;
  readonly folders: ReadonlyArray<string>;
  readonly tool: CredentialTool;
  readonly platform: NodeJS.Platform;
}): Promise<ProjectPackage | null> {
  const { tool, platform } = input;
  if (tool.npmPackage === null || !NodePath.isAbsolute(input.root)) return null;
  const root = await NodeFSP.realpath(input.root).catch(() => null);
  if (root === null || root === NodePath.parse(root).root) return null;
  const within = (path: string) => inside(comparable(root, platform), comparable(path, platform));
  let declared: ProjectPackage | null = null;
  for (const relative of input.folders) {
    const parts = relativeFolderParts(relative);
    if (parts === null) continue;
    const folder = await NodeFSP.realpath(NodePath.join(root, ...parts)).catch(() => null);
    if (folder === null || !within(folder)) continue;
    // The folder is shown inside commands: a link can lead to a name the hint never had.
    if (UNPRINTABLE.test(folder) || shellWord(folder).length > MAX_FOLDER_WORD) continue;
    const manifest = await readSmallFile(NodePath.join(folder, "package.json"));
    if (manifest === null || !declaresPackage(manifest, tool.npmPackage)) continue;
    const above = upTo(root, folder);
    let bin: string | null = null;
    let binReal: string | null = null;
    for (const current of above) {
      const candidate = NodePath.join(current, "node_modules", ".bin", tool.binary);
      const real = await NodeFSP.realpath(candidate).catch(() => null);
      // A link out of the project is someone else's tool, not the project's.
      if (real !== null && within(real)) {
        bin = candidate;
        binReal = real;
        break;
      }
    }
    let manager: PackageManager | null = null;
    const pinned = parsePackageJson(manifest)?.["packageManager"];
    if (typeof pinned === "string")
      manager =
        (["pnpm", "yarn", "bun", "npm"] as const).find((name) => pinned.startsWith(`${name}@`)) ??
        null;
    for (const current of above) {
      if (manager !== null) break;
      for (const [file, name] of LOCKFILES)
        if (await exists(NodePath.join(current, file))) {
          manager = name;
          break;
        }
    }
    const found = { folder, bin, binReal, manager: manager ?? "npm" };
    // A folder that already has the tool is the one to use.
    if (bin !== null) return found;
    declared ??= found;
  }
  return declared;
}

export interface ToolMachine {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** Where tools are looked for, in order: the Terminal's folders, the system's, the app's own. */
  readonly folders: ReadonlyArray<string>;
  /** The part of `folders` a new Terminal window searches. */
  readonly terminalFolders: ReadonlyArray<string>;
  /** The part of `folders` SpecWithCode installed tools into. */
  readonly appFolders: ReadonlyArray<string>;
  /** Every project registered here: a tool from inside one is passed over. */
  readonly projectRoots: ReadonlyArray<string>;
  /** This machine's copy of the project being asked about, when it has one. */
  readonly projectRoot: string | null;
  /** The person's `XDG_CONFIG_HOME`, when they set one. */
  readonly xdgConfigHome: string | null;
}

export interface LocatedTool {
  readonly state: ProjectCredentialToolState;
  /** On PATH or in the app's folders. */
  readonly found: FoundTool | null;
  /** The project's own copy, or its declaration before the install. */
  readonly project: ProjectPackage | null;
}

/** Where this machine has a credential's tool. */
export async function locateTool(
  machine: ToolMachine,
  tool: CredentialTool,
  packageFolders: ReadonlyArray<string>,
): Promise<LocatedTool> {
  const found = await findTool(
    tool.binary,
    machine.folders,
    machine.projectRoots,
    machine.platform,
  );
  if (found !== null)
    return {
      // `app` is for SpecWithCode's own folders only. A system folder the Terminal's PATH
      // happens to lack is still the machine's own tool, with the plain row.
      state:
        !machine.terminalFolders.includes(found.folder) && machine.appFolders.includes(found.folder)
          ? "app"
          : "terminal",
      found,
      project: null,
    };
  const project =
    machine.projectRoot === null || packageFolders.length === 0
      ? null
      : await projectPackage({
          root: machine.projectRoot,
          folders: packageFolders,
          tool,
          platform: machine.platform,
        });
  return { state: project?.bin ? "project" : "missing", found: null, project };
}

/**
 * What a command must start with so a new Terminal window finds a tool that
 * is in `folder`: nothing when Terminal already searches it, else the folder
 * added to PATH. The full path alone is not enough: the tool is often a
 * script that looks for `node` through PATH, and `node` sits beside it.
 */
const reach = (machine: ToolMachine, found: FoundTool): string =>
  machine.terminalFolders.includes(found.folder)
    ? ""
    : `export PATH=${shellWord(found.folder)}:"$PATH" && `;

const helper = (machine: ToolMachine, binary: string) =>
  findTool(binary, machine.folders, machine.projectRoots, machine.platform);

async function installOf(
  machine: ToolMachine,
  tool: CredentialTool,
  located: LocatedTool,
): Promise<{ readonly command: string; readonly newShell: boolean } | null> {
  if (located.state !== "missing") return null;
  if (located.project !== null) {
    // The project brings the tool: its own install puts it in place, with nothing global.
    const { folder, manager } = located.project;
    const into = `cd ${shellWord(folder)} && `;
    // The tool runs through npx or npm afterwards. A manager that stands alone on a machine
    // without them would install what could not then be run: Node.js comes first there.
    const npx = await helper(machine, "npx");
    if (npx === null && (await helper(machine, "npm")) === null) return null;
    const own = await helper(machine, manager);
    if (own !== null)
      return { command: `${into}${reach(machine, own)}${manager} install`, newShell: false };
    // npm's own runner fetches a manager this machine lacks.
    return npx === null || manager === "npm"
      ? null
      : {
          command: `${into}${reach(machine, npx)}npx --yes ${manager} install`,
          newShell: false,
        };
  }
  if (tool.npmPackage !== null) {
    const npm = await helper(machine, "npm");
    if (npm !== null)
      return {
        command: `${reach(machine, npm)}npm install --global ${tool.npmPackage}`,
        newShell: false,
      };
  }
  // A cask is a macOS package: Homebrew on Linux has none.
  if (tool.brew !== null && (machine.platform === "darwin" || !tool.brew.startsWith("--cask"))) {
    const brew = await helper(machine, "brew");
    if (brew !== null)
      return { command: `${reach(machine, brew)}brew install ${tool.brew}`, newShell: false };
  }
  if (tool.installer === null) return null;
  // The maker's installer is fetched with curl: without it the command could not start.
  const curl = await helper(machine, "curl");
  return curl === null
    ? null
    : {
        command: `${reach(machine, curl)}${tool.installer.command}`,
        newShell: tool.installer.newShell,
      };
}

/**
 * The tool's place on this machine and its commands as this machine runs
 * them. Null when a command would not fit what the wire allows: the row then
 * shows the app's plain commands instead of losing every row's answer.
 */
export async function describeTool(
  machine: ToolMachine,
  entry: CredentialEntry,
  located: LocatedTool,
): Promise<ProjectCredentialTool | null> {
  const tool = entry.tool;
  if (tool === null) return null;
  const signIn = signInCommand(entry, machine.platform);
  // A project's own tool runs through npx from its folder, which may itself need finding. A
  // machine with npm and no npx runs it through npm, which does the same. With neither, Node.js
  // is what is missing, and the commands are the ones that work once it is there.
  const npx = located.project === null ? null : await helper(machine, "npx");
  const npm = located.project === null || npx !== null ? null : await helper(machine, "npm");
  const runner = npx ?? npm;
  const through = `${npx === null && npm !== null ? "npm exec --" : "npx"} ${tool.binary}`;
  const typed = (command: string): string => {
    if (located.project !== null)
      return `cd ${shellWord(located.project.folder)} && ${runner === null ? "" : reach(machine, runner)}${commandWithTool(command, tool.binary, through)}`;
    if (located.found !== null) return `${reach(machine, located.found)}${command}`;
    return command;
  };
  const install = await installOf(machine, tool, located);
  const described: ProjectCredentialTool = {
    name: tool.binary,
    state: located.state,
    folder: located.project?.folder ?? null,
    install: install?.command ?? null,
    newShell: install?.newShell ?? false,
    signIn: typed(signIn),
    check: entry.check === null ? null : typed(entry.check),
    appPath: located.state === "app" && located.found !== null ? located.found.path : null,
    // Missing with no command to offer, though its install is npm's: Node.js is what is missing.
    ...(located.state === "missing" &&
    install === null &&
    (located.project !== null || tool.npmPackage !== null)
      ? { needsNode: true }
      : {}),
  };
  const fits =
    [described.install, described.signIn, described.check].every(
      (command) => command === null || command.length <= MAX_COMMAND,
    ) &&
    [described.folder, described.appPath].every((path) => path === null || path.length <= MAX_PATH);
  return fits ? described : null;
}

/**
 * Whether a sign-in file for the credential is on this machine, seen by name
 * and never opened. A file can be stale, so it is a hint for a check that
 * could not answer, and never an answer of its own.
 */
export async function hasSignInFile(
  machine: Pick<ToolMachine, "home" | "xdgConfigHome">,
  id: ProjectCredentialId,
): Promise<boolean> {
  const candidates = CREDENTIAL_HOME_FILES[id]
    // An SSH config names hosts; it is not a key.
    .filter((file) => !(id === "ssh" && NodePath.basename(file) === "config"))
    .map((file) => NodePath.join(machine.home, file));
  if (machine.xdgConfigHome !== null && NodePath.isAbsolute(machine.xdgConfigHome))
    for (const file of CREDENTIAL_XDG_FILES[id] ?? [])
      candidates.push(NodePath.join(machine.xdgConfigHome, file));
  for (const candidate of candidates) {
    const file = await NodeFSP.stat(candidate)
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (file) return true;
  }
  return false;
}

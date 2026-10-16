// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Plain promises that mirror the SpecWeave CLI hub store.
/**
 * Reads and appends to a SpecWeave project hub (`.specweave/project/hub.json`)
 * for the project Library. The hub belongs to the SpecWeave CLI, so writes
 * follow its rules exactly: an exclusive `hub.json.lock`, a revision check
 * against what the person saw, the same field limits, and an atomic rename.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PROJECT_HUB_PATH,
  PROJECT_LIBRARY_FOLDERS,
  type ProjectLibraryArtifact,
  type ProjectLibraryFolder,
  type ProjectLibrarySnapshot,
} from "@specweave-studio/contracts";

const HUB_MAX_BYTES = 512 * 1024;
const MAX_ARTIFACTS = 200;

export class ProjectLibraryProblem extends Error {
  readonly code: "not_specweave" | "invalid" | "conflict";
  constructor(code: "not_specweave" | "invalid" | "conflict", message: string) {
    super(message);
    this.code = code;
  }
}

interface HubArtifact {
  id: string;
  title: string;
  location: string;
  kind: "file" | "link";
  intentId: string | null;
  createdAt: string;
}

interface Hub {
  version: 1;
  revision: number;
  updatedAt: string | null;
  name: string;
  artifacts: HubArtifact[];
  [field: string]: unknown;
}

/** The SpecWeave CLI's hub field limits; a hub past any of them is corrupt to the CLI. */
const LIMITS = { name: 180, goal: 2000, context: 16000, title: 180, location: 2000, routines: 100 };

function within(value: unknown, max: number): boolean {
  return typeof value === "string" && value.length <= max;
}

/** Whether the CLI's schema would accept this hub's sizes, so a write never corrupts it. */
function hubWithinLimits(hub: Hub): boolean {
  return (
    within(hub.name, LIMITS.name) &&
    (hub.goal === undefined || within(hub.goal, LIMITS.goal)) &&
    (hub.context === undefined || within(hub.context, LIMITS.context)) &&
    (hub.routines === undefined ||
      (Array.isArray(hub.routines) && hub.routines.length <= LIMITS.routines)) &&
    hub.artifacts.length <= MAX_ARTIFACTS &&
    hub.artifacts.every(
      (item) =>
        item.title.length > 0 &&
        within(item.title, LIMITS.title) &&
        item.location.length > 0 &&
        within(item.location, LIMITS.location) &&
        (item.intentId === null || within(item.intentId, LIMITS.title)),
    )
  );
}

/** A link the Library will open: HTTPS with a host and no credentials, as the CLI stores them. */
function isSafeLink(location: string): boolean {
  try {
    const url = new URL(location);
    return url.protocol === "https:" && url.hostname !== "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function isArtifact(value: unknown): value is HubArtifact {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.location === "string" &&
    (item.kind === "file" || item.kind === "link") &&
    (item.intentId === null || typeof item.intentId === "string") &&
    typeof item.createdAt === "string"
  );
}

function parseHub(text: string): Hub {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.name !== "string" ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.every(isArtifact)
  ) {
    throw new Error("unexpected hub shape");
  }
  return value as unknown as Hub;
}

/** The hub as stored, `null` when there is none. Symlinks are refused, as the CLI does. */
async function readHub(root: string): Promise<Hub | null> {
  await refuseSymlinks(root);
  const file = NodePath.join(root, PROJECT_HUB_PATH);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProjectLibraryProblem("invalid", "The project hub cannot be read.");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > HUB_MAX_BYTES) {
      throw new ProjectLibraryProblem(
        "invalid",
        "The project hub is not a regular file under 512 KiB.",
      );
    }
    return parseHub(await handle.readFile("utf8"));
  } catch (error) {
    if (error instanceof ProjectLibraryProblem) throw error;
    throw new ProjectLibraryProblem(
      "invalid",
      `The project hub is corrupt. Inspect ${PROJECT_HUB_PATH} before editing.`,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The CLI refuses a symlinked `.specweave`, `.specweave/project` or hub file; so does Studio. */
async function refuseSymlinks(root: string): Promise<void> {
  for (const relative of [".specweave", ".specweave/project", PROJECT_HUB_PATH]) {
    const stat = await NodeFSP.lstat(NodePath.join(root, relative)).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new ProjectLibraryProblem(
        "invalid",
        `${relative} is a symlink; SpecWithCode will not read or write through it.`,
      );
    }
  }
}

async function statWithin(root: string, relative: string) {
  const candidate = NodePath.resolve(root, relative);
  if (!inside(root, candidate)) return null;
  try {
    const real = await NodeFSP.realpath(candidate);
    if (!inside(await NodeFSP.realpath(root), real)) return null;
    return await NodeFSP.stat(real);
  } catch {
    return null;
  }
}

export async function readProjectLibrary(workspaceRoot: string): Promise<ProjectLibrarySnapshot> {
  const root = NodePath.resolve(workspaceRoot);
  const specweave = (await statWithin(root, ".specweave/config.json"))?.isFile() ?? false;
  let hub: Hub | null = null;
  let hubProblem: string | null = null;
  try {
    hub = await readHub(root);
  } catch (error) {
    hubProblem = error instanceof Error ? error.message : "The project hub cannot be read.";
  }
  // A hand-edited hub can repeat an id; the Library lists the first.
  const seen = new Set<string>();
  const unique = (hub?.artifacts ?? []).filter((item) => !seen.has(item.id) && seen.add(item.id));
  const artifacts = await Promise.all(
    unique.map(async (item): Promise<ProjectLibraryArtifact> => {
      const base = {
        id: item.id,
        title: item.title,
        location: item.location,
        kind: item.kind,
        intentId: item.intentId,
        createdAt: item.createdAt,
      };
      // The hub comes with the repository, so a link that is not plain HTTPS is never opened.
      if (item.kind === "link") return { ...base, missing: !isSafeLink(item.location) };
      const stat = await statWithin(root, item.location);
      return stat?.isFile()
        ? {
            ...base,
            byteLength: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            missing: false,
          }
        : { ...base, missing: true };
    }),
  );
  const folders: ProjectLibraryFolder[] = [];
  for (const folder of PROJECT_LIBRARY_FOLDERS) {
    const stat = await statWithin(root, folder.path);
    if (stat?.isDirectory()) {
      folders.push({
        path: folder.path,
        label: folder.label,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  return {
    workspaceRoot: root,
    specweave,
    hub: hub ? { name: hub.name, revision: hub.revision, updatedAt: hub.updatedAt } : null,
    hubProblem,
    artifacts,
    folders,
  };
}

/** The CLI's location rule: an HTTPS URL without credentials, or a file inside the project. */
async function validateLocation(
  root: string,
  raw: string,
): Promise<{ location: string; kind: "file" | "link" }> {
  const location = raw.trim();
  if (!location) throw new ProjectLibraryProblem("invalid", "Give the artifact a location.");
  if (/^https:/i.test(location)) {
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      throw new ProjectLibraryProblem("invalid", "That HTTPS link is not a valid URL.");
    }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      throw new ProjectLibraryProblem(
        "invalid",
        "Links must be HTTPS without a user name or password.",
      );
    }
    return { location: url.href, kind: "link" };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(location) || NodePath.isAbsolute(location)) {
    throw new ProjectLibraryProblem("invalid", "Use a path inside the project or an HTTPS link.");
  }
  const realRoot = await NodeFSP.realpath(root);
  const candidate = NodePath.resolve(realRoot, location);
  if (!inside(realRoot, candidate)) {
    throw new ProjectLibraryProblem("invalid", "The file must be inside the project.");
  }
  let real: string;
  try {
    real = await NodeFSP.realpath(candidate);
  } catch {
    throw new ProjectLibraryProblem("invalid", `No file at ${location}.`);
  }
  if (!inside(realRoot, real) || !(await NodeFSP.stat(real)).isFile()) {
    throw new ProjectLibraryProblem("invalid", "The artifact must be a file inside the project.");
  }
  return {
    location: NodePath.relative(realRoot, candidate).split(NodePath.sep).join("/"),
    kind: "file",
  };
}

export async function addProjectLibraryArtifact(
  workspaceRoot: string,
  input: { title: string; location: string; expectedRevision: number },
): Promise<ProjectLibrarySnapshot> {
  const root = NodePath.resolve(workspaceRoot);
  if (!(await statWithin(root, ".specweave/config.json"))?.isFile()) {
    throw new ProjectLibraryProblem(
      "not_specweave",
      "This project is not a SpecWeave project. Run specweave init in it first.",
    );
  }
  const title = input.title.trim();
  if (!title || title.length > 180) {
    throw new ProjectLibraryProblem(
      "invalid",
      "Give the artifact a title of up to 180 characters.",
    );
  }
  const location = await validateLocation(root, input.location);
  const file = NodePath.join(root, PROJECT_HUB_PATH);
  await refuseSymlinks(root);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProjectLibraryProblem(
        "conflict",
        "The project hub is being edited elsewhere. Try again in a moment.",
      );
    }
    throw error;
  }
  const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const hub: Hub = (await readHub(root)) ?? {
      version: 1,
      revision: 0,
      updatedAt: null,
      name: NodePath.basename(root).slice(0, LIMITS.name),
      goal: "",
      context: "",
      artifacts: [],
      routines: [],
    };
    if (hub.revision !== input.expectedRevision) {
      throw new ProjectLibraryProblem(
        "conflict",
        "The Library changed elsewhere. Reload and add it again.",
      );
    }
    if (hub.artifacts.length >= MAX_ARTIFACTS) {
      throw new ProjectLibraryProblem(
        "invalid",
        `The project hub holds at most ${MAX_ARTIFACTS} artifacts.`,
      );
    }
    hub.artifacts.push({
      id: NodeCrypto.randomUUID(),
      title,
      ...location,
      intentId: null,
      createdAt: new Date().toISOString(),
    });
    hub.revision += 1;
    hub.updatedAt = new Date().toISOString();
    if (!hubWithinLimits(hub)) {
      throw new ProjectLibraryProblem(
        "invalid",
        "That artifact would put the project hub past SpecWeave's limits (a title of 180 characters, a location of 2,000).",
      );
    }
    const data = `${JSON.stringify(hub, null, 2)}\n`;
    if (Buffer.byteLength(data) > HUB_MAX_BYTES) {
      throw new ProjectLibraryProblem("invalid", "The project hub would exceed 512 KiB.");
    }
    await NodeFSP.writeFile(temp, data, { flag: "wx", mode: 0o600 });
    await NodeFSP.rename(temp, file);
  } finally {
    // The lock is released even when closing or cleaning up fails.
    await handle.close().catch(() => undefined);
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
    await NodeFSP.unlink(lock).catch(() => undefined);
  }
  return readProjectLibrary(root);
}

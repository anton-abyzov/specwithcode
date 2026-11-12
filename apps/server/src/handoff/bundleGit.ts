// @effect-diagnostics nodeBuiltinImport:off - bundles and worktrees are plain Git and file copies.
/**
 * Git transport for handoff checkpoints: an incremental bundle of the hidden
 * ref travels to the destination, lands on a per-source incoming ref, and
 * the checkpoint tree is applied as uncommitted changes on the base commit:
 * in a new worktree, or in the project folder when its Use worktrees switch is
 * off. Secret files are copied from the destination's own project root, never
 * sent.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HANDOFF_MAX_BUNDLE_BYTES } from "@specweave-studio/contracts";

import { runGit } from "../fleet/folderTransfer/git.ts";
import { refComponent } from "./checkpointGit.ts";

export const HANDOFF_INCOMING_REF_PREFIX = "refs/specwithcode/incoming/";
const CANDIDATES_MAX = 48;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export class BundleError extends Error {
  readonly code: "invalid" | "too_large" | "missing_prerequisites" | "mismatch" | "failed";
  constructor(code: BundleError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function isCommitSha(value: string): boolean {
  return SHA.test(value);
}

export const HANDOFF_APPLIED_REF_PREFIX = "refs/specwithcode/applied/";

/**
 * `refs/specwithcode/applied/<sourceEnvironmentId>/<sourceThreadId>/e<epoch>`:
 * the checkpoint a takeover put straight into the project's own checkout, kept
 * until that takeover finishes so a retry does not apply it twice.
 */
export function appliedRef(
  sourceEnvironmentId: string,
  sourceThreadId: string,
  epoch: number,
): string {
  return `${HANDOFF_APPLIED_REF_PREFIX}${refComponent(sourceEnvironmentId)}/${refComponent(sourceThreadId)}/e${epoch}`;
}

/** `refs/specwithcode/incoming/<sourceEnvironmentId>/<sourceThreadId>` */
export function incomingRef(sourceEnvironmentId: string, sourceThreadId: string): string {
  return `${HANDOFF_INCOMING_REF_PREFIX}${refComponent(sourceEnvironmentId)}/${refComponent(sourceThreadId)}`;
}

/**
 * Commits the destination may already have: the base commit, its first-parent
 * ancestors at growing distances, and the tips of `origin`. The destination
 * answers with the ones it holds, which become the bundle's prerequisites.
 */
export async function negotiationCandidates(root: string, baseCommit: string): Promise<string[]> {
  const out = new Set<string>([baseCommit]);
  const history = await runGit(
    root,
    ["rev-list", "--first-parent", "--max-count=1024", baseCommit],
    { allowFailure: true },
  );
  const ancestors = history.stdout.split("\n").filter(isCommitSha);
  for (let step = 1; step < ancestors.length && out.size < CANDIDATES_MAX / 2; step *= 2) {
    out.add(ancestors[step]!);
  }
  const remotes = await runGit(
    root,
    ["for-each-ref", "--format=%(objectname)", "--count=64", "refs/remotes/origin"],
    { allowFailure: true },
  );
  for (const sha of remotes.stdout.split("\n")) {
    if (out.size >= CANDIDATES_MAX) break;
    if (isCommitSha(sha)) out.add(sha);
  }
  return [...out];
}

/** The candidates present here as commits, in input order. */
export async function knownCommits(
  root: string,
  candidates: ReadonlyArray<string>,
): Promise<string[]> {
  const valid = candidates.filter(isCommitSha).slice(0, CANDIDATES_MAX);
  if (valid.length === 0) return [];
  const result = await runGit(
    root,
    ["rev-list", "--no-walk", "--ignore-missing", ...valid.map((sha) => `${sha}^{commit}`)],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    const found: string[] = [];
    for (const sha of valid) {
      const probe = await runGit(root, ["cat-file", "-e", `${sha}^{commit}`], {
        allowFailure: true,
      });
      if (probe.code === 0) found.push(sha);
    }
    return found;
  }
  const present = new Set(result.stdout.split("\n").filter(isCommitSha));
  return valid.filter((sha) => present.has(sha));
}

export interface BundleFile {
  readonly path: string;
  readonly bytes: number;
  readonly dispose: () => Promise<void>;
}

/**
 * Bundles `ref` (which must point at `commit`) minus everything reachable
 * from `exclude`. Fails with `too_large` past the handoff bundle cap.
 */
export async function createBundle(input: {
  readonly root: string;
  readonly ref: string;
  readonly commit: string;
  readonly exclude: ReadonlyArray<string>;
  readonly maxBytes?: number;
}): Promise<BundleFile> {
  const tip = await runGit(input.root, ["rev-parse", "--verify", "-q", `${input.ref}^{commit}`], {
    allowFailure: true,
  });
  if (tip.code !== 0 || tip.stdout.trim() !== input.commit) {
    throw new BundleError("mismatch", "The checkpoint ref moved; write a new checkpoint first.");
  }
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-handoff-bundle-"));
  const dispose = () => NodeFSP.rm(scratch, { recursive: true, force: true });
  try {
    const file = NodePath.join(scratch, "checkpoint.bundle");
    const exclude = input.exclude.filter((sha) => isCommitSha(sha) && sha !== input.commit);
    await runGit(input.root, [
      "bundle",
      "create",
      "--quiet",
      file,
      input.ref,
      ...exclude.map((sha) => `^${sha}`),
    ]);
    const bytes = (await NodeFSP.stat(file)).size;
    if (bytes > (input.maxBytes ?? HANDOFF_MAX_BUNDLE_BYTES)) {
      throw new BundleError(
        "too_large",
        `The checkpoint bundle is ${Math.ceil(bytes / 1_048_576)} MB, over the ${Math.round((input.maxBytes ?? HANDOFF_MAX_BUNDLE_BYTES) / 1_048_576)} MB handoff limit.`,
      );
    }
    return { path: file, bytes, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * Verifies a received bundle against this repository and fetches its one
 * head into `targetRef`, which must then equal `commit`.
 */
export async function applyBundle(input: {
  readonly root: string;
  readonly bundlePath: string;
  readonly commit: string;
  readonly targetRef: string;
}): Promise<void> {
  const verify = await runGit(input.root, ["bundle", "verify", input.bundlePath], {
    allowFailure: true,
  });
  if (verify.code !== 0) {
    throw /prerequisite|lacks/i.test(verify.stderr)
      ? new BundleError("missing_prerequisites", "This repository lacks the bundle's base commits.")
      : new BundleError("invalid", "The checkpoint bundle failed verification.");
  }
  const heads = (await runGit(input.root, ["bundle", "list-heads", input.bundlePath])).stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && isCommitSha(parts[0]!));
  const head = heads.find(([sha]) => sha === input.commit);
  if (heads.length !== 1 || head === undefined) {
    throw new BundleError("mismatch", "The bundle does not carry the expected checkpoint.");
  }
  await runGit(input.root, [
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-write-fetch-head",
    input.bundlePath,
    `+${head[1]}:${input.targetRef}`,
  ]);
  await pinCommit({ root: input.root, commit: input.commit, targetRef: input.targetRef });
}

/** Points `targetRef` at a commit this repository already holds. */
export async function pinCommit(input: {
  readonly root: string;
  readonly commit: string;
  readonly targetRef: string;
}): Promise<void> {
  const known = await knownCommits(input.root, [input.commit]);
  if (known.length !== 1) {
    throw new BundleError("missing_prerequisites", "This repository lacks the checkpoint commit.");
  }
  await runGit(input.root, ["update-ref", input.targetRef, input.commit]);
  const now = await runGit(input.root, ["rev-parse", "--verify", "-q", input.targetRef]);
  if (now.stdout.trim() !== input.commit) {
    throw new BundleError("mismatch", "The incoming ref does not match the checkpoint.");
  }
}

export async function refCommit(root: string, ref: string): Promise<string | null> {
  const result = await runGit(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], {
    allowFailure: true,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

function branchSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .replace(/\.{2,}/g, ".")
      .slice(0, 40) || "machine"
  );
}

/**
 * The source branch when it is free here, else `<branch>-from-<machine>`
 * with a numeric suffix. A detached source gets `handoff/<thread>-from-<machine>`.
 * An existing local branch is never reused or moved.
 */
export async function availableBranch(input: {
  readonly root: string;
  readonly branch: string | null;
  readonly sourceLabel: string;
  readonly sourceThreadId: string;
}): Promise<string> {
  const machine = branchSlug(input.sourceLabel);
  const base =
    input.branch ?? `handoff/${branchSlug(input.sourceThreadId).slice(0, 24)}-from-${machine}`;
  const valid = async (name: string) =>
    (await runGit(input.root, ["check-ref-format", "--branch", name], { allowFailure: true }))
      .code === 0;
  const free = async (name: string) =>
    (
      await runGit(input.root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
        allowFailure: true,
      })
    ).code !== 0;
  if (input.branch !== null && (await valid(base)) && (await free(base))) return base;
  const stem = input.branch === null ? base : `${input.branch}-from-${machine}`;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const name = attempt === 1 ? stem : `${stem}-${attempt}`;
    if ((await valid(name)) && (await free(name))) return name;
  }
  throw new BundleError("failed", "Could not find a free branch name for the handoff.");
}

/**
 * Applies the checkpoint tree to a worktree checked out at its base commit:
 * the files match the checkpoint, HEAD and the index stay at the base, so the
 * source's work shows as uncommitted changes.
 */
export async function applyCheckpointToWorktree(input: {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly checkpointCommit: string;
}): Promise<void> {
  const head = await refCommit(input.worktreePath, "HEAD");
  if (head !== input.baseCommit) {
    throw new BundleError("mismatch", "The new worktree is not at the checkpoint's base commit.");
  }
  await runGit(input.worktreePath, ["read-tree", "-u", "--reset", input.checkpointCommit]);
  await runGit(input.worktreePath, ["reset", "-q", input.baseCommit]);
}

/** Whether something on disk sits where a new file would go: the path itself, or a file where it needs a folder. */
async function occupied(root: string, path: string): Promise<boolean> {
  const segments = path.split("/");
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const stat = await NodeFSP.lstat(NodePath.join(root, ...segments.slice(0, depth))).catch(
      () => null,
    );
    if (stat === null) return false;
    if (depth === segments.length || !stat.isDirectory()) return true;
  }
  return false;
}

/**
 * Whether the folder's files already are the checkpoint's: every file the
 * checkpoint holds is on disk with the same content, and every file it removes
 * is gone. Files the checkpoint never carried (secrets, oversized files) may
 * be there as well.
 */
async function holdsCheckpoint(
  root: string,
  baseCommit: string,
  checkpointCommit: string,
): Promise<boolean> {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-handoff-held-"));
  try {
    const env = { GIT_INDEX_FILE: NodePath.join(scratch, "index") };
    await runGit(root, ["read-tree", checkpointCommit], { env });
    await runGit(root, ["update-index", "-q", "--refresh"], { env, allowFailure: true });
    const differs = await runGit(root, ["diff-files", "--quiet"], { env, allowFailure: true });
    if (differs.code !== 0) return false;
    const removed = await runGit(root, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      "--diff-filter=D",
      baseCommit,
      checkpointCommit,
    ]);
    for (const path of removed.stdout.split("\0")) {
      if (path.length === 0) continue;
      if ((await NodeFSP.lstat(NodePath.join(root, path)).catch(() => null)) !== null) return false;
    }
    return true;
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

/** Why a checkout in use could not take a checkpoint; nothing in it changed. */
export type InPlaceRefusal = "dirty" | "moved" | "blocked";

/**
 * Puts the checkpoint's files into a checkout that is already in use, the
 * project's own folder, as uncommitted changes. Only a checkout whose HEAD is
 * the checkpoint's base commit takes it, and only when it is clean or already
 * holds the same changes; the branch checked out there stays as it is. A file Git ignores there is never overwritten: one where
 * the checkpoint adds a path refuses the whole apply. `marker` records the
 * applied checkpoint, so a retried takeover finds its first attempt instead of
 * a dirty folder.
 */
export async function applyCheckpointInPlace(input: {
  readonly root: string;
  readonly baseCommit: string;
  readonly checkpointCommit: string;
  readonly marker: string;
}): Promise<
  | { readonly applied: true; readonly branch: string | null }
  | { readonly applied: false; readonly reason: InPlaceRefusal }
> {
  const currentBranch = async () => {
    const result = await runGit(input.root, ["symbolic-ref", "--short", "-q", "HEAD"], {
      allowFailure: true,
    });
    const branch = result.stdout.trim();
    return result.code === 0 && branch.length > 0 ? branch : null;
  };
  if ((await refCommit(input.root, input.marker)) === input.checkpointCommit) {
    return { applied: true, branch: await currentBranch() };
  }
  if ((await refCommit(input.root, "HEAD")) !== input.baseCommit) {
    return { applied: false, reason: "moved" };
  }
  const status = await runGit(input.root, ["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    // The source worked in this very folder (a move between sign-ins on one
    // machine), or the same changes are already here: nothing to apply.
    return (await holdsCheckpoint(input.root, input.baseCommit, input.checkpointCommit))
      ? { applied: true, branch: await currentBranch() }
      : { applied: false, reason: "dirty" };
  }
  // A clean status hides ignored files, and Git writes over those.
  const added = await runGit(input.root, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    "--diff-filter=A",
    input.baseCommit,
    input.checkpointCommit,
  ]);
  for (const path of added.stdout.split("\0")) {
    if (path.length > 0 && (await occupied(input.root, path))) {
      return { applied: false, reason: "blocked" };
    }
  }
  // A two-tree merge checks every path before it writes one.
  const merged = await runGit(
    input.root,
    ["read-tree", "-u", "-m", input.baseCommit, input.checkpointCommit],
    { allowFailure: true },
  );
  if (merged.code !== 0) return { applied: false, reason: "blocked" };
  await runGit(input.root, ["update-ref", input.marker, input.checkpointCommit]);
  // Back to HEAD's index: the checkpoint's files stay as uncommitted changes.
  await runGit(input.root, ["reset", "-q"]);
  return { applied: true, branch: await currentBranch() };
}

function safeRelative(path: string): string | null {
  if (path.length === 0 || NodePath.isAbsolute(path) || path.includes("\0")) return null;
  const normalized = NodePath.normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${NodePath.sep}`)) return null;
  if (normalized.split(NodePath.sep).includes(".git")) return null;
  return normalized;
}

/**
 * The source's repository position relative to its project folder, mapped
 * under this machine's linked project folder. Accepts "" (the folder itself),
 * a nested path without `..`, or only `..` segments (the project folder sits
 * inside the repository); anything else is refused. The result must be the
 * top level of a Git repository.
 */
export async function resolveRepositoryPath(
  projectRoot: string,
  repositoryPath: string,
): Promise<string> {
  const refuse = () =>
    new BundleError("invalid", "The repository path does not map into this project.");
  if (NodePath.isAbsolute(repositoryPath) || repositoryPath.includes("\0")) throw refuse();
  const segments = repositoryPath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  const up = segments.filter((segment) => segment === "..").length;
  if (up > 0 && up !== segments.length) throw refuse();
  if (segments.some((segment) => segment === ".git" || segment.includes("\\"))) throw refuse();
  const candidate = NodePath.resolve(projectRoot, ...segments);
  const top = await runGit(candidate, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (top.code !== 0) {
    throw new BundleError("invalid", "The mapped repository folder is not a Git repository here.");
  }
  const [real, expected] = await Promise.all([
    NodeFSP.realpath(top.stdout.trim()).catch(() => top.stdout.trim()),
    NodeFSP.realpath(candidate).catch(() => candidate),
  ]);
  if (real !== expected) {
    throw new BundleError(
      "invalid",
      "The mapped folder is inside a repository, not its top level.",
    );
  }
  return candidate;
}

/**
 * Where the repository a thread works in sits relative to its project folder,
 * in the form `resolveRepositoryPath` accepts. A thread in a separate worktree
 * maps to its main checkout, found through the shared Git directory.
 */
export async function repositoryPathFor(projectRoot: string, cwd: string): Promise<string> {
  const common = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    allowFailure: true,
  });
  if (common.code !== 0)
    throw new BundleError("invalid", "The thread's folder is not a Git repository.");
  const commonDir = common.stdout.trim();
  let mainRoot: string;
  if (NodePath.basename(commonDir) === ".git") {
    mainRoot = NodePath.dirname(commonDir);
  } else {
    const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    if (top.code !== 0)
      throw new BundleError("invalid", "The thread's folder is not a Git repository.");
    mainRoot = top.stdout.trim();
  }
  const [realRoot, realMain] = await Promise.all([
    NodeFSP.realpath(projectRoot).catch(() => projectRoot),
    NodeFSP.realpath(mainRoot).catch(() => mainRoot),
  ]);
  const segments = NodePath.relative(realRoot, realMain)
    .split(NodePath.sep)
    .filter((segment) => segment.length > 0);
  const up = segments.filter((segment) => segment === "..").length;
  if (up > 0 && up !== segments.length) {
    throw new BundleError("invalid", "The thread's repository sits outside its project folder.");
  }
  return segments.join("/");
}

/** Required files absent from `root` (or unsafe to name), in input order. */
export async function missingFiles(root: string, paths: ReadonlyArray<string>): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    const relative = safeRelative(path);
    if (relative === null) {
      missing.push(path);
      continue;
    }
    const stat = await NodeFSP.stat(NodePath.join(root, relative)).catch(() => null);
    if (stat === null || !stat.isFile()) missing.push(path);
  }
  return missing;
}

/** Copies required ignored files from the project root into a new worktree; never overwrites. */
export async function copyRequiredFiles(input: {
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly paths: ReadonlyArray<string>;
}): Promise<{ readonly copied: string[]; readonly missing: string[] }> {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const path of input.paths) {
    const relative = safeRelative(path);
    if (relative === null) {
      missing.push(path);
      continue;
    }
    const from = NodePath.join(input.fromRoot, relative);
    const to = NodePath.join(input.toRoot, relative);
    const stat = await NodeFSP.stat(from).catch(() => null);
    if (stat === null || !stat.isFile()) {
      missing.push(path);
      continue;
    }
    await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
    const done = await NodeFSP.copyFile(from, to, NodeFSP.constants.COPYFILE_EXCL)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") return false;
        throw error;
      });
    if (done) {
      await NodeFSP.chmod(to, stat.mode & 0o777);
      copied.push(path);
    }
  }
  return { copied, missing };
}

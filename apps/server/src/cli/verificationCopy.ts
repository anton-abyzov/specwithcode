// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- drives git and the package manager as child processes over one folder on disk.
/**
 * One reusable verification copy per repository and app home, behind
 * `specweave-studio checks copy`.
 *
 * With worktrees off, agents that wanted a clean tree to verify in cloned the
 * repository per thread: 27 copies in a week on one machine, 13 with their
 * own `node_modules`. This keeps a single copy at `<home>/verify/<name>`,
 * moves it to the requested commit, and installs dependencies only when the
 * lockfile differs from the one of the last install.
 *
 * The copy is never cleaned for the caller: uncommitted or untracked files in
 * it refuse the move and are listed instead.
 *
 * @module verificationCopy
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Replaces the detected install command (tests, unusual repositories). Run through the shell in the copy. */
export const VERIFICATION_INSTALL_COMMAND_ENV = "STUDIO_CHECKS_INSTALL_COMMAND";

/** Inside the copy's `.git`, so it is never part of the working tree. */
const STATE_FILE = "specwithcode-verify.json";

export class VerificationCopyError extends Error {
  readonly kind: "dirty" | "busy" | "failed";
  constructor(kind: "dirty" | "busy" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface VerificationCopyResult {
  readonly path: string;
  readonly commit: string;
  readonly created: boolean;
  /** HEAD changed in this call. */
  readonly moved: boolean;
  readonly installed: boolean;
}

export interface VerificationCopyOptions {
  /** A local checkout or a clone URL. */
  readonly source: string;
  /** Branch, tag or commit; the source's HEAD (or the remote's default branch) when absent. */
  readonly ref?: string | undefined;
  /** The app home: the copy lives at `<home>/verify/<name>`. */
  readonly home: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Called before anything in the copy changes (checkout or install), with
   * the work to do under the heavy-check gate. It throws to refuse.
   */
  readonly exclusive?: <A>(work: () => A) => A;
  readonly log?: (line: string) => void;
}

function git(cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  try {
    return NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch (cause) {
    const stderr = String((cause as { stderr?: unknown }).stderr ?? "").trim();
    throw new VerificationCopyError(
      "failed",
      `git ${args.join(" ")} failed in ${cwd}: ${stderr || (cause as Error).message}`,
    );
  }
}

const gitOrNull = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) => {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
};

/** `owner/name.git`, `git@host:owner/name` or a path: the last segment without `.git`. */
export function repositoryName(urlOrPath: string): string {
  const last =
    urlOrPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/:]/)
      .pop() ?? "";
  const name = last.replace(/\.git$/i, "").replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return name.length === 0 || name === "." || name === ".." ? "repository" : name;
}

const isLocalPath = (source: string) =>
  !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source) && !/^[^/\\]+@[^/\\]+:/.test(source);

interface InstallPlan {
  readonly lockfileHash: string | null;
  readonly command: string | null;
}

/** The install command for the copy's `packageManager`, and its lockfile's hash. */
export function installPlan(copy: string, env: NodeJS.ProcessEnv = process.env): InstallPlan {
  let manager = "";
  try {
    const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(copy, "package.json"), "utf8"));
    manager = String(manifest.packageManager ?? "").split("@")[0] ?? "";
  } catch {
    // No package.json: nothing to install unless a lockfile says otherwise.
  }
  const known: ReadonlyArray<readonly [string, string, string]> = [
    ["pnpm", "pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["npm", "package-lock.json", "npm ci"],
    ["yarn", "yarn.lock", "yarn install --immutable"],
    ["bun", "bun.lock", "bun install --frozen-lockfile"],
  ];
  const exists = (file: string) => NodeFS.existsSync(NodePath.join(copy, file));
  const match =
    known.find(([name, lockfile]) => name === manager && exists(lockfile)) ??
    known.find(([, lockfile]) => exists(lockfile));
  if (match === undefined) return { lockfileHash: null, command: null };
  const hash = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(NodePath.join(copy, match[1])))
    .digest("hex");
  const override = env[VERIFICATION_INSTALL_COMMAND_ENV]?.trim();
  return { lockfileHash: hash, command: override || match[2] };
}

function readInstalledHash(copy: string): string | null {
  try {
    const state = JSON.parse(NodeFS.readFileSync(NodePath.join(copy, ".git", STATE_FILE), "utf8"));
    return typeof state.lockfileHash === "string" ? state.lockfileHash : null;
  } catch {
    return null;
  }
}

/**
 * Returns the repository's verification copy at `ref`, creating it on first
 * use. Throws `VerificationCopyError`: `dirty` when the copy has uncommitted
 * or untracked files, `busy` when `exclusive` refuses, `failed` otherwise.
 */
export function ensureVerificationCopy(options: VerificationCopyOptions): VerificationCopyResult {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const exclusive = options.exclusive ?? (<A>(work: () => A) => work());
  const local = isLocalPath(options.source);
  const source = local ? NodePath.resolve(options.source) : options.source;
  if (local && gitOrNull(source, ["rev-parse", "--git-dir"], env) === null)
    throw new VerificationCopyError("failed", `${source} is not a git checkout.`);

  const origin = local ? gitOrNull(source, ["remote", "get-url", "origin"], env) : source;
  const copy = NodePath.join(options.home, "verify", repositoryName(origin ?? source));
  // A local source is fetched through its own path, so commits that were never pushed are reachable.
  const remote = local ? "source" : "origin";

  let created = false;
  if (!NodeFS.existsSync(NodePath.join(copy, ".git"))) {
    exclusive(() => {
      NodeFS.mkdirSync(NodePath.dirname(copy), { recursive: true });
      if (NodeFS.existsSync(copy) && NodeFS.readdirSync(copy).length > 0)
        throw new VerificationCopyError(
          "failed",
          `${copy} exists and is not a git checkout; move it away first.`,
        );
      log(`checks: creating the verification copy at ${copy}`);
      // A local clone hard-links the source's objects: no second copy of history on disk.
      git(
        NodePath.dirname(copy),
        ["clone", "--quiet", "--no-checkout", "--origin", remote, source, copy],
        env,
      );
      if (local && origin !== null) git(copy, ["remote", "add", "origin", origin], env);
    });
    created = true;
  } else if (git(copy, ["remote", "get-url", remote], env) !== source) {
    git(copy, ["remote", "set-url", remote, source], env);
  }

  // Resolved in the source for a local path, so any commit there can be asked for by hash.
  const want = local
    ? git(source, ["rev-parse", "--verify", `${options.ref ?? "HEAD"}^{commit}`], env)
    : (options.ref ?? "HEAD");
  const fetchArgs = local
    ? [
        "fetch",
        "--quiet",
        "--upload-pack",
        "git -c uploadpack.allowAnySHA1InWant=true upload-pack",
        remote,
        want,
      ]
    : ["fetch", "--quiet", remote, want];
  const current = created ? null : gitOrNull(copy, ["rev-parse", "--verify", "HEAD"], env);
  if (!(local && current === want)) git(copy, fetchArgs, env);
  const commit = local ? want : git(copy, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], env);

  // A copy whose first checkout never happened holds only .git; git reports every file as deleted.
  const neverCheckedOut = NodeFS.readdirSync(copy).every((name) => name === ".git");
  const dirty = created || neverCheckedOut ? "" : git(copy, ["status", "--porcelain"], env);
  if (dirty.length > 0) {
    const lines = dirty.split("\n");
    throw new VerificationCopyError(
      "dirty",
      [
        `${copy} has uncommitted or untracked files, so it was left as it is:`,
        ...lines.slice(0, 20).map((line) => `  ${line}`),
        ...(lines.length > 20 ? [`  ... and ${lines.length - 20} more`] : []),
        "Commit them elsewhere or remove them yourself, then run the command again.",
      ].join("\n"),
    );
  }

  const moved = current !== commit;
  if (moved) {
    exclusive(() => {
      // The repository's rule for extra checkouts: the vendored reference trees stay out.
      if (
        gitOrNull(copy, ["ls-tree", "-d", "--name-only", commit, ".repos"], env) === ".repos" &&
        gitOrNull(copy, ["config", "--get", "core.sparseCheckout"], env) !== "true"
      )
        git(copy, ["sparse-checkout", "set", "--no-cone", "/*", "!/.repos/"], env);
      git(copy, ["checkout", "--quiet", "--detach", commit], env);
    });
  }

  const plan = installPlan(copy, env);
  let installed = false;
  if (
    plan.command !== null &&
    plan.lockfileHash !== null &&
    readInstalledHash(copy) !== plan.lockfileHash
  ) {
    const command = plan.command;
    exclusive(() => {
      log(`checks: the lockfile changed, running ${command} in ${copy}`);
      try {
        // stdout is the copy's path alone, so the install's output goes to stderr.
        NodeChildProcess.execSync(command, { cwd: copy, env, stdio: ["ignore", 2, 2] });
      } catch (cause) {
        throw new VerificationCopyError(
          "failed",
          `${command} failed in ${copy}: ${(cause as Error).message}`,
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(copy, ".git", STATE_FILE),
        JSON.stringify({
          lockfileHash: plan.lockfileHash,
          command,
          installedAt: new Date().toISOString(),
        }),
      );
    });
    installed = true;
  }
  return { path: copy, commit, created, moved, installed };
}

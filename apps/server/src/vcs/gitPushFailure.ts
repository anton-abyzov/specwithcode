/**
 * What a failed `git push` says, in words safe to show. Git's stderr never
 * leaves the driver (it echoes argv and remote URLs, which can carry
 * credentials), so this module reads it for three fixed shapes only: the last
 * `fatal:` line with URL credentials removed, a `! [rejected]` line's reason,
 * and GitHub's one-line notice that a repository is archived.
 */
import type { GitCommandFailureReason } from "@specweave-studio/contracts";

const GENERIC_DETAIL = "Git command exited with a non-zero status.";

/** The 403 GitHub answers a push to an archived repository with, like a refused login. */
const HTTP_FORBIDDEN = /^fatal: unable to access .+: The requested URL returned error: 403\s*$/m;

/**
 * GitHub's notice for an archived repository. This is the only `remote:` line read here, and it
 * can only take a failure out of `authentication_failed`, never put one in: a remote that prints
 * it loses the credential retry, nothing more.
 */
const ARCHIVED_NOTICE = /^remote: This repository was archived so it is read-only\.?\s*$/m;

/** ` ! [rejected]        HEAD -> main (non-fast-forward)`, also `[remote rejected]`. */
const REJECTED_REF = /^\s*!\s+\[(rejected|remote rejected)\]\s+\S+\s+->\s+\S+\s+\((.+)\)\s*$/;

/** What to do about the rejections git itself decides; a remote's own reasons get no advice. */
const REJECTION_ADVICE: Readonly<Record<string, string>> = {
  "non-fast-forward": "pull or rebase first",
  "fetch first": "pull or rebase first",
  "stale info": "fetch, then retry",
  "already exists": "the remote already has that ref",
};

/**
 * The reason on a rejected ref. A remote writes its own text there, so only plain words survive:
 * no URL, no credential shape, at most 120 characters.
 */
export function pushRejection(stderr: string): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    const match = REJECTED_REF.exec(line);
    if (match === null) continue;
    const reason = (match[2] ?? "")
      .replace(/[^A-Za-z0-9 _.,'#-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (reason === "") continue;
    const advice = match[1] === "rejected" ? REJECTION_ADVICE[reason] : undefined;
    const prefix = match[1] === "rejected" ? "rejected" : "rejected by the remote";
    return advice === undefined ? `${prefix}: ${reason}` : `${prefix}: ${reason}; ${advice}`;
  }
  return null;
}

/** Whether the refusal is GitHub's read-only answer for an archived repository. */
export function isArchivedRepositoryRefusal(stderr: string): boolean {
  return ARCHIVED_NOTICE.test(stderr) && HTTP_FORBIDDEN.test(stderr);
}

/**
 * Whether a push destination is a plain remote name. Git also accepts a URL
 * or a path there (from `branch.<name>.pushRemote` or `remote.pushDefault`),
 * which can carry credentials and must never reach an error.
 */
function isRemoteName(value: string): boolean {
  // Remote names may contain slashes (`foo/bar`). URLs and paths are told
  // apart by their credential and path shapes, not by the slash.
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.startsWith(".") &&
    !value.startsWith("~") &&
    !value.includes("://") &&
    !value.includes("@") &&
    !value.includes(":") &&
    !value.includes("\\") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("<") &&
    !value.includes(">") &&
    !/\s/.test(value)
  );
}

/** `git push origin HEAD:refs/heads/x`: the arguments the app built, never a URL or a token. */
export function pushCommandText(args: ReadonlyArray<string>): string {
  const shown = args.map((arg, index) =>
    index === 1 && args[0] === "push" && !isRemoteName(arg) ? "<remote>" : arg,
  );
  return ["git", ...shown].join(" ");
}

/** The remote a push command named, or null for a bare `git push` or a hidden destination. */
export function pushCommandRemote(command: string): string | null {
  const [git, push, remote] = command.split(" ");
  return git === "git" && push === "push" && remote && isRemoteName(remote) ? remote : null;
}

/**
 * The fields a failed push puts on its error. `fatal` is git's last `fatal:` line with URL
 * credentials already removed.
 */
export function pushFailureFields(input: {
  readonly args: ReadonlyArray<string>;
  readonly stderr: string;
  readonly classified: GitCommandFailureReason | null;
  readonly fatal: string | null;
}): {
  readonly command: string;
  readonly detail: string;
  readonly reason?: GitCommandFailureReason;
} {
  const command = pushCommandText(input.args);
  const withFatal = (detail: string) =>
    input.fatal === null ? detail : `${detail.replace(/\.$/, "")}: ${input.fatal}`;
  if (isArchivedRepositoryRefusal(input.stderr)) {
    return {
      command,
      detail: withFatal("The repository is archived (read-only), so it cannot be pushed to."),
    };
  }
  const rejection = pushRejection(input.stderr);
  return {
    command,
    detail: withFatal(rejection === null ? GENERIC_DETAIL : `Git push was ${rejection}.`),
    ...(input.classified === null ? {} : { reason: input.classified }),
  };
}

import * as Schema from "effect/Schema";

/** No absolute source paths or remote credentials cross the machine boundary. */
export const HandoffGitRepository = Schema.Struct({
  relativePath: Schema.String,
  identity: Schema.String,
  head: Schema.String,
  ref: Schema.String,
});
export type HandoffGitRepository = typeof HandoffGitRepository.Type;

export const HandoffGitManifest = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Schema.String,
  repositories: Schema.Array(HandoffGitRepository),
});
export type HandoffGitManifest = typeof HandoffGitManifest.Type;

export interface HandoffGitMaterialization {
  readonly operationId: string;
  readonly workspaceRoot: string;
  readonly manifestSha256: string;
  readonly repositories: ReadonlyArray<HandoffGitRepository & { readonly worktreePath: string }>;
}

export class HandoffGitError extends Schema.TaggedError<HandoffGitError>()("HandoffGitError", {
  stage: Schema.Literals(["inspect", "preflight", "publish", "materialize"]),
  reason: Schema.Literals([
    "invalid-manifest",
    "unsafe-path",
    "missing-repository",
    "dirty-repository",
    "identity-mismatch",
    "source-changed",
    "diverged-repository",
    "uninitialized-repository",
    "scan-limit",
    "git-failed",
    "filesystem-failed",
    "remote-ref-mismatch",
    "operation-conflict",
    "worktree-conflict",
    "worker-checkpoint",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git handoff ${this.stage} was blocked: ${this.reason}.`;
  }
}

export const HANDOFF_OPERATION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HANDOFF_HEAD = /^[0-9a-f]{40}$/;

export function handoffRef(operationId: string, head: string): string {
  return `refs/heads/codex/handoff/${operationId}/${head}`;
}

export function safeRelativePath(value: string): boolean {
  if (value === ".") return true;
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    // eslint-disable-next-line no-control-regex -- Control bytes are invalid in portable repository paths.
    !/[\\\u0000-\u001f\u007f:]/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")
  );
}

/** Canonical identity only: Git commands always use the local configured `origin`. */
export function canonicalOrigin(value: string): string | null {
  // eslint-disable-next-line no-control-regex -- Reject line breaks and control bytes before parsing Git output.
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (value.startsWith("/")) return `file://${value.replace(/\/$/, "")}`;
  // A Windows local remote such as C:\repos\app.git, written the way its
  // file:///C:/repos/app.git URL form canonicalizes.
  const drive = /^([a-zA-Z]):[\\/]/.exec(value);
  if (drive)
    return `file:///${drive[1]!.toUpperCase()}${value.slice(1).replaceAll("\\", "/").replace(/\/$/, "")}`;
  const scp = /^(?:[a-zA-Z0-9._-]+@)?([a-zA-Z0-9.-]+):([^/].*)$/.exec(value);
  if (scp && !value.includes("://")) {
    const [, host, repository] = scp;
    if (!host || !repository || !safeRelativePath(repository)) return null;
    return `${host.toLowerCase()}/${repository.replace(/\.git$/, "").replace(/\/$/, "")}`;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "file:" && !url.host && !url.search && !url.hash) {
      return `file://${decodeURIComponent(url.pathname)
        .replace(/^\/([a-z]):/, (_, letter: string) => `/${letter.toUpperCase()}:`)
        .replace(/\/$/, "")}`;
    }
    if (
      !["https:", "ssh:", "git:"].includes(url.protocol) ||
      !url.hostname ||
      url.password ||
      (url.protocol !== "ssh:" && url.username) ||
      url.search ||
      url.hash
    )
      return null;
    const repository = decodeURIComponent(url.pathname)
      .replace(/^\//, "")
      .replace(/\/$/, "")
      .replace(/\.git$/, "");
    if (!safeRelativePath(repository) || repository === ".") return null;
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${repository}`;
  } catch {
    return null;
  }
}

export function validManifest(manifest: HandoffGitManifest): boolean {
  if (
    !manifest ||
    manifest.version !== 1 ||
    typeof manifest.operationId !== "string" ||
    !HANDOFF_OPERATION.test(manifest.operationId) ||
    !Array.isArray(manifest.repositories) ||
    manifest.repositories.length < 1 ||
    manifest.repositories.length > 128 ||
    manifest.repositories[0]?.relativePath !== "."
  )
    return false;
  const paths = new Set<string>();
  const identities = new Set<string>();
  for (const repository of manifest.repositories) {
    if (
      !repository ||
      typeof repository.relativePath !== "string" ||
      typeof repository.head !== "string" ||
      typeof repository.identity !== "string" ||
      !safeRelativePath(repository.relativePath) ||
      !HANDOFF_HEAD.test(repository.head) ||
      repository.ref !== handoffRef(manifest.operationId, repository.head) ||
      !repository.identity ||
      repository.identity.length > 2048 ||
      // eslint-disable-next-line no-control-regex -- Wire identities cannot contain controls or URL credentials.
      /[\u0000-\u0020\u007f@?#]/.test(repository.identity) ||
      paths.has(repository.relativePath) ||
      identities.has(repository.identity)
    )
      return false;
    paths.add(repository.relativePath);
    identities.add(repository.identity);
  }
  return true;
}

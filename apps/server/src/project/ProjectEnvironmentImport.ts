import { createHash } from "node:crypto";
import {
  ProjectEnvironmentError,
  ProjectRepositoryId,
  projectRepositoryIdentity,
  type ProjectEnvironmentImportPreview,
  type ProjectEnvironmentSettings,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import { resolveProjectEnvironment } from "./ProjectEnvironmentPaths.ts";
import { repositoryInspectionEnv } from "./ProjectRepositoryInspection.ts";

const configSchema = Schema.Struct({
  workspace: Schema.Struct({
    repos: Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
        identity: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
        sync: Schema.optional(
          Schema.Struct({
            github: Schema.optional(Schema.Struct({ owner: Schema.String, repo: Schema.String })),
          }),
        ),
      }),
    ).check(Schema.isMaxLength(256)),
  }),
});
const decode = Schema.decodeUnknownSync(configSchema);
const canonicalIdentity = (url: string) => {
  const identity = projectRepositoryIdentity(url);
  return identity?.startsWith("github.com/") ? identity.toLowerCase() : identity;
};

/** Bounded read and real Git inspection only. No CLI, clone, config write or project creation. */
export const previewWorkspaceImport = (input: {
  projectId: ProjectId;
  root: string;
  workspaceRoot: string;
  revision: number;
  environment: ProjectEnvironmentSettings;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const fail = (code: ProjectEnvironmentError["code"]) =>
      new ProjectEnvironmentError({ projectId: input.projectId, code });
    const resolved = yield* resolveProjectEnvironment(
      input.projectId,
      input.workspaceRoot,
      input.environment,
    );
    if (
      resolved.additionalFolders.some(
        (folder, i) => folder !== input.environment.additionalFolders[i],
      ) ||
      ((resolved.additionalFolders.length > 0 || resolved.repositories.length > 0) &&
        resolved.workspaceRoot !== input.workspaceRoot)
    )
      return yield* fail("path_not_approved");
    const roots = [resolved.workspaceRoot, ...resolved.additionalFolders];
    const inside = (root: string, child: string) => {
      const relative = path.relative(root, child);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    const approved = (child: string) => roots.some((root) => inside(root, child));
    if (!path.isAbsolute(input.root)) return yield* fail("path_not_approved");
    const root = yield* fs.realPath(input.root);
    if (!approved(root)) return yield* fail("path_not_approved");
    const source = path.join(root, ".specweave", "config.json");
    const sourceReal = yield* fs.realPath(source);
    if (!inside(root, sourceReal)) return yield* fail("path_not_approved");
    const readContent = Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(sourceReal, { flag: "r" });
        const before = yield* handle.stat;
        if (before.type !== "File" || before.size > 262_144n) return yield* fail("invalid");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (size <= 262_144) {
          const chunk = yield* handle.readAlloc(Math.min(16_384, 262_145 - size));
          if (chunk._tag === "None" || chunk.value.length === 0) break;
          chunks.push(chunk.value);
          size += chunk.value.length;
        }
        const after = yield* handle.stat;
        if (
          size > 262_144 ||
          before.size !== after.size ||
          JSON.stringify(before.mtime) !== JSON.stringify(after.mtime)
        )
          return yield* fail("import_changed");
        return yield* Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          catch: () => fail("invalid"),
        });
      }),
    );
    const content = yield* readContent;
    const config = yield* Effect.try({
      try: () => decode(JSON.parse(content)),
      catch: () => fail("invalid"),
    });
    const repositories: Array<ProjectEnvironmentImportPreview["repositories"][number]> = [];
    const merged = [...input.environment.repositories];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    let invalidInventory = false;
    const inspectedPaths: Array<{ requested: string; canonical: string; url: string }> = [];
    const git = (cwd: string, args: string[]) =>
      runner
        .run({
          command: "git",
          args,
          cwd,
          env: repositoryInspectionEnv(),
          timeout: "5 seconds",
          maxOutputBytes: 8192,
        })
        .pipe(
          Effect.flatMap((result) =>
            result.code === 0 &&
            !result.timedOut &&
            !result.stdoutTruncated &&
            !result.stdoutInvalidUtf8
              ? Effect.succeed(result.stdout.trim())
              : Effect.fail(fail("repository_mismatch")),
          ),
        );
    for (const repo of config.workspace.repos) {
      const requested = path.resolve(root, repo.path);
      let row: ProjectEnvironmentImportPreview["repositories"][number] = {
        id: repo.id,
        path: requested,
        url: null,
        status: "blocked",
        reason: "Checkout unavailable or not a Git repository.",
      };
      const inspected = yield* Effect.gen(function* () {
        const localPath = yield* fs.realPath(requested);
        if (!approved(localPath))
          return {
            ...row,
            path: localPath,
            reason: "Approve this folder in Environment before importing.",
          };
        // Check the exact root: a directory inside another checkout is not a repository member.
        const top = yield* fs.realPath(yield* git(localPath, ["rev-parse", "--show-toplevel"]));
        if (top !== localPath)
          return { ...row, reason: "The path must identify a repository root." };
        const url = yield* git(localPath, ["config", "--local", "--get", "remote.origin.url"]).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!url)
          return {
            ...row,
            path: localPath,
            reason:
              "No readable origin URL. Use an approved additional folder for this local-only checkout.",
          };
        const identity = canonicalIdentity(url);
        if (!identity) return { ...row, reason: "Use a credential-free HTTPS or SSH origin URL." };
        row = { ...row, path: localPath, url };
        inspectedPaths.push({ requested, canonical: localPath, url });
        const expected =
          repo.identity ??
          (repo.sync?.github
            ? `github.com/${repo.sync.github.owner}/${repo.sync.github.repo}`
            : null);
        if (expected && canonicalIdentity(`https://${expected}`) !== identity)
          return { ...row, reason: "The checkout origin differs from the registered repository." };
        if (seenIds.has(repo.id) || seenPaths.has(localPath)) {
          invalidInventory = true;
          return { ...row, reason: "Duplicate repository ID or checkout path in the workspace." };
        }
        seenIds.add(repo.id);
        seenPaths.add(localPath);
        const existing = resolved.repositories.find((item) => item.localPath === localPath);
        if (existing)
          return canonicalIdentity(existing.url) === identity
            ? {
                ...row,
                id: existing.id,
                status: "existing" as const,
                reason: "Already attached; keeps its existing ID.",
              }
            : { ...row, reason: "This path is already attached with another origin." };
        if (!Schema.is(ProjectRepositoryId)(repo.id))
          return {
            ...row,
            reason: "Repository ID must be 1–64 letters, digits, hyphens or underscores.",
          };
        if (merged.some((item) => item.id === repo.id))
          return { ...row, reason: "This repository ID is already attached to another checkout." };
        if (merged.length >= 32)
          return {
            ...row,
            reason: "This project supports 32 repositories. Remove an entry before importing.",
          };
        merged.push({ id: repo.id, url, localPath });
        return { ...row, status: "add" as const, reason: "Attach this existing checkout." };
      }).pipe(Effect.catch(() => Effect.succeed(row)));
      repositories.push(inspected);
    }
    // Re-read approval paths and source identity after the Git work, before returning a receipt.
    if (
      (yield* fs.realPath(input.root)) !== root ||
      (yield* fs.realPath(source)) !== sourceReal ||
      (yield* readContent) !== content
    )
      return yield* fail("import_changed");
    for (const grant of roots)
      if ((yield* fs.realPath(grant)) !== grant) return yield* fail("path_not_approved");
    for (const checked of inspectedPaths) {
      if (
        (yield* fs.realPath(checked.requested)) !== checked.canonical ||
        (yield* git(checked.canonical, ["config", "--local", "--get", "remote.origin.url"])) !==
          checked.url
      )
        return yield* fail("import_changed");
    }
    const canApply =
      !invalidInventory &&
      (repositories.length === 0 || repositories.some((row) => row.status !== "blocked"));
    const environment = {
      ...input.environment,
      repositories: canApply ? merged : input.environment.repositories,
    };
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          root,
          content,
          revision: input.revision,
          roots,
          current: input.environment,
          repositories,
        }),
      )
      .digest("hex");
    return {
      revision: input.revision,
      root,
      fingerprint,
      repositories,
      environment,
      canApply,
    } satisfies ProjectEnvironmentImportPreview;
  }).pipe(
    Effect.mapError((error) =>
      error instanceof ProjectEnvironmentError
        ? error
        : new ProjectEnvironmentError({ projectId: input.projectId, code: "invalid" }),
    ),
  );

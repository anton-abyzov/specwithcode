import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string>;
  readonly worktreesByProjectRoot?: Readonly<Record<string, ReadonlyArray<string>>>;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        listWorktreePaths: (cwd) =>
          Effect.succeed([...(input.worktreesByProjectRoot?.[cwd] ?? [])]),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        list: () =>
          Effect.succeed(
            (input.projectRoots ?? []).map(
              (workspaceRoot) => ({ workspaceRoot }) as unknown as ProjectStore.ProjectRow,
            ),
          ),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-old-worktrees-",
      });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a registered project root outside the server workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-project-" });
      const nested = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(nested, { recursive: true });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      for (const cwd of [projectRoot, nested]) {
        const result = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({ workspaceRoot, baseDir, detectCalls, projectRoots: [projectRoot] }),
          ),
        );
        assert.strictEqual(result.cwd, cwd);
      }
      assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }, { cwd: nested }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a linked worktree of a registered project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-project-" });
      const linkedWorktree = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-linked-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: linkedWorktree });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            projectRoots: [projectRoot],
            // The service asks git from the canonical (symlink-free) project root.
            worktreesByProjectRoot: {
              [yield* fs.realPath(projectRoot)]: [projectRoot, linkedWorktree],
            },
          }),
        ),
      );
      assert.strictEqual(result.cwd, linkedWorktree);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("scopes a subfolder project to the same subfolder of its linked worktrees", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-repo-" });
      const linkedWorktree = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-linked-" });
      const otherRepo = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-other-" });
      const projectRoot = `${repoRoot}/apps/web`;
      for (const directory of [
        projectRoot,
        `${linkedWorktree}/apps/web/src`,
        `${linkedWorktree}/apps/secret`,
        `${otherRepo}/apps/web`,
      ]) {
        yield* fs.makeDirectory(directory, { recursive: true });
      }
      const canonicalProjectRoot = yield* fs.realPath(projectRoot);
      const reviewAt = (cwd: string, worktrees: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [projectRoot],
              worktreesByProjectRoot: { [canonicalProjectRoot]: worktrees },
            }),
          ),
        );

      for (const cwd of [`${linkedWorktree}/apps/web`, `${linkedWorktree}/apps/web/src`]) {
        const result = yield* reviewAt(cwd, [repoRoot, linkedWorktree]);
        assert.strictEqual(result.cwd, cwd);
      }
      for (const cwd of [linkedWorktree, `${linkedWorktree}/apps/secret`]) {
        const error = yield* reviewAt(cwd, [repoRoot, linkedWorktree]).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
      // A worktree list that does not contain the project trusts none of it.
      const error = yield* reviewAt(`${otherRepo}/apps/web`, [otherRepo]).pipe(Effect.flip);
      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("still rejects unregistered folders when projects are registered", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const repoRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-repo-" });
      const projectRoot = `${repoRoot}/apps/web`;
      const sibling = `${repoRoot}/apps/secret`;
      yield* fs.makeDirectory(projectRoot, { recursive: true });
      yield* fs.makeDirectory(sibling, { recursive: true });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-outside-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];
      const canonicalProjectRoot = yield* fs.realPath(projectRoot);

      // The repository's main checkout sits above the project folder; it must
      // not widen the boundary to the whole repository. A project registered
      // at "/" is ignored rather than trusting every path.
      for (const cwd of [outsideRoot, repoRoot, sibling, `${projectRoot}/../secret`]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd }).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              detectCalls,
              projectRoots: [projectRoot, "/"],
              worktreesByProjectRoot: { [canonicalProjectRoot]: [repoRoot], "/": ["/"] },
            }),
          ),
        );
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
        assert.match(
          "detail" in error ? error.detail : "",
          /must stay within the configured workspace root/,
        );
      }
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "studio-review-workspace-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "studio-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

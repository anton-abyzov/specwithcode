// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as HandoffGit from "./handoffGit.ts";
import {
  canonicalOrigin,
  handoffRef,
  HandoffGitError,
  safeRelativePath,
  validManifest,
  type HandoffGitManifest,
} from "./handoffGitTypes.ts";

const operationId = "019a0000-0000-7000-8000-000000000001";
const temporary: Array<string> = [];
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=Handoff Test",
      "-c",
      "user.email=handoff@example.invalid",
      "-c",
      "protocol.file.allow=always",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
const write = (path: string, value: string) => NodeFS.writeFileSync(path, value);
const commit = (cwd: string) => {
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", "fixture checkpoint");
};

function fixture(submodule = false) {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-handoff-git-")),
  );
  temporary.push(base);
  const source = NodePath.join(base, "source"),
    destination = NodePath.join(base, "destination"),
    outputs = NodePath.join(base, "outputs");
  const rootRemote = NodePath.join(base, "root.git"),
    nestedRemote = NodePath.join(base, "nested.git");
  NodeFS.mkdirSync(source);
  NodeFS.mkdirSync(outputs);
  git(base, "init", "--bare", "--initial-branch=main", rootRemote);
  git(base, "init", "--bare", "--initial-branch=main", nestedRemote);
  git(source, "init", "--initial-branch=main");
  git(source, "remote", "add", "origin", rootRemote);
  write(NodePath.join(source, ".gitignore"), submodule ? "" : "/repositories/\n");
  write(NodePath.join(source, "root.ts"), "export const value = 1;\n");
  commit(source);
  const seed = NodePath.join(base, "nested-seed");
  NodeFS.mkdirSync(seed);
  git(seed, "init", "--initial-branch=main");
  git(seed, "remote", "add", "origin", nestedRemote);
  write(NodePath.join(seed, "feature.ts"), "export const answer = 1;\n");
  commit(seed);
  git(seed, "push", "-u", "origin", "main");
  if (submodule) {
    git(source, "submodule", "add", nestedRemote, "repositories/nested");
    commit(source);
  } else {
    NodeFS.mkdirSync(NodePath.join(source, "repositories"));
    git(base, "clone", nestedRemote, NodePath.join(source, "repositories/nested"));
  }
  git(source, "push", "-u", "origin", "main");
  git(base, "clone", rootRemote, destination);
  if (submodule) git(destination, "submodule", "update", "--init");
  else {
    NodeFS.mkdirSync(NodePath.join(destination, "repositories"));
    git(base, "clone", nestedRemote, NodePath.join(destination, "repositories/nested"));
  }
  return {
    base,
    source,
    destination,
    outputs,
    rootRemote,
    nestedRemote,
    sourceNested: NodePath.join(source, "repositories/nested"),
    destinationNested: NodePath.join(destination, "repositories/nested"),
    submodule,
  };
}
function changeCode(f: ReturnType<typeof fixture>) {
  write(NodePath.join(f.sourceNested, "feature.ts"), "export const answer = 42;\n");
  commit(f.sourceNested);
  write(NodePath.join(f.source, "root.ts"), "export const value = 42;\n");
  commit(f.source);
}
function snapshot(cwd: string) {
  return {
    head: git(cwd, "rev-parse", "HEAD"),
    branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
    index: git(cwd, "ls-files", "--stage"),
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
    refs: git(cwd, "for-each-ref", "--format=%(refname) %(objectname)"),
    config: git(cwd, "config", "--local", "--list"),
  };
}
function gitFiles(cwd: string) {
  const root = NodePath.join(cwd, ".git");
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile())
        files[NodePath.relative(root, file)] = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(file))
          .digest("hex");
    }
  };
  visit(root);
  return files;
}
function localObjectExists(cwd: string, head: string) {
  return (
    NodeChildProcess.spawnSync("git", ["-C", cwd, "cat-file", "-e", `${head}^{commit}`], {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "file",
      },
      stdio: "ignore",
    }).status === 0
  );
}
const calls: Array<ProcessRunner.ProcessRunInput> = [];
let gitTraceFile: string | undefined;
let failWorktreeAt = 0;
let worktreeCalls = 0;
let failPushAt = 0;
let pushCalls = 0;
const observedRunner = Layer.effect(
  ProcessRunner.ProcessRunner,
  Effect.gen(function* () {
    const real = yield* ProcessRunner.ProcessRunner;
    return ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          calls.push(input);
          if (input.args.includes("push") && ++pushCalls === failPushAt) {
            return yield* Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: "git",
                argumentCount: input.args.length,
                cause: new Error("injected publication interruption"),
              }),
            );
          }
          if (
            input.args.includes("worktree") &&
            input.args.includes("add") &&
            ++worktreeCalls === failWorktreeAt
          ) {
            return yield* Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: "git",
                argumentCount: input.args.length,
                cause: new Error("injected interruption"),
              }),
            );
          }
          return yield* real.run({
            ...input,
            env: {
              ...input.env,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              ...(gitTraceFile ? { GIT_TRACE2_EVENT: gitTraceFile } : {}),
            },
          });
        }),
    });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
const live = HandoffGit.layer.pipe(
  Layer.provide(observedRunner),
  Layer.provide(NodeServices.layer),
);
const run = <A>(f: (service: HandoffGit.HandoffGit["Service"]) => Effect.Effect<A, unknown>) =>
  Effect.service(HandoffGit.HandoffGit).pipe(Effect.flatMap(f), Effect.provide(live));
const inspect = (workspaceRoot: string) =>
  run((service) => service.inspect({ workspaceRoot, operationId }));
const publish = (workspaceRoot: string, manifest: HandoffGitManifest) =>
  run((service) => service.publish({ workspaceRoot, manifest, publish: true }));
const materialize = (f: ReturnType<typeof fixture>, manifest: HandoffGitManifest) =>
  run((service) =>
    service.materialize({ workspaceRoot: f.destination, worktreeParent: f.outputs, manifest }),
  );

afterEach(() => {
  for (const directory of temporary.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
  calls.length = 0;
  failWorktreeAt = 0;
  worktreeCalls = 0;
  failPushAt = 0;
  pushCalls = 0;
  gitTraceFile = undefined;
});

describe("HandoffGit real repositories", () => {
  it.effect(
    "previews real promisor clones without fetching missing commits or changing Git state",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        NodeFS.rmSync(f.destination, { recursive: true });
        for (const [remote, destination] of [
          [f.rootRemote, f.destination],
          [f.nestedRemote, f.destinationNested],
        ] as const) {
          git(remote, "config", "uploadpack.allowFilter", "true");
          NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
          git(
            f.base,
            "clone",
            "--no-local",
            "--no-checkout",
            "--filter=blob:none",
            remote,
            destination,
          );
          // This is a negotiated partial clone, with real missing promised blobs.
          expect(git(destination, "rev-list", "--objects", "--all", "--missing=print")).toMatch(
            /^\?[0-9a-f]{40}$/m,
          );
          git(destination, "checkout", "--force", "main");
          expect(git(destination, "config", "remote.origin.promisor")).toBe("true");
          // Existing fleet clones have this valid state. An implicit lazy fetch
          // registers blob:none here, mutating config before transfer consent.
          git(destination, "config", "--unset", "remote.origin.partialclonefilter");
        }
        changeCode(f);
        const manifest = yield* inspect(f.source);
        yield* publish(f.source, manifest);
        const roots = [f.destination, f.destinationNested];
        expect(
          manifest.repositories.every((row, i) => !localObjectExists(roots[i]!, row.head)),
        ).toBe(true);
        const before = roots.map((cwd) => ({ checkout: snapshot(cwd), files: gitFiles(cwd) }));
        gitTraceFile = NodePath.join(f.base, "preview-git-trace.jsonl");
        calls.length = 0;
        yield* inspect(f.destination);
        yield* run((service) => service.preflight({ workspaceRoot: f.destination, manifest }));
        yield* run((service) => service.preflight({ workspaceRoot: f.destination, manifest }));
        expect(roots.map((cwd) => ({ checkout: snapshot(cwd), files: gitFiles(cwd) }))).toEqual(
          before,
        );
        expect(
          manifest.repositories.every((row, i) => !localObjectExists(roots[i]!, row.head)),
        ).toBe(true);
        const trace = NodeFS.readFileSync(gitTraceFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event: string; argv?: Array<string> });
        expect(
          trace.filter(
            (event) =>
              event.event === "child_start" &&
              event.argv?.some((arg) => /(?:^|\/)git-upload-pack$|^fetch$|^upload-pack$/.test(arg)),
          ),
        ).toEqual([]);
        expect(
          calls.some((call) =>
            call.args.some((arg) => ["fetch", "push", "ls-remote"].includes(arg)),
          ),
        ).toBe(false);

        // Explicit materialization still fetches the named refs and hydrates the
        // isolated checkout after authorization; the original checkout stays put.
        gitTraceFile = undefined;
        const materialized = yield* materialize(f, manifest);
        expect(
          NodeFS.readFileSync(NodePath.join(materialized.workspaceRoot, "root.ts"), "utf8"),
        ).toContain("42");
        expect(
          NodeFS.readFileSync(
            NodePath.join(materialized.workspaceRoot, "repositories/nested/feature.ts"),
            "utf8",
          ),
        ).toContain("42");
        expect(roots.map((cwd) => git(cwd, "rev-parse", "HEAD"))).toEqual(
          before.map((row) => row.checkout.head),
        );
        expect(calls.some((call) => call.args.includes("fetch"))).toBe(true);
      }),
  );

  it.effect("preserves extra destination repositories when the source is a partial umbrella", () =>
    Effect.gen(function* () {
      const f = fixture();
      const extra = NodePath.join(f.destination, "repositories/extra");
      git(f.base, "clone", f.rootRemote, extra);
      git(extra, "config", "handoff.test", "preserve-me");
      write(NodePath.join(extra, "root.ts"), "unrelated dirty destination code\n");
      const before = [snapshot(f.destination), snapshot(f.destinationNested), snapshot(extra)];
      changeCode(f);
      const manifest = yield* inspect(f.source);
      yield* publish(f.source, manifest);
      calls.length = 0;
      const result = yield* materialize(f, manifest);
      expect(result.repositories.map((repository) => repository.relativePath)).toEqual([
        ".",
        "repositories/nested",
      ]);
      expect(NodeFS.existsSync(NodePath.join(result.workspaceRoot, "repositories/extra"))).toBe(
        false,
      );
      expect(
        NodeFS.readFileSync(
          NodePath.join(result.workspaceRoot, "repositories/nested/feature.ts"),
          "utf8",
        ),
      ).toContain("42");
      expect([snapshot(f.destination), snapshot(f.destinationNested), snapshot(extra)]).toEqual(
        before,
      );
      expect(NodeFS.readFileSync(NodePath.join(extra, "root.ts"), "utf8")).toBe(
        "unrelated dirty destination code\n",
      );
      expect(calls.some((call) => call.cwd === extra)).toBe(false);
    }),
  );
  it.effect("inspects ignored nested repositories without writes or network access", () =>
    Effect.gen(function* () {
      const f = fixture();
      const before = [snapshot(f.source), snapshot(f.sourceNested)];
      const manifest = yield* inspect(f.source);
      expect(manifest.repositories.map((repo) => repo.relativePath)).toEqual([
        ".",
        "repositories/nested",
      ]);
      expect(manifest.repositories.map((repo) => repo.head)).toEqual(
        before.map((repo) => repo.head),
      );
      expect([snapshot(f.source), snapshot(f.sourceNested)]).toEqual(before);
      expect(
        calls.some((call) =>
          call.args.some((arg) => ["push", "fetch", "ls-remote", "worktree"].includes(arg)),
        ),
      ).toBe(false);
    }),
  );

  it.effect.each([false, true])(
    "transfers real root and nested code into isolated worktrees; submodule=%s",
    (submodule) =>
      Effect.gen(function* () {
        const f = fixture(submodule);
        changeCode(f);
        const sourceBefore = [snapshot(f.source), snapshot(f.sourceNested)];
        const destinationBefore = [snapshot(f.destination), snapshot(f.destinationNested)];
        const manifest = yield* inspect(f.source);
        // Incoming commits do not exist in the destination yet: preview must remain read-only.
        expect(() =>
          git(f.destination, "cat-file", "-e", `${manifest.repositories[0]!.head}^{commit}`),
        ).toThrow();
        calls.length = 0;
        yield* run((service) => service.preflight({ workspaceRoot: f.destination, manifest }));
        expect(
          calls.some((call) => call.args.includes("fetch") || call.args.includes("push")),
        ).toBe(false);
        expect(git(f.rootRemote, "for-each-ref", "refs/heads/codex/handoff")).toBe("");
        yield* publish(f.source, manifest);
        // Git records the explicitly published refs in origin's tracking namespace.
        // Existing refs, branches, index, and worktree contents remain unchanged.
        for (const [index, cwd] of [f.source, f.sourceNested].entries()) {
          const after = snapshot(cwd);
          expect({
            ...after,
            refs: after.refs
              .split("\n")
              .filter((line) => !line.startsWith("refs/remotes/origin/codex/handoff/"))
              .join("\n"),
          }).toEqual(sourceBefore[index]);
        }
        const sourcePublished = [snapshot(f.source), snapshot(f.sourceNested)];
        const output = yield* materialize(f, manifest);
        expect(output.workspaceRoot).toBe(NodePath.join(f.outputs, operationId, "workspace"));
        expect(
          NodeFS.readFileSync(NodePath.join(output.workspaceRoot, "root.ts"), "utf8"),
        ).toContain("value = 42");
        expect(
          NodeFS.readFileSync(
            NodePath.join(output.workspaceRoot, "repositories/nested/feature.ts"),
            "utf8",
          ),
        ).toContain("answer = 42");
        expect(
          output.repositories.map((repo) => git(repo.worktreePath, "rev-parse", "HEAD")),
        ).toEqual(manifest.repositories.map((repo) => repo.head));
        expect(
          git(output.workspaceRoot, "status", "--porcelain=v1", "--ignore-submodules=none"),
        ).toBe("");
        expect([snapshot(f.source), snapshot(f.sourceNested)]).toEqual(sourcePublished);
        expect([snapshot(f.destination), snapshot(f.destinationNested)]).toEqual(destinationBefore);
        const previousWorktrees = output.repositories.map((repo) =>
          git(repo.worktreePath, "worktree", "list", "--porcelain"),
        );
        yield* publish(f.source, manifest);
        expect(yield* materialize(f, manifest)).toEqual(output);
        expect(
          output.repositories.map((repo) =>
            git(repo.worktreePath, "worktree", "list", "--porcelain"),
          ),
        ).toEqual(previousWorktrees);
        expect([snapshot(f.destination), snapshot(f.destinationNested)]).toEqual(destinationBefore);
      }),
  );

  it.effect("resumes an interrupted root-plus-submodule materialization in a fresh service", () =>
    Effect.gen(function* () {
      const f = fixture(true);
      changeCode(f);
      const manifest = yield* inspect(f.source);
      yield* publish(f.source, manifest);
      failWorktreeAt = 2;
      expect(yield* materialize(f, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "git-failed",
      });
      expect(git(NodePath.join(f.outputs, operationId, "workspace"), "rev-parse", "HEAD")).toBe(
        manifest.repositories[0]!.head,
      );
      const output = yield* materialize(f, manifest);
      expect(
        NodeFS.readFileSync(
          NodePath.join(output.workspaceRoot, "repositories/nested/feature.ts"),
          "utf8",
        ),
      ).toContain("answer = 42");
      expect(worktreeCalls).toBe(3);
    }),
  );

  it.effect("resumes partial publication without replacing the first immutable ref", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* inspect(f.source);
      failPushAt = 2;
      expect(yield* publish(f.source, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "git-failed",
      });
      expect(git(f.rootRemote, "rev-parse", manifest.repositories[0]!.ref)).toBe(
        manifest.repositories[0]!.head,
      );
      yield* publish(f.source, manifest);
      expect(pushCalls).toBe(3);
      expect(git(f.nestedRemote, "rev-parse", manifest.repositories[1]!.ref)).toBe(
        manifest.repositories[1]!.head,
      );
    }),
  );

  it.effect("resumes after operation directory creation but before the receipt exists", () =>
    Effect.gen(function* () {
      const f = fixture();
      const manifest = yield* inspect(f.source);
      yield* publish(f.source, manifest);
      NodeFS.mkdirSync(NodePath.join(f.outputs, operationId), { mode: 0o700 });
      expect((yield* materialize(f, manifest)).workspaceRoot).toBe(
        NodePath.join(f.outputs, operationId, "workspace"),
      );
    }),
  );

  it.effect("preserves edits and attached branches in a previously materialized workspace", () =>
    Effect.gen(function* () {
      const f = fixture();
      const manifest = yield* inspect(f.source);
      yield* publish(f.source, manifest);
      const output = yield* materialize(f, manifest);
      write(
        NodePath.join(output.workspaceRoot, "repositories/nested/feature.ts"),
        "worker's new code\n",
      );
      expect(yield* materialize(f, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "dirty-repository",
      });
      expect(
        NodeFS.readFileSync(
          NodePath.join(output.workspaceRoot, "repositories/nested/feature.ts"),
          "utf8",
        ),
      ).toBe("worker's new code\n");
      git(output.workspaceRoot, "switch", "-c", "worker-progress");
      expect(yield* materialize(f, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "worktree-conflict",
      });
    }),
  );

  it.effect("blocks dirty root and ignored nested source changes", () =>
    Effect.gen(function* () {
      const f = fixture();
      write(NodePath.join(f.source, "root.ts"), "dirty");
      expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({
        reason: "dirty-repository",
      });
      git(f.source, "restore", "root.ts");
      write(NodePath.join(f.sourceNested, "feature.ts"), "dirty");
      expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({
        reason: "dirty-repository",
      });
    }),
  );

  it.effect("rejects a gitlink checkpoint inconsistent with initialized nested HEAD", () =>
    Effect.gen(function* () {
      const f = fixture(true);
      write(NodePath.join(f.sourceNested, "feature.ts"), "new commit\n");
      commit(f.sourceNested);
      expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({
        reason: "dirty-repository",
      });
    }),
  );

  it.effect("blocks uninitialized nested gitlinks", () =>
    Effect.gen(function* () {
      const f = fixture(true);
      git(f.source, "submodule", "deinit", "--all");
      expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({
        reason: "uninitialized-repository",
      });
    }),
  );

  it.effect("blocks publication unless opted in and source still matches preview", () =>
    Effect.gen(function* () {
      const f = fixture();
      const manifest = yield* inspect(f.source);
      expect(
        yield* run((service) =>
          service.publish({ workspaceRoot: f.source, manifest, publish: false as true }),
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-manifest" });
      changeCode(f);
      expect(yield* publish(f.source, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "source-changed",
      });
      expect(git(f.rootRemote, "for-each-ref", "refs/heads/codex/handoff")).toBe("");
    }),
  );

  it.effect("binds a published operation durably against changed-code reuse", () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* publish(f.source, yield* inspect(f.source));
      changeCode(f);
      expect(yield* publish(f.source, yield* inspect(f.source)).pipe(Effect.flip)).toMatchObject({
        reason: "operation-conflict",
      });
    }),
  );

  it.effect("rejects a dirty destination before fetching", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* inspect(f.source);
      write(NodePath.join(f.destinationNested, "feature.ts"), "dirty");
      calls.length = 0;
      expect(yield* materialize(f, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "dirty-repository",
      });
      expect(calls.some((call) => call.args.includes("fetch"))).toBe(false);
    }),
  );

  it.effect("rejects missing nested repositories and mismatched origin identities", () =>
    Effect.gen(function* () {
      const f = fixture();
      const manifest = yield* inspect(f.source);
      git(f.destinationNested, "remote", "set-url", "origin", f.rootRemote);
      expect(
        yield* run((service) => service.preflight({ workspaceRoot: f.destination, manifest })).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "identity-mismatch" });
      NodeFS.rmSync(f.destinationNested, { recursive: true });
      expect(
        yield* run((service) => service.preflight({ workspaceRoot: f.destination, manifest })).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ reason: "missing-repository" });
    }),
  );

  it.effect.each(["insteadOf", "pushInsteadOf"])(
    "rejects effective origin %s identity changes before any network call",
    (rewrite) =>
      Effect.gen(function* () {
        const f = fixture();
        git(f.source, "config", `url.${f.nestedRemote}.${rewrite}`, f.rootRemote);
        calls.length = 0;
        expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({
          reason: "identity-mismatch",
        });
        expect(
          calls.some((call) =>
            call.args.some((arg) => ["push", "fetch", "ls-remote"].includes(arg)),
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "rejects divergent destination history after fetching without changing its checkout",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        changeCode(f);
        const manifest = yield* inspect(f.source);
        yield* publish(f.source, manifest);
        write(NodePath.join(f.destination, "root.ts"), "export const value = 99;\n");
        commit(f.destination);
        const before = snapshot(f.destination);
        expect(yield* materialize(f, manifest).pipe(Effect.flip)).toMatchObject({
          reason: "diverged-repository",
        });
        expect(snapshot(f.destination)).toEqual(before);
      }),
  );

  it.effect("rejects absent or changed published refs", () =>
    Effect.gen(function* () {
      const f = fixture();
      changeCode(f);
      const manifest = yield* inspect(f.source);
      expect(yield* materialize(f, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "remote-ref-mismatch",
      });
      const root = manifest.repositories[0]!;
      git(f.rootRemote, "update-ref", root.ref, git(f.rootRemote, "rev-parse", "main"));
      expect(yield* publish(f.source, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "remote-ref-mismatch",
      });
    }),
  );

  it.effect("rejects traversal manifests, symlink repositories and symlink output roots", () =>
    Effect.gen(function* () {
      const f = fixture();
      const manifest = yield* inspect(f.source);
      const invalid = {
        ...manifest,
        repositories: [
          manifest.repositories[0]!,
          { ...manifest.repositories[1]!, relativePath: "../outside" },
        ],
      };
      expect(
        yield* run((service) =>
          service.preflight({ workspaceRoot: f.destination, manifest: invalid }),
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "invalid-manifest" });
      NodeFS.symlinkSync(f.sourceNested, NodePath.join(f.source, "linked-repository"));
      expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({ reason: "unsafe-path" });
      NodeFS.rmSync(NodePath.join(f.source, "linked-repository"));
      NodeFS.symlinkSync(f.outputs, NodePath.join(f.base, "linked-output"));
      expect(
        yield* run((service) =>
          service.materialize({
            workspaceRoot: f.destination,
            manifest,
            worktreeParent: NodePath.join(f.base, "linked-output"),
          }),
        ).pipe(Effect.flip),
      ).toMatchObject({ reason: "unsafe-path" });
    }),
  );

  it.effect("rejects a different manifest at an existing isolated operation path", () =>
    Effect.gen(function* () {
      const f = fixture();
      const original = yield* inspect(f.source);
      yield* publish(f.source, original);
      yield* materialize(f, original);
      changeCode(f);
      const changed = yield* inspect(f.source);
      expect(yield* materialize(f, changed).pipe(Effect.flip)).toMatchObject({
        reason: "operation-conflict",
      });
    }),
  );

  it.effect.each(["../private-file", "/some/absolute/file", "../missing/escape"])(
    "rejects tracked symlink escape %s",
    (target) =>
      Effect.gen(function* () {
        const f = fixture();
        NodeFS.symlinkSync(target, NodePath.join(f.source, "linked-file"));
        commit(f.source);
        expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({ reason: "unsafe-path" });
      }),
  );

  it.effect("preserves a safe relative tracked file symlink inside isolated code", () =>
    Effect.gen(function* () {
      const f = fixture();
      NodeFS.symlinkSync("root.ts", NodePath.join(f.source, "linked-file"));
      commit(f.source);
      const manifest = yield* inspect(f.source);
      yield* publish(f.source, manifest);
      const output = yield* materialize(f, manifest);
      write(NodePath.join(output.workspaceRoot, "linked-file"), "owned isolated edit\n");
      expect(NodeFS.readFileSync(NodePath.join(f.destination, "root.ts"), "utf8")).toContain(
        "value = 1",
      );
      expect(NodeFS.readFileSync(NodePath.join(output.workspaceRoot, "root.ts"), "utf8")).toBe(
        "owned isolated edit\n",
      );
    }),
  );
});

describe("handoff identity and immutable ref", () => {
  it.each([
    "",
    "https://github.com/%ZZ",
    "git@github.com:../escape",
    "https://github.com/.git",
    "file:///tmp/test.git",
  ])("handles bounded identity input %s", (value) => {
    expect(canonicalOrigin(value)).toBe(value.startsWith("file:") ? "file:///tmp/test.git" : null);
  });
  it("validates hostile manifests and safe path forms", () => {
    const row = {
      relativePath: ".",
      identity: "github.com/team/repo",
      head: "a".repeat(40),
      ref: handoffRef(operationId, "a".repeat(40)),
    };
    const manifest = { version: 1 as const, operationId, repositories: [row] };
    expect(validManifest(manifest)).toBe(true);
    expect(validManifest({ ...manifest, version: 2 } as unknown as HandoffGitManifest)).toBe(false);
    expect(validManifest({ ...manifest, repositories: [] })).toBe(false);
    expect(validManifest({ ...manifest, repositories: [row, row] })).toBe(false);
    expect(validManifest({ ...manifest, operationId: "invalid" })).toBe(false);
    expect(safeRelativePath("nested/file")).toBe(true);
    expect(safeRelativePath("nested//file")).toBe(false);
    expect(
      new HandoffGitError({ stage: "inspect", reason: "worker-checkpoint" }).message,
    ).toContain("worker-checkpoint");
    expect(canonicalOrigin("ssh://git@forge.test:2222/team/repo.git")).toBe(
      "forge.test:2222/team/repo",
    );
  });
  it("matches HTTPS and SSH origins without serializing credentials", () => {
    expect(canonicalOrigin("https://github.com/team/project.git")).toBe("github.com/team/project");
    expect(canonicalOrigin("git@github.com:team/project.git")).toBe("github.com/team/project");
    expect(canonicalOrigin("ssh://git@github.com/team/project.git")).toBe(
      "github.com/team/project",
    );
    expect(canonicalOrigin("https://user:secret@github.com/team/project.git")).toBeNull();
    expect(canonicalOrigin("ext::arbitrary command")).toBeNull();
    expect(handoffRef(operationId, "a".repeat(40))).toBe(
      `refs/heads/codex/handoff/${operationId}/${"a".repeat(40)}`,
    );
  });
});

describe("worker checkpoint guard", () => {
  it.effect("does not lose surviving worker branches when their checkout was removed", () =>
    Effect.gen(function* () {
      const f = fixture();
      const worker = NodePath.join(f.base, "removed-worker");
      git(f.source, "worktree", "add", "-b", "retained-worker", worker);
      write(NodePath.join(worker, "root.ts"), "export const value = 99;\n");
      commit(worker);
      const workerHead = git(worker, "rev-parse", "HEAD");
      git(f.source, "worktree", "remove", worker);
      const original = yield* inspect(f.source);
      const verify = (branch: string | null, worktreePath: string | null, manifest = original) =>
        run((service) =>
          service.verifyWorkerCheckpoints({
            workspaceRoot: f.source,
            manifest,
            workers: [{ branch, worktreePath }],
          }),
        );
      expect(yield* verify("retained-worker", worker).pipe(Effect.flip)).toMatchObject({
        reason: "worker-checkpoint",
      });
      expect(yield* verify("retained-worker", null).pipe(Effect.flip)).toMatchObject({
        reason: "worker-checkpoint",
      });
      expect(yield* verify(null, worker).pipe(Effect.flip)).toMatchObject({
        reason: "worker-checkpoint",
      });
      expect(yield* verify("@{-1}", worker).pipe(Effect.flip)).toMatchObject({
        reason: "worker-checkpoint",
      });
      expect(yield* verify("--all", worker).pipe(Effect.flip)).toMatchObject({
        reason: "worker-checkpoint",
      });
      git(f.source, "merge", "--ff-only", "retained-worker");
      const merged = yield* inspect(f.source);
      expect(merged.repositories[0]?.head).toBe(workerHead);
      yield* verify("retained-worker", worker, merged);
      git(f.source, "branch", "-d", "retained-worker");
      yield* verify("retained-worker", worker, merged);
      expect(git(f.rootRemote, "for-each-ref", "refs/heads/codex/handoff")).toBe("");
    }),
  );
  it.effect("honors source pre-push validation before remote publication", () =>
    Effect.gen(function* () {
      const f = fixture();
      const manifest = yield* inspect(f.source);
      const hook = NodePath.join(f.source, ".git/hooks/pre-push");
      git(f.source, "config", "core.hooksPath", NodePath.dirname(hook));
      write(hook, "#!/bin/sh\nexit 1\n");
      NodeFS.chmodSync(hook, 0o755);
      expect(yield* publish(f.source, manifest).pipe(Effect.flip)).toMatchObject({
        reason: "git-failed",
      });
      expect(git(f.rootRemote, "for-each-ref", "refs/heads/codex/handoff")).toBe("");
      expect(git(f.nestedRemote, "for-each-ref", "refs/heads/codex/handoff")).toBe("");
    }),
  );
  it.effect(
    "blocks dirty and unmerged work then accepts a merged checkpoint and deleted history without network writes",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const worker = NodePath.join(f.base, "worker");
        git(f.source, "worktree", "add", "-b", "worker-task", worker);
        const verify = (manifest: HandoffGitManifest, worktreePaths = [worker]) =>
          run((service) =>
            service.verifyWorkerCheckpoints({
              workspaceRoot: f.source,
              manifest,
              workers: worktreePaths.map((worktreePath) => ({
                worktreePath,
                branch: "worker-task",
              })),
            }),
          );
        const original = yield* inspect(f.source);
        NodeFS.mkdirSync(NodePath.join(worker, "repositories"));
        const workerNested = NodePath.join(worker, "repositories/nested");
        git(f.base, "clone", f.nestedRemote, workerNested);
        write(NodePath.join(workerNested, "feature.ts"), "pending nested worker code\n");
        expect(yield* verify(original).pipe(Effect.flip)).toMatchObject({
          reason: "worker-checkpoint",
        });
        git(workerNested, "restore", "feature.ts");
        yield* verify(original);
        write(NodePath.join(worker, "root.ts"), "export const value = 77;\n");
        expect(yield* verify(original).pipe(Effect.flip)).toMatchObject({
          reason: "worker-checkpoint",
        });
        commit(worker);
        expect(yield* verify(original).pipe(Effect.flip)).toMatchObject({
          reason: "worker-checkpoint",
        });
        git(f.source, "merge", "--ff-only", "worker-task");
        const merged = yield* inspect(f.source);
        const before = snapshot(worker);
        calls.length = 0;
        yield* verify(merged, [worker, worker]);
        expect(snapshot(worker)).toEqual(before);
        expect(
          calls.some((call) =>
            call.args.some((arg) => ["fetch", "push", "worktree"].includes(arg)),
          ),
        ).toBe(false);
        NodeFS.rmSync(NodePath.join(worker, "repositories"), { recursive: true });
        git(f.source, "worktree", "remove", worker);
        yield* verify(merged);
        expect(yield* verify(merged, ["../unsafe"]).pipe(Effect.flip)).toMatchObject({
          reason: "worker-checkpoint",
        });
        expect(
          yield* verify(
            merged,
            Array.from({ length: 101 }, (_, index) => NodePath.join(f.base, `missing-${index}`)),
          ).pipe(Effect.flip),
        ).toMatchObject({ reason: "worker-checkpoint" });
      }),
  );
  it.effect("rejects wrong-identity, stale-source and symlink worker paths", () =>
    Effect.gen(function* () {
      const f = fixture();
      const manifest = yield* inspect(f.source);
      const worker = NodePath.join(f.base, "worker");
      git(f.source, "worktree", "add", "--detach", worker);
      const verify = (worktreePaths: ReadonlyArray<string>, target = manifest) =>
        run((service) =>
          service.verifyWorkerCheckpoints({
            workspaceRoot: f.source,
            manifest: target,
            workers: worktreePaths.map((worktreePath) => ({ worktreePath, branch: null })),
          }),
        );
      const wrong = {
        ...manifest,
        repositories: [
          { ...manifest.repositories[0]!, identity: "github.com/other/repo" },
          manifest.repositories[1]!,
        ],
      };
      expect(yield* verify([worker], wrong).pipe(Effect.flip)).toMatchObject({
        reason: "worker-checkpoint",
      });
      changeCode(f);
      expect(yield* verify([worker]).pipe(Effect.flip)).toMatchObject({
        reason: "worker-checkpoint",
      });
      NodeFS.symlinkSync(worker, NodePath.join(f.base, "worker-link"));
      expect(yield* verify([NodePath.join(f.base, "worker-link")]).pipe(Effect.flip)).toMatchObject(
        { reason: "worker-checkpoint" },
      );
    }),
  );
  it.effect(
    "rejects missing roots, invalid operation IDs, excessive scan depth and conflicting push URLs",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        expect(yield* inspect(NodePath.join(f.base, "missing")).pipe(Effect.flip)).toMatchObject({
          reason: "filesystem-failed",
        });
        expect(yield* inspect("relative").pipe(Effect.flip)).toMatchObject({
          reason: "unsafe-path",
        });
        expect(yield* inspect(f.outputs).pipe(Effect.flip)).toMatchObject({
          reason: "missing-repository",
        });
        expect(
          yield* run((service) =>
            service.inspect({ workspaceRoot: f.source, operationId: "invalid" }),
          ).pipe(Effect.flip),
        ).toMatchObject({ reason: "invalid-manifest" });
        git(f.source, "remote", "set-url", "--push", "origin", f.nestedRemote);
        expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({
          reason: "identity-mismatch",
        });
        git(f.source, "config", "--unset", "remote.origin.pushurl");
        git(f.source, "remote", "set-url", "origin", "ext::unsupported");
        expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({
          reason: "identity-mismatch",
        });
        NodeFS.mkdirSync(NodePath.join(f.source, ...Array.from({ length: 25 }, () => "depth")), {
          recursive: true,
        });
        expect(yield* inspect(f.source).pipe(Effect.flip)).toMatchObject({ reason: "scan-limit" });
      }),
  );
});

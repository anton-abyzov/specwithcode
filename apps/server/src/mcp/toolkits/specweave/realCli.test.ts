// @effect-diagnostics nodeBuiltinImport:off - A scratch Git repository, its bare remote and the real specweave CLI.
/**
 * The ledger tools against the real `specweave` CLI (1497): with
 * `git.autoCommitIncrement` and `git.autoPushIncrement` both on, a claim, a
 * repeated claim, a block and a release change only the increment's
 * `ledger.jsonl` and `metadata.json`. HEAD, every ref (local and the bare
 * remote's) and the index stay as they were, and the ledger holds one event
 * per change, written as the agent the thread's own shell is.
 *
 * Runs where a `specweave` command is installed (SPECWEAVE_REAL_CLI, the PATH
 * or the app's command folder) and is skipped elsewhere. HOME points at a
 * scratch folder for the run, so SpecWeave's binding file lands there.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ThreadIncrementProgress,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as IncrementProgress from "../../../project/ThreadIncrementProgressService.ts";
import { specweaveAgentEnvironment } from "../../../provider/RuntimeInstructions.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { SpecweaveCommandOverride } from "./cli.ts";
import { runLedgerCall } from "./ledgerHandlers.ts";

const isWindows = HostProcessPlatform.defaultValue() === "win32";
const INCREMENT = "0042-scratch-ledger";
const threadId = ThreadId.make("thread-real-cli");

function realCli(): string | null {
  const named = process.env.SPECWEAVE_REAL_CLI;
  if (named && NodeFS.existsSync(named)) return named;
  const dirs = [
    ...(process.env.PATH ?? "").split(NodePath.delimiter),
    NodePath.join(NodeOS.homedir(), ".specwithcode", "commands"),
  ];
  for (const dir of dirs) {
    const candidate = NodePath.join(dir, "specweave");
    if (dir && NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

const CLI = isWindows ? null : realCli();

const gitRaw = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
const git = (cwd: string, ...args: string[]) => gitRaw(cwd, ...args).trim();

const SPEC = `# Scratch ledger

## Problem
A scratch increment for the ledger tools.

## Scope
In: one task.

## Acceptance Criteria
- [ ] AC-01: A task can be claimed

## Approach
None.

## Tasks

### T-01 Do the thing
- AC: AC-01 | Files: notes.txt | Test: true
`;

function scratchRepository() {
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-real-")));
  const remote = NodePath.join(root, "remote.git");
  const worktree = NodePath.join(root, "worktree");
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home);
  NodeChildProcess.execFileSync("git", ["init", "-q", "--bare", remote]);
  NodeFS.mkdirSync(worktree);
  git(worktree, "init", "-q", "-b", "main");
  git(worktree, "config", "user.email", "scratch@example.invalid");
  git(worktree, "config", "user.name", "Scratch");
  git(worktree, "config", "commit.gpgsign", "false");
  const increment = NodePath.join(worktree, ".specweave", "increments", INCREMENT);
  NodeFS.mkdirSync(increment, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(worktree, ".specweave", "config.json"),
    `${JSON.stringify({ version: "2.0", git: { autoCommitIncrement: true, autoPushIncrement: true } }, null, 2)}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(increment, "spec.md"), SPEC);
  NodeFS.writeFileSync(NodePath.join(increment, "ledger.jsonl"), "");
  NodeFS.writeFileSync(
    NodePath.join(increment, "metadata.json"),
    `${JSON.stringify({ id: INCREMENT, status: "planned", type: "feature", created: "2026-11-26T00:00:00Z" }, null, 2)}\n`,
  );
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "scratch");
  git(worktree, "remote", "add", "origin", remote);
  git(worktree, "push", "-q", "-u", "origin", "main");
  return { root, remote, worktree, home, increment };
}

const gitState = (repo: { worktree: string; remote: string }) => ({
  head: git(repo.worktree, "rev-parse", "HEAD"),
  refs: git(repo.worktree, "for-each-ref", "--format=%(refname) %(objectname)"),
  remoteRefs: git(repo.remote, "for-each-ref", "--format=%(refname) %(objectname)"),
  index: git(repo.worktree, "ls-files", "--stage"),
  staged: git(repo.worktree, "diff", "--cached", "--name-only"),
  stash: git(repo.worktree, "stash", "list"),
});

it.effect.skipIf(CLI === null)(
  "claim, re-claim, block and release with the real CLI touch no Git state (1497)",
  () =>
    Effect.gen(function* () {
      const repo = scratchRepository();
      const savedHome = process.env.HOME;
      process.env.HOME = repo.home;
      try {
        const before = gitState(repo);
        const bound: ThreadIncrementProgress = {
          threadId,
          incrementId: INCREMENT,
          binding: "manual",
          boundTaskId: null,
          title: null,
          status: "planned",
          incrementPath: repo.increment,
          specPath: null,
          readable: true,
          tasks: [],
          criteria: [],
          verify: null,
        };
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("environment-real-cli"),
          requestNamespace: "real-cli",
          capabilities: new Set(["orchestration"] as const),
          issuedAt: 1,
          thread: {
            threadId,
            providerSessionId: "provider-session-real",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
        };
        const layer = Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed({ ...liveThreadShell(id), worktreePath: repo.worktree }),
            listProjectThreads: () => Effect.succeed([]),
          }),
          Layer.mock(IncrementProgress.ThreadIncrementProgressService)({
            read: (input) => Effect.succeed({ projectId: input.projectId, threads: [bound] }),
          }),
          ServerSettings.layerTest({}),
          Layer.succeed(SpecweaveCommandOverride, CLI!),
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
        );
        const call = (action: "claim" | "release" | "block", reason?: string) =>
          runLedgerCall({ action, increment: "0042", task: "T-01", reason }).pipe(
            Effect.provide(layer),
          );

        const claimed = yield* call("claim");
        expect(claimed).toMatchObject({ changed: true, status: "claimed" });
        expect(yield* call("claim")).toMatchObject({ changed: false });
        expect(yield* call("block", "waiting on the scratch API")).toMatchObject({
          changed: true,
          status: "blocked",
        });
        expect(yield* call("block", "waiting on the scratch API")).toMatchObject({
          changed: false,
        });
        // Other spacing is the same reason: still one block event.
        expect(yield* call("block", "waiting  on the\tscratch API ")).toMatchObject({
          changed: false,
        });
        expect(yield* call("release")).toMatchObject({ changed: true, status: "open" });
        expect(yield* call("release")).toMatchObject({ changed: false });

        // No commit, no push, no ref, no index change, no stash.
        expect(gitState(repo)).toEqual(before);
        const changed = gitRaw(
          repo.worktree,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        )
          .split("\0")
          .filter(Boolean)
          .map((entry) => entry.replace(/^.{2} /, ""))
          .toSorted();
        expect(changed).toEqual([
          `.specweave/increments/${INCREMENT}/ledger.jsonl`,
          `.specweave/increments/${INCREMENT}/metadata.json`,
        ]);

        // One event per change, as the agent the thread's own shell is.
        const shellAgent = NodeChildProcess.execFileSync(CLI!, ["task", "whoami", "--json"], {
          cwd: repo.worktree,
          encoding: "utf8",
          env: {
            ...process.env,
            ...specweaveAgentEnvironment({ threadId, tool: "codex" }),
          },
        });
        const agent = (JSON.parse(shellAgent) as { agent: string }).agent;
        expect(claimed.agent).toBe(agent);
        const events = NodeFS.readFileSync(NodePath.join(repo.increment, "ledger.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { t: string; e: string; by: string; note?: string });
        expect(events.map((event) => [event.t, event.e, event.by])).toEqual([
          ["T-01", "claim", agent],
          ["T-01", "block", agent],
          ["T-01", "release", agent],
        ]);
        expect(events[1]?.note).toBe("waiting on the scratch API");

        // SpecWeave bound this thread to the increment, in the scratch home.
        const binding = JSON.parse(
          NodeFS.readFileSync(
            NodePath.join(repo.home, ".specweave", "studio", "threads", `${threadId}.json`),
            "utf8",
          ),
        ) as { incrementId: string; root: string };
        expect(binding).toMatchObject({ incrementId: INCREMENT, root: repo.worktree });
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
        NodeFS.rmSync(repo.root, { recursive: true, force: true });
      }
    }),
  120_000,
);

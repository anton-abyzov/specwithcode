// @effect-diagnostics nodeBuiltinImport:off - Scratch worktree and a stand-in CLI.
/**
 * The SpecWeave tools run through the server's own MCP layer, not only a
 * hand-built one (1483). The test provides no ProcessRunner itself, so a
 * registration that forgets it fails here, as it did in 1.0.442.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@specweave-studio/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import {
  callToolAsThread,
  fullLayerTestServices,
  serveFullLayer,
} from "../../McpFullLayer.testkit.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { SpecweaveCommandOverride } from "./cli.ts";

const isWindows = HostProcessPlatform.defaultValue() === "win32";
const STAND_IN = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const agent = process.env.SPECWEAVE_TOOL + "@scratch";
if (argv.includes("next")) process.stdout.write(JSON.stringify({ argv, next: { id: "T-02" } }));
else if (argv.includes("claim")) process.stdout.write(JSON.stringify({ claimed: "T-04", by: agent }));
else process.stdout.write(JSON.stringify({ argv, agent, tasks: [{ id: "T-01", status: "claimed", by: "codex@m5" }, { id: "T-04", status: process.env.CLAIMED_FILE && require("node:fs").existsSync(process.env.CLAIMED_FILE) ? "claimed" : "open", by: agent }] }));
if (argv.includes("claim")) require("node:fs").writeFileSync(process.env.CLAIMED_FILE, "1");
`;

const scratch = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-full-layer-")),
    );
    const worktree = NodePath.join(root, "worktree");
    NodeFS.mkdirSync(NodePath.join(worktree, ".specweave", "increments", "1497-ledger"), {
      recursive: true,
    });
    NodeFS.writeFileSync(NodePath.join(worktree, ".specweave", "config.json"), "{}\n");
    const cli = NodePath.join(root, "specweave");
    NodeFS.writeFileSync(cli, STAND_IN, { mode: 0o755 });
    return { root, worktree, cli };
  }),
  ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

it.effect.skipIf(isWindows)(
  "both SpecWeave tools run through the full server layer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { worktree, cli } = yield* scratch;
        yield* serveFullLayer({ projectId: "p", worktreePath: worktree, deletedAt: null }).pipe(
          Effect.provideService(SpecweaveCommandOverride, cli),
        );
        const status = yield* callToolAsThread("specweave_task_status", { increment: "1483" });
        expect(status.result?.isError, String(status.result?.content)).toBeFalsy();
        expect(status.result?.structuredContent).toMatchObject({
          ok: true,
          workspace: worktree,
        });
        const next = yield* callToolAsThread("specweave_next_task", { increment: "1483" });
        expect(next.result?.isError, String(next.result?.content)).toBeFalsy();
        expect(next.result?.structuredContent).toMatchObject({
          ok: true,
          data: { next: { id: "T-02" }, liveClaims: [{ id: "T-01", status: "claimed" }] },
        });
      }),
    ).pipe(Effect.provide(fullLayerTestServices)),
  60_000,
);

it.effect.skipIf(isWindows)(
  "the SpecWeave ledger writes run through the full server layer (1497)",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, worktree, cli } = yield* scratch;
        process.env.CLAIMED_FILE = NodePath.join(root, "claimed");
        const increment = NodePath.join(worktree, ".specweave", "increments", "1497-ledger");
        // The full layer's session is a Claude one; a write needs the thread to run on it.
        const claude = ProviderInstanceId.make("claudeAgent");
        const shell = {
          ...liveThreadShell(ThreadId.make("thread-scratch")),
          providerInstanceId: claude,
          modelSelection: { instanceId: claude, model: "claude-opus-5-5" },
          worktreePath: worktree,
        };
        yield* serveFullLayer(shell, {
          bound: [
            {
              threadId: ThreadId.make("thread-scratch"),
              incrementId: "1497-ledger",
              binding: "manual",
              boundTaskId: null,
              title: null,
              status: "active",
              incrementPath: increment,
              specPath: null,
              readable: true,
              tasks: [],
              criteria: [],
              verify: null,
            },
          ],
        }).pipe(Effect.provideService(SpecweaveCommandOverride, cli));
        const claim = yield* callToolAsThread("specweave_task_claim", {
          increment: "1497",
          task: "T-04",
        });
        expect(claim.result?.isError, JSON.stringify(claim.result?.content)).toBeFalsy();
        expect(claim.result?.structuredContent).toMatchObject({
          changed: true,
          status: "claimed",
          agent: "claude@scratch",
          workspace: worktree,
        });
        const again = yield* callToolAsThread("specweave_task_claim", {
          increment: "1497",
          task: "T-04",
        });
        expect(again.result?.structuredContent).toMatchObject({ changed: false, command: null });
        const other = yield* callToolAsThread("specweave_task_release", {
          increment: "1497",
          task: "T-01",
        });
        expect(other.result?.isError).toBe(true);
        expect(JSON.stringify(other.result)).toContain("held by another agent");
        const outside = yield* callToolAsThread("specweave_task_block", {
          increment: "1483",
          task: "T-04",
          reason: "waiting",
        });
        expect(outside.result?.isError).toBe(true);
        expect(JSON.stringify(outside.result)).toContain("not 1483");
      }),
    ).pipe(Effect.provide(fullLayerTestServices)),
  60_000,
);

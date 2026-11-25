// @effect-diagnostics nodeBuiltinImport:off - Scratch worktree and a stand-in CLI.
/**
 * The SpecWeave tools run through the server's own MCP layer, not only a
 * hand-built one (1483). The test provides no ProcessRunner itself, so a
 * registration that forgets it fails here, as it did in 1.0.442.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  callToolAsThread,
  fullLayerTestServices,
  serveFullLayer,
} from "../../McpFullLayer.testkit.ts";
import { SpecweaveCommandOverride } from "./cli.ts";

const STAND_IN = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("next")) process.stdout.write(JSON.stringify({ argv, next: { id: "T-02" } }));
else process.stdout.write(JSON.stringify({ argv, tasks: [{ id: "T-01", status: "claimed", by: "codex@m5" }] }));
`;

const scratch = Effect.acquireRelease(
  Effect.sync(() => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-full-layer-")),
    );
    const worktree = NodePath.join(root, "worktree");
    NodeFS.mkdirSync(NodePath.join(worktree, ".specweave"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(worktree, ".specweave", "config.json"), "{}\n");
    const cli = NodePath.join(root, "specweave");
    NodeFS.writeFileSync(cli, STAND_IN, { mode: 0o755 });
    return { root, worktree, cli };
  }),
  ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
);

it.effect.skipIf(process.platform === "win32")(
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

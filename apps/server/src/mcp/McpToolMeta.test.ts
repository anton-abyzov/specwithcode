// @effect-diagnostics nodeBuiltinImport:off - A scratch worktree with a .specweave folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  fullLayerTestServices,
  listToolsAsThread,
  serveFullLayer,
} from "./McpFullLayer.testkit.ts";
import { ALWAYS_LOAD_KEY, ALWAYS_LOAD_TOOLS, toolMeta } from "./McpToolMeta.ts";

it("loads up front only the five measured core tools", () => {
  expect([...ALWAYS_LOAD_TOOLS].sort()).toEqual(
    ["advisor", "ask_user", "delegate_task", "request_secret", "studio_thread_send"].sort(),
  );
  expect(toolMeta("ask_user")).toEqual({ [ALWAYS_LOAD_KEY]: true });
  expect(toolMeta("studio_report_save")).toEqual({});
  expect(toolMeta("chrome_click")).toEqual({});
});

it.effect(
  "the real HTTP tools/list carries alwaysLoad on exactly that set and no other _meta key",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mcp-meta-"));
        NodeFS.mkdirSync(NodePath.join(workspace, ".specweave"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(workspace, { recursive: true, force: true })),
        );
        yield* serveFullLayer({
          projectId: "project-scratch",
          worktreePath: workspace,
          deletedAt: null,
        });
        const tools = yield* listToolsAsThread;

        // Every toolkit registers through registerToolkit; the image tools by hand.
        expect(tools.length).toBeGreaterThan(160);
        const loaded = tools
          .filter((tool) => tool._meta?.[ALWAYS_LOAD_KEY] === true)
          .map((tool) => tool.name)
          .sort();
        expect(loaded).toEqual([...ALWAYS_LOAD_TOOLS].sort());
        for (const tool of tools) {
          const keys = Object.keys(tool._meta ?? {}).filter((key) => key.startsWith("anthropic/"));
          expect(keys, tool.name).toEqual(
            ALWAYS_LOAD_TOOLS.has(tool.name) ? [ALWAYS_LOAD_KEY] : [],
          );
        }
        // In a SpecWeave worktree the two read-only SpecWeave tools are listed.
        expect(
          tools
            .map((tool) => tool.name)
            .filter((name) => name.startsWith("specweave_"))
            .sort(),
        ).toEqual(["specweave_next_task", "specweave_task_status"]);
      }),
    ).pipe(Effect.provide(fullLayerTestServices)),
);

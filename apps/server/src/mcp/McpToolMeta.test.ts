// @effect-diagnostics nodeBuiltinImport:off - A scratch workspace with a .specweave folder.
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
import {
  ALWAYS_LOAD_KEY,
  ALWAYS_LOAD_TOOLS,
  FALLBACK_SEARCH_HINT,
  SEARCH_HINT_KEY,
  toolMeta,
} from "./McpToolMeta.ts";

it("gives the six core tools alwaysLoad and every other tool a toolkit search hint", () => {
  expect([...ALWAYS_LOAD_TOOLS].sort()).toEqual(
    [
      "advisor",
      "ask_user",
      "delegate_task",
      "request_secret",
      "studio_report_save",
      "studio_thread_send",
    ].sort(),
  );
  expect(toolMeta("ask_user")).toEqual({ [ALWAYS_LOAD_KEY]: true });
  expect(toolMeta("chrome_click")).toEqual({
    [SEARCH_HINT_KEY]: "chrome: the user's signed-in Chrome",
  });
  expect(toolMeta("specweave_verify")[SEARCH_HINT_KEY]).toMatch(/^specweave: /);
  expect(toolMeta("not_a_tool")).toEqual({ [SEARCH_HINT_KEY]: FALLBACK_SEARCH_HINT });
});

it.effect("every tool in the real tools/list carries exactly one of the two _meta keys", () =>
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

      expect(tools.length).toBeGreaterThan(170);
      const names = tools.map((tool) => tool.name);
      for (const core of ALWAYS_LOAD_TOOLS) expect(names, core).toContain(core);
      for (const tool of tools) {
        const meta = tool._meta ?? {};
        const always = meta[ALWAYS_LOAD_KEY] === true;
        const hint = meta[SEARCH_HINT_KEY];
        expect(always !== (typeof hint === "string"), tool.name).toBe(true);
        expect(always, tool.name).toBe(ALWAYS_LOAD_TOOLS.has(tool.name));
        if (!always) {
          expect(hint, tool.name).not.toBe(FALLBACK_SEARCH_HINT);
          expect((hint as string).length, tool.name).toBeLessThanOrEqual(80);
        }
      }
      // Hand-registered image tools pass through the same wrapper.
      const snapshot = tools.find((tool) => tool.name === "preview_snapshot");
      expect(snapshot?._meta?.[SEARCH_HINT_KEY]).toMatch(/^preview: /);
      // In a SpecWeave workspace the four SpecWeave tools are listed.
      expect(names.filter((name) => name.startsWith("specweave_")).sort()).toEqual([
        "specweave_pickup",
        "specweave_task_done",
        "specweave_task_status",
        "specweave_verify",
      ]);
    }),
  ).pipe(Effect.provide(fullLayerTestServices)),
);

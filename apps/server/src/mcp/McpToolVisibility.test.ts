// @effect-diagnostics nodeBuiltinImport:off - Scratch workspaces with and without .specweave.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  fullLayerTestServices,
  listToolsAsThread,
  serveFullLayer,
} from "./McpFullLayer.testkit.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolVisibility from "./McpToolVisibility.ts";

const scratch = (withSpecweave: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-mcp-visibility-"));
      if (withSpecweave) NodeFS.mkdirSync(NodePath.join(folder, ".specweave"));
      return folder;
    }),
    (folder) => Effect.sync(() => NodeFS.rmSync(folder, { recursive: true, force: true })),
  );

const specweaveNames = (tools: ReadonlyArray<{ readonly name: string }>) =>
  tools.map((tool) => tool.name).filter((name) => name.startsWith("specweave_"));

it("drops only the hidden tools from a JSON or event-stream tools/list answer", () => {
  const answer = {
    jsonrpc: "2.0",
    id: 2,
    result: { tools: [{ name: "ask_user" }, { name: "specweave_task_status" }], nextCursor: "x" },
  };
  const hide = (name: unknown) => typeof name === "string" && name.startsWith("specweave_");
  expect(JSON.parse(McpToolVisibility.rewriteToolListBody(JSON.stringify(answer), hide)!)).toEqual({
    ...answer,
    result: { tools: [{ name: "ask_user" }], nextCursor: "x" },
  });
  const stream = `data: ${JSON.stringify(answer)}\n\n`;
  expect(McpToolVisibility.rewriteToolListBody(stream, hide)).toBe(
    `data: ${JSON.stringify({ ...answer, result: { tools: [{ name: "ask_user" }], nextCursor: "x" } })}\n\n`,
  );
  expect(McpToolVisibility.rewriteToolListBody("not json", hide)).toBeNull();
  // Not a list answer: unchanged.
  expect(
    McpToolVisibility.dropToolsFromListResult({ id: 3, result: { content: [] } }, hide),
  ).toEqual({
    id: 3,
    result: { content: [] },
  });
});

it.effect("a thread whose worktree holds .specweave/ is offered the SpecWeave tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* scratch(true);
      yield* serveFullLayer({ projectId: "p", worktreePath: workspace, deletedAt: null });
      expect(specweaveNames(yield* listToolsAsThread).sort()).toEqual([
        "specweave_next_task",
        "specweave_task_status",
      ]);
    }),
  ).pipe(Effect.provide(fullLayerTestServices)),
);

it.effect("a thread whose worktree has no .specweave/ is not", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* scratch(false);
      yield* serveFullLayer({ projectId: "p", worktreePath: workspace, deletedAt: null });
      const tools = yield* listToolsAsThread;
      expect(specweaveNames(tools)).toEqual([]);
      expect(tools.length).toBeGreaterThan(170);
    }),
  ).pipe(Effect.provide(fullLayerTestServices)),
);

it.effect("a recorded worktree that is missing hides them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workspace = yield* scratch(true);
      yield* serveFullLayer({
        projectId: "p",
        worktreePath: NodePath.join(workspace, "gone"),
        deletedAt: null,
      });
      expect(specweaveNames(yield* listToolsAsThread)).toEqual([]);
    }),
  ).pipe(Effect.provide(fullLayerTestServices)),
);

it.effect("a thread with no worktree of its own is not offered them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Its work happens in the project's shared folder, which the tools never read.
      yield* serveFullLayer({ projectId: "p", worktreePath: null, deletedAt: null });
      expect(specweaveNames(yield* listToolsAsThread)).toEqual([]);
    }),
  ).pipe(Effect.provide(fullLayerTestServices)),
);

it.effect("an unknown thread is not offered them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveFullLayer(null);
      expect(specweaveNames(yield* listToolsAsThread)).toEqual([]);
    }),
  ).pipe(Effect.provide(fullLayerTestServices)),
);

it.effect("an outside MCP client is never offered them", () =>
  Effect.gen(function* () {
    const filter = yield* McpToolVisibility.makeToolListFilter.pipe(
      Effect.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.die("an outside client has no thread to read"),
        }),
      ),
    );
    const client: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("e"),
      capabilities: new Set(["orchestration"] as const),
      issuedAt: 1,
      requestNamespace: "client",
      thread: undefined,
      client: { sessionId: "s", label: "outside", access: "full-access" },
    };
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/mcp", {
        method: "POST",
        body: `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
      }),
    );
    const answer = HttpServerResponse.text(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [{ name: "ask_user" }, { name: "specweave_next_task" }] },
      }),
      { contentType: "application/json" },
    );
    const filtered = yield* filter(request, client, answer);
    const body =
      filtered.body._tag === "Uint8Array" ? new TextDecoder().decode(filtered.body.body) : "";
    expect(JSON.parse(body).result.tools).toEqual([{ name: "ask_user" }]);
    expect(filtered.body._tag === "Uint8Array" && filtered.body.contentType).toBe(
      "application/json",
    );
  }),
);

// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- A stand-in specweave CLI, raw HTTP to watch the event stream, and process checks.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { liveThreadShell, noProjectsLayer } from "../../McpToolAccess.testkit.ts";
import { SPECWEAVE_VIEW_AGENT, SpecweaveCommandOverride } from "./cli.ts";
import * as SpecweaveHandlers from "./handlers.ts";
import { SpecweaveToolkit } from "./tools.ts";

const THREAD_TOKEN = "specweaveThreadTokenWithoutDots";
const CLIENT_TOKEN = "specweaveClientTokenWithoutDots";
const threadId = ThreadId.make("thread-specweave-tools");

const threadScope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment-specweave-tools"),
  requestNamespace: "provider-session-specweave",
  thread: {
    threadId,
    providerSessionId: "provider-session-specweave",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 1,
};
const clientScope: McpInvocationContext.McpInvocationScope = {
  ...threadScope,
  thread: undefined,
  client: { sessionId: "client", label: "outside agent", access: "full-access" },
};

/**
 * Prints its arguments, folder and agent as JSON. `task list` also lists one
 * claimed task; `task next` names T-02. `task list 2222` starts a child that
 * would sleep a minute, records both process ids, then waits.
 */
const STAND_IN = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const argv = process.argv.slice(2);
const base = { argv, cwd: process.cwd(), noColor: process.env.NO_COLOR, agent: process.env.SPECWEAVE_AGENT };
if (argv.includes("2222")) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  fs.writeFileSync(process.env.STAND_IN_PIDS, JSON.stringify([process.pid, child.pid]));
  setTimeout(() => {}, 60000);
} else if (argv.includes("next")) {
  process.stdout.write(JSON.stringify({ ...base, increment: "1483-x", next: { id: "T-02" } }));
} else {
  process.stdout.write(JSON.stringify({ ...base, tasks: [
    { id: "T-01", title: "one", status: "done", by: "codex@m5" },
    { id: "T-03", title: "three", status: "claimed", by: "claude@m5", since: "2026-11-25T00:00:00Z", evidence: "x" },
  ] }));
}
`;

interface Fixture {
  readonly workspace: string;
  readonly pids: string;
  readonly cli: string;
}

const makeFixture = Effect.acquireRelease(
  Effect.sync((): Fixture => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sw-tools-")),
    );
    const workspace = NodePath.join(root, "worktree");
    NodeFS.mkdirSync(NodePath.join(workspace, ".specweave"), { recursive: true });
    const cli = NodePath.join(root, "specweave");
    NodeFS.writeFileSync(cli, STAND_IN, { mode: 0o755 });
    const pids = NodePath.join(root, "pids.json");
    process.env.STAND_IN_PIDS = pids;
    return { workspace, pids, cli };
  }),
  (fixture) =>
    Effect.sync(() =>
      NodeFS.rmSync(NodePath.dirname(fixture.workspace), { recursive: true, force: true }),
    ),
);

const serve = (fixture: Fixture, shell: { readonly worktreePath?: string | null } = {}) =>
  Effect.gen(function* () {
    const serverLayer = McpHttpServer.toolkitRegistration(
      SpecweaveToolkit,
      SpecweaveHandlers.layer,
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerMcpTransport),
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (token) => Effect.succeed(token === THREAD_TOKEN ? threadScope : undefined),
        }),
      ),
      // An outside agent signs in through the client authenticator, as over OAuth.
      Layer.provide(
        Layer.mock(McpHttpServer.McpClientAuthenticator)({
          authenticate: (request) =>
            Effect.succeed(
              request.headers.authorization === `Bearer ${CLIENT_TOKEN}` ? clientScope : undefined,
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed({
              ...liveThreadShell(id),
              worktreePath:
                shell.worktreePath === undefined ? fixture.workspace : shell.worktreePath,
            }),
        }),
      ),
      Layer.provide(noProjectsLayer),
      Layer.provide(Layer.succeed(SpecweaveCommandOverride, fixture.cli)),
      Layer.provide(ProcessRunner.layer),
      Layer.provide(NodeServices.layer),
    );
    yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    const server = yield* HttpServer.HttpServer;
    return (server.address as { port: number }).port;
  });

interface Posted {
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly chunks: ReadonlyArray<{ readonly ms: number; readonly text: string }>;
}

const post = (
  port: number,
  headers: Record<string, string>,
  body: unknown,
  abortAfterMs?: number,
) =>
  Effect.promise(
    () =>
      new Promise<Posted>((resolve) => {
        const started = Date.now();
        const chunks: Array<{ ms: number; text: string }> = [];
        const request = NodeHttp.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...headers,
            },
          },
          (response) => {
            response.on("data", (chunk: Buffer) =>
              chunks.push({ ms: Date.now() - started, text: chunk.toString() }),
            );
            const done = () =>
              resolve({ status: response.statusCode ?? 0, headers: response.headers, chunks });
            response.on("end", done);
            response.on("error", done);
            response.on("close", done);
          },
        );
        request.on("error", () => resolve({ status: -1, headers: {}, chunks }));
        request.end(JSON.stringify(body));
        if (abortAfterMs !== undefined) setTimeout(() => request.destroy(), abortAfterMs);
      }),
  );

const session = (port: number, token: string) =>
  Effect.gen(function* () {
    const auth = { authorization: `Bearer ${token}` };
    const init = yield* post(port, auth, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
    const headers = {
      ...auth,
      "mcp-session-id": String(init.headers["mcp-session-id"]),
      "mcp-protocol-version": "2025-06-18",
    };
    yield* post(port, headers, { jsonrpc: "2.0", method: "notifications/initialized" });
    return headers;
  });

/** The JSON-RPC messages of an answer, whether JSON or an event stream. */
const messages = (posted: Posted) =>
  posted.chunks
    .map((chunk) => chunk.text)
    .join("")
    .split("\n")
    .map((line) => line.replace(/^data: /, "").trim())
    .filter((line) => line.startsWith("{"))
    .map(
      (line) =>
        JSON.parse(line) as { method?: string; params?: { message?: string }; result?: any },
    );

const call = (
  port: number,
  headers: Record<string, string>,
  name: string,
  args: unknown,
  meta?: unknown,
) =>
  post(port, headers, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
  }).pipe(
    Effect.map((posted) => ({ posted, result: messages(posted).find((m) => m.result)?.result })),
  );

/** Each test gets its own HTTP server on a free port. */
const withServer = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.scoped(body).pipe(
    Effect.provide(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
  );

it.live(
  "task status runs task list in the thread's worktree with --workspace and parses its JSON",
  () =>
    withServer(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const port = yield* serve(fixture);
        const headers = yield* session(port, THREAD_TOKEN);
        const { result } = yield* call(port, headers, "specweave_task_status", {
          increment: "1483",
        });
        expect(result.isError).toBeFalsy();
        const run = result.structuredContent;
        expect(run).toMatchObject({ ok: true, exitCode: 0, workspace: fixture.workspace });
        expect(run.data).toMatchObject({
          argv: ["--workspace", fixture.workspace, "task", "list", "1483", "--json"],
          cwd: fixture.workspace,
          noColor: "1",
          agent: SPECWEAVE_VIEW_AGENT,
        });
      }),
    ),
);

it.live("next task runs task next, read-only, and lists the live claims beside it", () =>
  withServer(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const port = yield* serve(fixture);
      const headers = yield* session(port, THREAD_TOKEN);
      const { result } = yield* call(port, headers, "specweave_next_task", {
        increment: "1483-some-title",
      });
      expect(result.isError).toBeFalsy();
      const data = result.structuredContent.data;
      expect(data.argv).toEqual([
        "--workspace",
        fixture.workspace,
        "task",
        "next",
        "1483-some-title",
        "--json",
      ]);
      expect(data.next).toEqual({ id: "T-02" });
      expect(data.liveClaims).toEqual([
        {
          id: "T-03",
          title: "three",
          status: "claimed",
          by: "claude@m5",
          since: "2026-11-25T00:00:00Z",
        },
      ]);
      // Nothing from the caller but the checked increment reaches the CLI.
      const invalid = yield* call(port, headers, "specweave_next_task", {
        increment: "1483 --force",
      });
      expect(invalid.result?.isError ?? true).toBe(true);
    }),
  ),
);

it.live("refuses a folder outside the worktree and an outside client", () =>
  withServer(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const port = yield* serve(fixture);
      const headers = yield* session(port, THREAD_TOKEN);
      for (const name of ["specweave_task_status", "specweave_next_task"]) {
        const outside = yield* call(port, headers, name, { increment: "1483", folder: ".." });
        expect(outside.result.isError, name).toBe(true);
        expect(JSON.stringify(outside.result)).toContain(
          "not a folder inside this thread's worktree",
        );
      }

      const clientHeaders = yield* session(port, CLIENT_TOKEN);
      const client = yield* call(port, clientHeaders, "specweave_task_status", {
        increment: "1483",
      });
      expect(client.result.isError).toBe(true);
      expect(JSON.stringify(client.result)).toContain("SpecWithCode thread");
    }),
  ),
);

it.live.each([
  { label: "a missing worktree", worktreePath: "gone", expected: "missing on this machine" },
  { label: "no worktree at all", worktreePath: null, expected: "registered worktree" },
])("$label is refused, never swapped for the project folder", ({ worktreePath, expected }) =>
  withServer(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const port = yield* serve(fixture, {
        worktreePath: worktreePath === null ? null : NodePath.join(fixture.workspace, worktreePath),
      });
      const headers = yield* session(port, THREAD_TOKEN);
      const { result } = yield* call(port, headers, "specweave_task_status", { increment: "1483" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(expected);
    }),
  ),
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.live(
  "a dropped call stops the CLI and the processes it started",
  () =>
    withServer(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const port = yield* serve(fixture);
        const headers = yield* session(port, THREAD_TOKEN);
        yield* post(
          port,
          headers,
          {
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: { name: "specweave_task_status", arguments: { increment: "2222" } },
          },
          1_500,
        );
        const pids = JSON.parse(NodeFS.readFileSync(fixture.pids, "utf8")) as Array<number>;
        expect(pids).toHaveLength(2);
        let stopped = false;
        for (let attempt = 0; attempt < 50 && !stopped; attempt++) {
          stopped = pids.every((pid) => !alive(pid));
          if (!stopped) yield* Effect.sleep("100 millis");
        }
        expect(stopped).toBe(true);
      }),
    ),
  15_000,
);

import { ThreadId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as BoundedThreadSnapshotHttp from "./boundedThreadSnapshotHttp.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: "environment-bounded" as never,
  label: "Bounded",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const THREAD_ID = ThreadId.make("thread-bounded");
const NOW = "2026-06-20T00:00:00.000Z";

const FULL_SNAPSHOT_BODY = {
  snapshotSequence: 9,
  projection: {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: String(THREAD_ID),
      projectId: "project-1",
      title: "Full fallback thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: String(THREAD_ID),
      },
      forkedFrom: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  },
};

const turnItem = (id: string, ordinal: number, fields: Record<string, unknown>) => ({
  id,
  threadId: String(THREAD_ID),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed",
  title: null,
  startedAt: NOW,
  completedAt: NOW,
  updatedAt: NOW,
  ...fields,
});
const projectedRow = (item: ReturnType<typeof turnItem>, position: number) => ({
  position,
  visibility: "local",
  sourceThreadId: String(THREAD_ID),
  sourceItemId: item.id,
  item,
});

describe("boundedThreadSnapshotLoader", () => {
  it.effect("places a window turn start at the head and keeps its key for paging", () => {
    const prompt = turnItem("item-prompt", 1, {
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      messageId: "message-prompt",
      inputIntent: "turn_start",
      text: "Run the audit",
      attachments: [],
    });
    const step = turnItem("item-4000", 4000, {
      type: "command_execution",
      input: "rg audit",
      output: "",
      exitCode: 0,
    });
    const body = {
      ...FULL_SNAPSHOT_BODY,
      projection: {
        ...FULL_SNAPSHOT_BODY.projection,
        turnItems: [step],
        visibleTurnItems: [projectedRow(step, 0)],
      },
      historyCursor: "older-page",
      hasMoreHistory: true,
      latestLocalTurnOrdinal: 4000,
      windowTurnStart: projectedRow(prompt, 0),
    };
    const urls: string[] = [];
    const fetchFn = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID, { boundLongTurns: true });
      // Only a client that can show earlier steps below the prompt asks for it.
      expect(new URL(urls[0]!).searchParams.get("boundLongTurns")).toBe("1");
      yield* loader.load(PREPARED, THREAD_ID);
      expect(new URL(urls[1]!).searchParams.has("boundLongTurns")).toBe(false);
      expect(result._tag).toBe("present");
      if (result._tag !== "present") return;
      const projection = result.snapshot.projection;
      expect(projection.visibleTurnItems.map((row) => [row.position, row.sourceItemId])).toEqual([
        [0, "item-prompt"],
        [1, "item-4000"],
      ]);
      expect(projection.turnItems.map((item) => item.id)).toEqual(["item-prompt", "item-4000"]);
      expect(result.history).toEqual({
        historyCursor: "older-page",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 4000,
        windowTurnStartKey: `${THREAD_ID}:item-prompt`,
      });
    }).pipe(
      Effect.provide(
        Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });

  it.effect("falls back to full HTTP snapshot when bounded returns a plain route 404", () => {
    const fetchFn = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/orchestration/threads/${THREAD_ID}/bounded`)) {
        // Generic HTML/route 404: not a structured thread_not_found payload.
        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      expect(url).toContain(`/api/orchestration/threads/${THREAD_ID}`);
      expect(url.includes("/bounded")).toBe(false);
      return Promise.resolve(
        new Response(JSON.stringify(FULL_SNAPSHOT_BODY), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID);
      expect(result._tag).toBe("present");
      if (result._tag === "present") {
        expect(result.snapshot.snapshotSequence).toBe(9);
        expect(result.snapshot.projection.thread.title).toBe("Full fallback thread");
        expect(result.history).toBeUndefined();
      }
    }).pipe(
      Effect.provide(
        Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });

  it.effect("treats structured EnvironmentResourceNotFoundError from bounded as missing", () => {
    const fetchFn = ((input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain(`/api/orchestration/threads/${THREAD_ID}/bounded`);
      return Promise.resolve(
        Response.json(
          {
            _tag: "EnvironmentResourceNotFoundError",
            code: "not_found",
            reason: "thread_not_found",
            traceId: "trace-bounded-missing",
          },
          { status: 404 },
        ),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID);
      expect(result).toEqual({ _tag: "missing" });
    }).pipe(
      Effect.provide(
        Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });

  it.effect("treats structured missing from full fallback as missing", () => {
    let fullCalls = 0;
    const fetchFn = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/bounded")) {
        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      fullCalls += 1;
      return Promise.resolve(
        Response.json(
          {
            _tag: "EnvironmentResourceNotFoundError",
            code: "not_found",
            reason: "thread_not_found",
            traceId: "trace-full-missing",
          },
          { status: 404 },
        ),
      );
    }) satisfies typeof fetch;

    return Effect.gen(function* () {
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
      const result = yield* loader.load(PREPARED, THREAD_ID);
      expect(result).toEqual({ _tag: "missing" });
      expect(fullCalls).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
      ),
    );
  });

  it.effect(
    "uses socket fallback directly when the bounded endpoint has a transient failure",
    () => {
      let fullCalls = 0;
      const fetchFn = ((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/bounded")) {
          return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
        }
        fullCalls += 1;
        return Promise.resolve(
          new Response(JSON.stringify(FULL_SNAPSHOT_BODY), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) satisfies typeof fetch;

      return Effect.gen(function* () {
        const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
        const result = yield* loader.load(PREPARED, THREAD_ID);
        expect(result).toEqual({ _tag: "unavailable" });
        expect(fullCalls).toBe(0);
      }).pipe(
        Effect.provide(
          Layer.provide(BoundedThreadSnapshotHttp.layer, RpcHttp.layerRemoteHttpClient(fetchFn)),
        ),
      );
    },
  );
});

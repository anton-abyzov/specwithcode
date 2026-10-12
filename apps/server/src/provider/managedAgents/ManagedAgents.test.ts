import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as ManagedAgents from "./ManagedAgents.ts";
import {
  buildManagedAgentsSystem,
  MANAGED_AGENTS_BETA,
  parseManagedAgentsConfig,
} from "./config.ts";
import {
  createManagedSseDecoder,
  emptyManagedWorkflowState,
  reduceManagedWorkflowEvent,
} from "./state.ts";

const config = parseManagedAgentsConfig({
  enabled: true,
  environmentId: "env_test",
  model: "claude-sonnet-5",
  maxCostCents: "100",
  timeoutSeconds: 180,
});
const create = {
  type: "workflow_run.created",
  workflow_run_id: "wrun_test",
  name: "Test",
  phases: [{ id: "phase_test", name: "Parallel checks" }],
};
const end = {
  type: "workflow_run.status_ended",
  workflow_run_id: "wrun_test",
  result: { type: "completed" },
};
const idle = { type: "session.status_idle", stop_reason: { type: "end_turn" } };
const message = {
  type: "agent.message",
  content: [{ type: "text", text: "GLOBAL_MARKER PROJECT_MARKER" }],
};
const report = {
  type: "agent.custom_tool_use",
  id: "sevt_report",
  session_thread_id: "sthr_worker",
  name: "studio_report_result",
  input: { text: "GLOBAL_MARKER PROJECT_MARKER independent answer" },
};
const sse = (events: readonly unknown[]) =>
  events.map((event) => `event: event\ndata: ${JSON.stringify(event)}\n\n`).join("");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function harness(
  input: {
    key?: boolean;
    events?: readonly unknown[];
    rejectLead?: boolean;
    rejectArchive?: boolean;
    unfunded?: boolean;
    cleanupRunning?: boolean;
    threadInventory?: unknown;
    threadEvents?: unknown;
    primaryOnly?: boolean;
  } = {},
) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  let agents = 0;
  let sessionReads = 0;
  const http = HttpClient.make((request) => {
    requests.push(request);
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/v1/agents") {
      agents++;
      response = input.unfunded
        ? json(
            {
              error: {
                type: "invalid_request_error",
                message: "Your credit balance is too low to access the Anthropic API.",
              },
            },
            400,
          )
        : input.rejectLead && agents === 2
          ? json({}, 403)
          : json({ id: agents === 1 ? "agent_worker" : "agent_lead", version: 1 });
    } else if (url.pathname === "/v1/sessions") response = json({ id: "sesn_test" });
    else if (url.pathname.endsWith("/events/stream"))
      response = new Response(
        sse(
          input.events ?? [
            create,
            {
              type: "workflow_run.phase_started",
              workflow_run_id: "wrun_test",
              workflow_run_phase_id: "phase_test",
            },
            message,
            report,
            {
              type: "workflow_run.phase_ended",
              workflow_run_id: "wrun_test",
              workflow_run_phase_id: "phase_test",
            },
            end,
            idle,
          ],
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    else if (url.pathname.endsWith("/archive"))
      response = json({}, input.rejectArchive ? 500 : 200);
    else if (request.method === "GET" && url.pathname === "/v1/sessions/sesn_test/events")
      response = json({ data: [create, { ...end, result: { type: "stopped" } }], next_page: null });
    else if (url.pathname.endsWith("/threads"))
      response = json(
        input.threadInventory ?? {
          data: [
            {
              id: "sthr_worker",
              workflow_run_id: input.primaryOnly ? null : "wrun_test",
              agent: { id: "agent_worker", system: body(requests[0]!).system },
            },
          ],
          next_page: null,
        },
      );
    else if (url.pathname.endsWith("/threads/sthr_worker/events"))
      response = json(input.threadEvents ?? { data: [message], next_page: null });
    else if (url.pathname === "/v1/sessions/sesn_test") {
      sessionReads++;
      response = json({
        status: input.cleanupRunning && sessionReads <= 2 ? "running" : "idle",
        usage: { list_cost: { amount: "4", currency: "USD" } },
      });
    } else response = json({});
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = ManagedAgents.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(ManagedAgents.ManagedAgentsCredentials, {
          apiKey: input.key === false ? undefined : Redacted.make("offline-test-key"),
        }),
      ),
    ),
  );
  return { layer, requests };
}
const task = {
  config,
  betaOptIn: true,
  prompt: "Use a workflow for two arithmetic checks.",
  sharedInstructions: "GLOBAL_MARKER\nPROJECT_MARKER",
};
const body = (request: HttpClientRequest.HttpClientRequest) => {
  if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body");
  return JSON.parse(new TextDecoder().decode(request.body.body));
};

describe("Managed Agents beta service", () => {
  it.effect(
    "uses API auth, pinned predefined workers, bounded sessions, stream-first dispatch and exact cleanup",
    () => {
      const { layer, requests } = harness();
      return Effect.gen(function* () {
        const receipt = yield* (yield* ManagedAgents.ManagedAgents).run(task);
        expect(receipt.executionComplete).toBe(true);
        expect(receipt.verified).toBe(false);
        expect(receipt.state.runs[0]?.phases[0]?.status).toBe("ended");
        expect(receipt.threadEvidence[0]?.messages).toEqual(["GLOBAL_MARKER PROJECT_MARKER"]);
        expect(receipt.threadEvidence[0]?.reportMessages).toEqual([
          "GLOBAL_MARKER PROJECT_MARKER independent answer",
        ]);
        expect(receipt.threadEvidence[0]?.instructionsMatch).toBe(true);
        expect(receipt.cleanupFailures).toEqual([]);
        const creates = requests.filter((request) => request.url.endsWith("/v1/agents"));
        const worker = body(creates[0]!);
        const lead = body(creates[1]!);
        expect(worker.system).toContain("GLOBAL_MARKER");
        expect(worker.system).toContain("PROJECT_MARKER");
        expect(lead.system).toContain(worker.system);
        expect(worker.system).toContain("headless: true");
        expect(lead.multiagent).toEqual({
          type: "multiagent_20261001",
          subagents: { type: "disabled" },
          workflows: {
            type: "enabled",
            inline_agents: { type: "disabled" },
            predefined_agents: [{ type: "agent", id: "agent_worker", version: 1 }],
          },
        });
        const session = body(requests.find((request) => request.url.endsWith("/v1/sessions"))!);
        expect(session.budget.max_list_cost).toEqual({ amount: "100", currency: "USD" });
        expect(session.resources).toBeUndefined();
        expect(requests[0]!.headers["anthropic-beta"]).toBe(MANAGED_AGENTS_BETA);
        expect(requests[0]!.headers["x-api-key"]).toBe("offline-test-key");
        expect(
          requests.findIndex((request) => request.url.endsWith("/events/stream")),
        ).toBeLessThan(requests.findIndex((request) => request.url.endsWith("/events")));
        expect(
          requests
            .filter((request) => request.url.endsWith("/archive"))
            .map((request) => new URL(request.url).pathname),
        ).toEqual([
          "/v1/sessions/sesn_test/archive",
          "/v1/agents/agent_lead/archive",
          "/v1/agents/agent_worker/archive",
        ]);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("sends the configured response style to the lead and every worker", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      yield* (yield* ManagedAgents.ManagedAgents).run({
        ...task,
        config: parseManagedAgentsConfig({ ...config, responseStyle: "detailed" }),
      });
      const creates = requests.filter((request) => request.url.endsWith("/v1/agents"));
      const worker = body(creates[0]!);
      expect(worker.system).toContain('<response_style mode="detailed">');
      expect(worker.system).not.toContain('<response_style mode="concise">');
      expect(body(creates[1]!).system).toContain(worker.system);
    }).pipe(Effect.provide(layer));
  });
  it.effect("refuses absent API authentication without touching subscription accounts", () => {
    const { layer, requests } = harness({ key: false });
    return Effect.gen(function* () {
      const service = yield* ManagedAgents.ManagedAgents;
      expect((yield* service.status(config)).reason).toBe("api_key_missing");
      const result = yield* service.run(task).pipe(Effect.flip);
      expect(result._tag).toBe("ManagedAgentsUnavailableError");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
  it.effect(
    "marks missing, nonarray and empty thread inventories incomplete despite a completed run",
    () => {
      return Effect.gen(function* () {
        for (const threadInventory of [{}, { data: {} }, { data: [] }]) {
          const { layer } = harness({ threadInventory });
          const receipt = yield* Effect.gen(function* () {
            return yield* (yield* ManagedAgents.ManagedAgents).run(task);
          }).pipe(Effect.provide(layer));
          expect(receipt.executionComplete).toBe(true);
          expect(receipt.evidenceComplete).toBe(false);
          expect(receipt.threadEvidence).toHaveLength(0);
        }
      });
    },
  );
  it.effect("marks malformed or empty worker event pages incomplete", () => {
    return Effect.gen(function* () {
      for (const threadEvents of [{}, { data: {} }, { data: [] }, { data: [{}] }]) {
        const { layer } = harness({ threadEvents });
        const receipt = yield* Effect.gen(function* () {
          return yield* (yield* ManagedAgents.ManagedAgents).run(task);
        }).pipe(Effect.provide(layer));
        expect(receipt.executionComplete).toBe(true);
        expect(receipt.evidenceComplete).toBe(false);
      }
    });
  });
  it.effect("requires an independently listed run worker and its direct report", () => {
    return Effect.gen(function* () {
      const primary = harness({ primaryOnly: true });
      const primaryReceipt = yield* Effect.gen(function* () {
        return yield* (yield* ManagedAgents.ManagedAgents).run(task);
      }).pipe(Effect.provide(primary.layer));
      expect(primaryReceipt.evidenceComplete).toBe(false);
      const unreported = harness({ events: [create, message, end, idle] });
      const unreportedReceipt = yield* Effect.gen(function* () {
        return yield* (yield* ManagedAgents.ManagedAgents).run(task);
      }).pipe(Effect.provide(unreported.layer));
      expect(unreportedReceipt.evidenceComplete).toBe(false);
    });
  });
  it.effect("stops open workflows and waits for idle before archiving an active session", () => {
    const { layer, requests } = harness({
      cleanupRunning: true,
      events: [create, { type: "session.status_idle", stop_reason: { type: "budget_reached" } }],
    });
    return Effect.gen(function* () {
      const receipt = yield* (yield* ManagedAgents.ManagedAgents).run(task);
      expect(receipt.executionComplete).toBe(false);
      expect(receipt.cleanupFailures).toEqual([]);
      const sends = requests
        .filter(
          (request) =>
            request.method === "POST" &&
            new URL(request.url).pathname === "/v1/sessions/sesn_test/events",
        )
        .map(body);
      expect(sends.some((value) => value.events[0].type === "user.interrupt")).toBe(true);
      expect(
        sends.some((value) =>
          value.events[0].content?.[0]?.text.includes("Stop every open workflow"),
        ),
      ).toBe(true);
      expect(requests.filter((request) => request.url.endsWith("/archive"))).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });
  it.effect(
    "archives a budget-paused idle session without raising its cap or sending a rejected stop message",
    () => {
      const { layer, requests } = harness({
        events: [create, { type: "session.status_idle", stop_reason: { type: "budget_reached" } }],
      });
      return Effect.gen(function* () {
        const receipt = yield* (yield* ManagedAgents.ManagedAgents).run(task);
        expect(receipt.state.status).toBe("budget_reached");
        expect(receipt.executionComplete).toBe(false);
        expect(receipt.cleanupFailures).toEqual([]);
        expect(
          requests.filter(
            (request) =>
              request.method === "POST" &&
              new URL(request.url).pathname === "/v1/sessions/sesn_test/events",
          ),
        ).toHaveLength(1);
        expect(
          requests.some(
            (request) => request.method === "POST" && request.url.endsWith("/sessions/sesn_test"),
          ),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect(
    "records exact session cleanup failure when the beta API refuses a budget-paused archive",
    () => {
      const { layer } = harness({
        rejectArchive: true,
        events: [create, { type: "session.status_idle", stop_reason: { type: "budget_reached" } }],
      });
      return Effect.gen(function* () {
        const receipt = yield* (yield* ManagedAgents.ManagedAgents).run(task);
        expect(receipt.cleanupFailures).toContain("sessions/sesn_test");
        expect(receipt.executionComplete).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );
  it.effect("requires beta opt-in before making a cloud mutation", () => {
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      const error = yield* (yield* ManagedAgents.ManagedAgents)
        .run({ ...task, betaOptIn: false })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ManagedAgentsUnavailableError");
      expect(requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
  it.effect("reports insufficient API credit with a safe billing error", () => {
    const { layer, requests } = harness({ unfunded: true });
    return Effect.gen(function* () {
      const error = yield* (yield* ManagedAgents.ManagedAgents).run(task).pipe(Effect.flip);
      expect(error._tag).toBe("ManagedAgentsRequestError");
      expect(error.message).toContain("funded Anthropic API account");
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
  it.effect("archives a worker when creating the lead fails", () => {
    const { layer, requests } = harness({ rejectLead: true });
    return Effect.gen(function* () {
      const error = yield* (yield* ManagedAgents.ManagedAgents).run(task).pipe(Effect.flip);
      expect(error._tag).toBe("ManagedAgentsRequestError");
      expect(requests.at(-1)?.url).toContain("/agents/agent_worker/archive");
    }).pipe(Effect.provide(layer));
  });
  it.effect("reports cleanup failures without exposing API error bodies", () => {
    const { layer } = harness({ rejectArchive: true });
    return Effect.gen(function* () {
      const receipt = yield* (yield* ManagedAgents.ManagedAgents).run(task);
      expect(receipt.cleanupFailures).toEqual([
        "sessions/sesn_test",
        "agents/agent_lead",
        "agents/agent_worker",
      ]);
    }).pipe(Effect.provide(layer));
  });
  it.effect("does not claim workflow execution when the lead only answered directly", () => {
    const { layer } = harness({ events: [message, idle] });
    return Effect.gen(function* () {
      const receipt = yield* (yield* ManagedAgents.ManagedAgents).run(task);
      expect(receipt.executionComplete).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});

describe("workflow event semantics", () => {
  it("ignores the new session's initial idle status before task activity", () => {
    expect(reduceManagedWorkflowEvent(emptyManagedWorkflowState(), idle).status).toBe("running");
  });
  it("waits through primary end_turn while a run is still open", () => {
    let state = reduceManagedWorkflowEvent(emptyManagedWorkflowState(), create);
    state = reduceManagedWorkflowEvent(state, idle);
    expect(state.status).toBe("running");
    state = reduceManagedWorkflowEvent(state, end);
    expect(state.status).toBe("running");
    state = reduceManagedWorkflowEvent(state, idle);
    expect(state.status).toBe("completed");
  });
  it("distinguishes budget and permission waits from completion", () => {
    const state = reduceManagedWorkflowEvent(emptyManagedWorkflowState(), create);
    expect(
      reduceManagedWorkflowEvent(state, {
        type: "session.status_idle",
        stop_reason: { type: "budget_reached" },
      }).status,
    ).toBe("budget_reached");
    expect(
      reduceManagedWorkflowEvent(state, {
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      }).status,
    ).toBe("requires_action");
  });
  it("handles unknown phases and ignores start errors until the run has ended", () => {
    let state = reduceManagedWorkflowEvent(emptyManagedWorkflowState(), create);
    state = reduceManagedWorkflowEvent(state, {
      type: "workflow_run.error",
      workflow_run_id: "wrun_test",
      error: { type: "program_error" },
    });
    expect(state.status).toBe("running");
    state = reduceManagedWorkflowEvent(state, {
      type: "workflow_run.phase_ended",
      workflow_run_id: "wrun_test",
      workflow_run_phase_id: "unlisted",
    });
    expect(state.runs[0]?.phases.at(-1)?.status).toBe("ended");
  });
  it("decodes SSE split across chunks without losing CRLF or multiline data", () => {
    const decode = createManagedSseDecoder();
    expect(decode('data: {"type":\r')).toEqual([]);
    expect(
      decode('\ndata: "session.status_idle", "stop_reason":{"type":"end_turn"}}\r\n\r'),
    ).toEqual([]);
    expect(decode("\n")).toEqual([idle]);
  });
  it("rejects decimal cents and missing/invalid environment settings", () => {
    expect(() => parseManagedAgentsConfig({ ...config, maxCostCents: "1.00" })).toThrow(
      "maxCostCents",
    );
    expect(() => parseManagedAgentsConfig({ ...config, environmentId: "" })).toThrow(
      "environmentId",
    );
    expect(() => parseManagedAgentsConfig({ ...config, timeoutSeconds: 0 })).toThrow(
      "timeoutSeconds",
    );
    expect(() => parseManagedAgentsConfig({ ...config, responseStyle: "short" })).toThrow();
  });
  it("writes concisely by default, follows a configured style and keeps report answers whole", () => {
    expect(config.responseStyle).toBeUndefined();
    const concise = buildManagedAgentsSystem("", config.responseStyle);
    expect(concise).toContain('<response_style mode="concise">');
    expect(concise).toContain("the response style's 5-line cap does not apply to this answer");
    const detailedConfig = parseManagedAgentsConfig({ ...config, responseStyle: "detailed" });
    const detailed = buildManagedAgentsSystem("", detailedConfig.responseStyle);
    expect(detailed).toContain('<response_style mode="detailed">');
    expect(detailed).not.toContain('<response_style mode="concise">');
  });
});

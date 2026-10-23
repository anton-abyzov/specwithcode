import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OrchestrationV2SubagentJson } from "./orchestrationV2.ts";
import { OrchestratorMcpDelegateTaskInput } from "./orchestratorMcp.ts";
import { ProjectSettingsOverrides, ServerSettings, ServerSettingsPatch } from "./settings.ts";
import { DEFAULT_TASK_ROUTING_SETTINGS, TaskRoutingDecision } from "./taskRouting.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);

const decision = {
  taskClass: "translation",
  confidence: "high",
  moved: true,
  tier: "standard",
  selection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
  baseline: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  escalation: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  billing: "subscription",
  reason: "Translation fits Standard: Claude Sonnet 5.5 instead of Claude Opus 5.5.",
  signals: ["translate"],
  decidedAt: "2026-10-20T20:00:00.000Z",
};

describe("taskRouting setting", () => {
  it("is off by default and older settings files decode", () => {
    expect(decodeServerSettings({}).taskRouting).toEqual(DEFAULT_TASK_ROUTING_SETTINGS);
  });

  it("persists a policy through encode and decode", () => {
    const saved = decodeServerSettings({
      taskRouting: {
        mode: "auto",
        quality: "economy",
        classTiers: { translation: "economy" },
        minimumTier: "standard",
        excludedProviders: ["copilot-0889"],
        paidApi: "never",
        escalate: false,
      },
    });
    const reloaded = decodeServerSettings(encodeServerSettings(saved));
    expect(reloaded.taskRouting).toEqual({
      mode: "auto",
      quality: "economy",
      classTiers: { translation: "economy" },
      minimumTier: "standard",
      excludedProviders: ["copilot-0889"],
      paidApi: "never",
      escalate: false,
    });
  });

  it("fills a partial policy with defaults and rejects unknown tiers", () => {
    expect(decodeServerSettings({ taskRouting: { mode: "auto" } }).taskRouting).toEqual({
      ...DEFAULT_TASK_ROUTING_SETTINGS,
      mode: "auto",
    });
    expect(() => decodeServerSettings({ taskRouting: { minimumTier: "cheapest" } })).toThrow();
  });

  it("can be overridden per project and patched", () => {
    expect(
      Schema.decodeUnknownSync(ProjectSettingsOverrides)({ taskRouting: { mode: "off" } })
        .taskRouting?.mode,
    ).toBe("off");
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({ taskRouting: { mode: "auto" } }).taskRouting
        ?.mode,
    ).toBe("auto");
  });
});

describe("routing records", () => {
  it("keeps billing readable by older clients and decodes a newer one as unknown", () => {
    const decode = Schema.decodeUnknownSync(TaskRoutingDecision);
    const routed = decode({ ...decision, billing: "api", modelBilling: "paid-router" });
    expect([routed.billing, routed.modelBilling]).toEqual(["api", "paid-router"]);
    expect(Schema.encodeSync(TaskRoutingDecision)(routed)).toMatchObject({
      billing: "api",
      modelBilling: "paid-router",
    });
    const future = decode({ ...decision, billing: "credits", modelBilling: "credits" });
    expect(future.billing).toBe("unknown");
    expect(future.modelBilling).toBeUndefined();
    expect(decode(decision).modelBilling).toBeUndefined();
  });

  it("decodes a decision and a delegated task with or without one", () => {
    expect(Schema.decodeUnknownSync(TaskRoutingDecision)(decision).selection.model).toBe(
      "claude-sonnet-5-5",
    );
    const task = {
      id: "node:1",
      threadId: "thread:1",
      runId: null,
      parentNodeId: "node:0",
      origin: "app_owned",
      createdBy: "agent",
      driver: "claudeAgent",
      providerInstanceId: "claudeAgent",
      providerThreadId: null,
      childThreadId: "thread:2",
      nativeTaskRef: null,
      prompt: "Translate",
      title: null,
      model: "claude-sonnet-5-5",
      status: "running",
      result: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-10-20T20:00:00.000Z",
    };
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationV2SubagentJson));
    expect(decode(JSON.stringify(task)).routing).toBeUndefined();
    expect(decode(JSON.stringify({ ...task, routing: decision })).routing?.taskClass).toBe(
      "translation",
    );
  });

  it("accepts a task class hint on delegate_task and rejects an unknown one", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
    expect(decode({ task: "Translate the emails", taskClass: "translation" }).taskClass).toBe(
      "translation",
    );
    expect(() => decode({ task: "Translate", taskClass: "cheap" })).toThrow();
  });
});

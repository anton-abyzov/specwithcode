import { DEFAULT_SERVER_SETTINGS, type ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeUsagePausesUltracodeDefault,
  effectiveClaudeUltracodeDefault,
  effectiveClaudeWorkflowMode,
  resolveUltracode,
  resolveUltracodeDefault,
  ultracodeChatKind,
  ultracodeDefaultForChat,
} from "./ultracodeDefault.ts";

const project = { id: "p1" };
const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const LATER = "2026-11-14T15:00:00.000Z";
const EARLIER = "2026-11-14T09:00:00.000Z";

const claude = (
  overrides: {
    readonly auth?: Partial<ServerProvider["auth"]>;
    readonly windows?: ReadonlyArray<Record<string, unknown>>;
  } = {},
) =>
  ({
    driver: "claudeAgent",
    auth: { status: "authenticated", ...overrides.auth },
    ...(overrides.windows ? { usageLimits: { windows: overrides.windows } } : {}),
  }) as unknown as ServerProvider;

const window = (kind: string, usedPercent: number, extra: Record<string, unknown> = {}) => ({
  id: kind === "session" ? "five_hour" : "seven_day",
  label: kind,
  kind,
  usedPercent,
  resetsAt: LATER,
  ...extra,
});

const base = {
  workflowMode: "on-request",
  ultracodeDefault: "threads",
  chatKind: "thread",
  apiKeyBilling: false,
  usagePaused: false,
} as const;

describe("the default setting", () => {
  it("ships on for threads", () => {
    expect(DEFAULT_SERVER_SETTINGS.claudeUltracodeDefault).toBe("threads");
    expect(DEFAULT_SERVER_SETTINGS.claudeWorkflowMode).toBe("on-request");
  });

  it("reads a stored Automatic mode as On request plus every chat", () => {
    expect(effectiveClaudeWorkflowMode("automatic")).toBe("on-request");
    expect(effectiveClaudeWorkflowMode("disabled")).toBe("disabled");
    expect(effectiveClaudeWorkflowMode(undefined)).toBe("on-request");
    expect(effectiveClaudeUltracodeDefault("automatic", "off")).toBe("all");
    expect(effectiveClaudeUltracodeDefault("automatic", undefined)).toBe("all");
    expect(effectiveClaudeUltracodeDefault("on-request", "off")).toBe("off");
    expect(effectiveClaudeUltracodeDefault("on-request", undefined)).toBe("threads");
  });
});

describe("ultracodeChatKind", () => {
  it("treats a chat a person starts in a project as a thread", () => {
    expect(ultracodeChatKind({ threadId: "t1", project, lineage: null, routine: false })).toBe(
      "thread",
    );
    expect(
      ultracodeChatKind({
        threadId: "t1",
        project,
        lineage: { parentThreadId: "t0", relationshipToParent: "fork" },
        routine: false,
      }),
    ).toBe("thread");
  });

  it("names the project coordinator, by its default id or the saved one", () => {
    expect(ultracodeChatKind({ threadId: "project-coordinator:p1", project, routine: false })).toBe(
      "coordinator",
    );
    expect(
      ultracodeChatKind({
        threadId: "custom",
        project: { id: "p1", workspaceSettings: { coordinatorThreadId: "custom" } },
        routine: false,
      }),
    ).toBe("coordinator");
  });

  it("counts a worker the coordinator delegates as a thread and a thread's own subagent as nested", () => {
    expect(
      ultracodeChatKind({
        threadId: "worker",
        project,
        lineage: { parentThreadId: "project-coordinator:p1", relationshipToParent: "subagent" },
        routine: false,
      }),
    ).toBe("thread");
    expect(
      ultracodeChatKind({
        threadId: "child",
        project,
        lineage: { parentThreadId: "worker", relationshipToParent: "subagent" },
        routine: false,
      }),
    ).toBe("nested-subagent");
    expect(
      ultracodeChatKind({
        threadId: "child",
        project: null,
        lineage: { parentThreadId: "worker", relationshipToParent: "subagent" },
        routine: false,
      }),
    ).toBe("nested-subagent");
  });

  it("treats the personal assistant's chats as a coordinator and a routine's chat as a routine", () => {
    expect(
      ultracodeChatKind({
        threadId: "chat",
        project: { id: "me", workspaceSettings: { kind: "personal" } },
        routine: false,
      }),
    ).toBe("coordinator");
    expect(ultracodeChatKind({ threadId: "t1", project, routine: true })).toBe("routine");
  });
});

describe("resolveUltracodeDefault", () => {
  it("is on for a thread on a subscription with room", () => {
    expect(resolveUltracodeDefault(base)).toEqual({ state: "on", reason: "default" });
  });

  it("keeps coordinators, routines and nested subagents off under Threads and on under All chats", () => {
    for (const chatKind of ["coordinator", "routine", "nested-subagent"] as const) {
      expect(resolveUltracodeDefault({ ...base, chatKind })).toEqual({
        state: "off",
        reason: "chat-kind",
      });
      expect(resolveUltracodeDefault({ ...base, chatKind, ultracodeDefault: "all" }).state).toBe(
        "on",
      );
    }
  });

  it("is off when the default is Off or workflows are Disabled", () => {
    expect(resolveUltracodeDefault({ ...base, ultracodeDefault: "off" })).toEqual({
      state: "off",
      reason: "default-off",
    });
    expect(
      resolveUltracodeDefault({ ...base, workflowMode: "disabled", ultracodeDefault: "all" }),
    ).toEqual({ state: "off", reason: "workflows-disabled" });
  });

  it("keeps a machine saved as Automatic on for every chat", () => {
    for (const chatKind of ["thread", "coordinator", "routine", "nested-subagent"] as const) {
      expect(
        resolveUltracodeDefault({
          ...base,
          workflowMode: "automatic",
          ultracodeDefault: "off",
          chatKind,
        }).state,
      ).toBe("on");
    }
  });

  it("stays off for an API-key sign-in and pauses on high usage", () => {
    expect(resolveUltracodeDefault({ ...base, apiKeyBilling: true })).toEqual({
      state: "off",
      reason: "api-key",
    });
    expect(resolveUltracodeDefault({ ...base, usagePaused: true })).toEqual({
      state: "paused",
      reason: "usage",
    });
    // A chat the default never reaches is off, not paused.
    expect(
      resolveUltracodeDefault({ ...base, chatKind: "coordinator", usagePaused: true }).state,
    ).toBe("off");
  });
});

describe("claudeUsagePausesUltracodeDefault", () => {
  it("pauses at 80% of the session or the weekly window", () => {
    expect(
      claudeUsagePausesUltracodeDefault(claude({ windows: [window("session", 80)] }), NOW, "opus"),
    ).toBe(true);
    expect(
      claudeUsagePausesUltracodeDefault(claude({ windows: [window("weekly", 82)] }), NOW, "opus"),
    ).toBe(true);
    expect(
      claudeUsagePausesUltracodeDefault(
        claude({ windows: [window("session", 79), window("weekly", 79.9)] }),
        NOW,
        "opus",
      ),
    ).toBe(false);
  });

  it("does not pause on unknown usage, other windows or a window past its reset", () => {
    expect(claudeUsagePausesUltracodeDefault(undefined, NOW, "opus")).toBe(false);
    expect(claudeUsagePausesUltracodeDefault(claude(), NOW, "opus")).toBe(false);
    expect(
      claudeUsagePausesUltracodeDefault(claude({ windows: [window("monthly", 95)] }), NOW, "opus"),
    ).toBe(false);
    expect(
      claudeUsagePausesUltracodeDefault(
        claude({ windows: [window("weekly", 95, { resetsAt: EARLIER })] }),
        NOW,
        "opus",
      ),
    ).toBe(false);
  });

  it("counts a model's own weekly only for that model", () => {
    const fableWeekly = window("weekly", 90, {
      id: "seven_day_overage_included",
      modelScope: "Fable",
    });
    const provider = claude({ windows: [fableWeekly] });
    expect(claudeUsagePausesUltracodeDefault(provider, NOW, "claude-opus-5-5")).toBe(false);
    expect(claudeUsagePausesUltracodeDefault(provider, NOW, "claude-fable-5-2")).toBe(true);
  });
});

describe("ultracodeDefaultForChat", () => {
  const chat = {
    workflowMode: "on-request",
    ultracodeDefault: "threads",
    chatKind: "thread",
    model: "claude-opus-5-5",
    nowMs: NOW,
  } as const;

  it("reads the sign-in and usage from the chat's provider instance", () => {
    expect(ultracodeDefaultForChat({ ...chat, provider: claude() }).state).toBe("on");
    expect(ultracodeDefaultForChat({ ...chat, provider: undefined }).state).toBe("on");
    expect(
      ultracodeDefaultForChat({ ...chat, provider: claude({ auth: { apiKeyBilling: true } }) }),
    ).toEqual({ state: "off", reason: "api-key" });
    expect(
      ultracodeDefaultForChat({ ...chat, provider: claude({ auth: { type: "bedrock" } }) }).state,
    ).toBe("off");
    expect(
      ultracodeDefaultForChat({ ...chat, provider: claude({ windows: [window("weekly", 82)] }) }),
    ).toEqual({ state: "paused", reason: "usage" });
  });
});

describe("resolveUltracode", () => {
  const chat = {
    workflowMode: "on-request",
    toggle: undefined,
    modelOffersUltracode: true,
    defaultState: "on",
  } as const;

  it("turns it on for an unset toggle when the default is on", () => {
    expect(resolveUltracode(chat)).toEqual({ enabled: true, paused: false, source: "default" });
    expect(resolveUltracode({ ...chat, defaultState: "off" }).enabled).toBe(false);
    expect(resolveUltracode({ ...chat, defaultState: undefined }).enabled).toBe(false);
  });

  it("lets a toggle set in the chat win over the default, and a pause", () => {
    expect(resolveUltracode({ ...chat, toggle: false })).toEqual({
      enabled: false,
      paused: false,
      source: "toggle",
    });
    expect(resolveUltracode({ ...chat, toggle: true, defaultState: "off" }).enabled).toBe(true);
    expect(resolveUltracode({ ...chat, toggle: true, defaultState: "paused" })).toEqual({
      enabled: true,
      paused: false,
      source: "toggle",
    });
  });

  it("turns it off everywhere when workflows are Disabled", () => {
    expect(resolveUltracode({ ...chat, workflowMode: "disabled", toggle: true })).toEqual({
      enabled: false,
      paused: false,
      source: "workflows-disabled",
    });
  });

  it("sends nothing for a model without the toggle", () => {
    expect(resolveUltracode({ ...chat, modelOffersUltracode: false })).toEqual({
      enabled: false,
      paused: false,
      source: "unsupported",
    });
  });

  it("reports a paused default without turning it on", () => {
    expect(resolveUltracode({ ...chat, defaultState: "paused" })).toEqual({
      enabled: false,
      paused: true,
      source: "default",
    });
  });
});

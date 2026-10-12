import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deviceHandoffText, pickDeviceModel } from "./deviceHandoff";

const now = Date.parse("2026-10-10T12:00:00.000Z");
const later = "2026-10-10T15:00:00.000Z";

function provider(
  id: string,
  driver: string,
  used: number | null,
  over: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-10T11:00:00.000Z",
    version: null,
    models: [
      { slug: "opus", name: "Opus", isCustom: false, capabilities: null },
      {
        slug: `${driver}-default`,
        name: "Default",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    ...(used === null
      ? {}
      : {
          usageLimits: {
            checkedAt: "2026-10-10T11:00:00.000Z",
            windows: [
              {
                id: "five_hour",
                kind: "session",
                label: "Session",
                usedPercent: used,
                resetsAt: later,
              },
            ],
          },
        }),
    ...over,
  };
}

const current = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };

describe("pickDeviceModel", () => {
  it("keeps the driver and model when the other device has them with room", () => {
    expect(
      pickDeviceModel({
        providers: [provider("codex", "codex", 10), provider("claude-m3", "claudeAgent", 40)],
        current,
        currentDriver: "claudeAgent",
        belowPercent: 95,
        nowMs: now,
      }),
    ).toEqual({ instanceId: "claude-m3", model: "opus" });
  });

  it("skips a device whose provider is full on the same account", () => {
    expect(
      pickDeviceModel({
        providers: [provider("claude-m3", "claudeAgent", 97), provider("codex", "codex", 10)],
        current,
        currentDriver: "claudeAgent",
        belowPercent: 95,
        nowMs: now,
      }),
    ).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(
      pickDeviceModel({
        providers: [provider("claude-m3", "claudeAgent", 97)],
        current,
        currentDriver: "claudeAgent",
        belowPercent: 95,
        nowMs: now,
      }),
    ).toBeNull();
  });

  it("never picks a provider billed per token", () => {
    const apiKey = provider("claude-api", "claudeAgent", null, {
      auth: { status: "authenticated", type: "apiKey" },
    });
    expect(
      pickDeviceModel({
        providers: [apiKey],
        current,
        currentDriver: "claudeAgent",
        belowPercent: null,
        nowMs: now,
      }),
    ).toBeNull();
  });
});

describe("deviceHandoffText", () => {
  const item = (type: "user_message" | "assistant_message", text: string) =>
    ({ type, text }) as unknown as OrchestrationV2TurnItem;

  it("names the source, branch and conversation", () => {
    const text = deviceHandoffText({
      title: "Fix the login form",
      sourceLabel: "MacBook M4",
      branch: "fix/login",
      turnItems: [
        item("user_message", "Fix the login form"),
        item("assistant_message", "Found the bug in auth.ts"),
      ],
    });
    expect(text).toContain("started on MacBook M4");
    expect(text).toContain("Branch: fix/login");
    expect(text).toContain("User: Fix the login form");
    expect(text).toContain("Assistant: Found the bug in auth.ts");
    expect(text).not.toContain("earlier messages left out");
  });

  it("keeps the first request and the latest messages within the size budget", () => {
    const many = [
      item("user_message", "The original ask"),
      ...Array.from({ length: 30 }, (_, index) =>
        item("assistant_message", `step ${index} ${"x".repeat(3_000)}`),
      ),
    ];
    const text = deviceHandoffText({
      title: "Long",
      sourceLabel: "M1",
      branch: null,
      turnItems: many,
    });
    expect(text).toContain("User: The original ask");
    expect(text).toContain("[earlier messages left out]");
    expect(text).toContain("step 29");
    expect(text).not.toContain("step 0 ");
    expect(text.length).toBeLessThanOrEqual(12_500);
  });
});

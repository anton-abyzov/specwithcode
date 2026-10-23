import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageBillingPicture, type UsageBillingPresentations } from "./usageBilling";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function window(
  id: string,
  label: string,
  usedPercent: number,
  extra: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow {
  return {
    id,
    kind: "weekly",
    label,
    usedPercent,
    resetsAt: inHours(10),
    ...extra,
  } as ServerProviderUsageWindow;
}

function provider(
  driver: string,
  auth: Partial<ServerProvider["auth"]>,
  options: {
    instanceId?: string;
    displayName?: string;
    windows?: ServerProviderUsageWindow[];
    checkedAt?: string;
    enabled?: boolean;
  } = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(options.instanceId ?? driver),
    driver: ProviderDriverKind.make(driver),
    displayName: options.displayName ?? driver,
    enabled: options.enabled ?? true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated", ...auth },
    checkedAt: minutesAgo(1),
    models: [],
    slashCommands: [],
    skills: [],
    ...(options.windows
      ? { usageLimits: { checkedAt: options.checkedAt ?? minutesAgo(2), windows: options.windows } }
      : {}),
  } as ServerProvider;
}

function presentations(
  ...machines: { id: string; providers: ServerProvider[]; phase?: string }[]
): UsageBillingPresentations {
  return new Map(
    machines.map((machine) => [
      EnvironmentId.make(machine.id),
      {
        connection: { phase: machine.phase ?? "connected" },
        serverConfig: { providers: machine.providers },
      },
    ]),
  );
}

describe("usageBillingPicture", () => {
  it("reads a Console-billed Claude as per token and a ChatGPT Codex as a plan with allowance", () => {
    const picture = usageBillingPicture(
      presentations({
        id: "m4",
        providers: [
          provider("claudeAgent", { type: "subscription", apiKeyBilling: true }),
          provider(
            "codex",
            { type: "chatgpt" },
            {
              windows: [
                window("primary", "Session", 20, { kind: "session" }),
                window("secondary", "Weekly", 62),
              ],
            },
          ),
        ],
      }),
      null,
      NOW,
    );

    expect(picture.byProvider.get("claude")).toEqual({
      provider: "claude",
      mode: "perToken",
      hasApiBilling: true,
      allowance: null,
    });
    expect(picture.byProvider.get("codex")).toMatchObject({
      mode: "plan",
      allowance: { kind: "left", leftPercent: 38, windowLabel: "Weekly", accounts: 1 },
    });
  });

  it("calls differing sign-ins across machines mixed and keeps the tightest fresh plan", () => {
    const picture = usageBillingPicture(
      presentations(
        {
          id: "a",
          providers: [
            provider(
              "claudeAgent",
              { type: "max" },
              { windows: [window("seven_day", "Weekly", 30)] },
            ),
          ],
        },
        { id: "b", providers: [provider("claudeAgent", { type: "apiKey" })] },
        {
          id: "c",
          providers: [
            provider(
              "claudeAgent",
              { type: "max" },
              { windows: [window("seven_day", "Weekly", 80)] },
            ),
          ],
        },
      ),
      null,
      NOW,
    );

    expect(picture.byProvider.get("claude")).toMatchObject({
      mode: "mixed",
      allowance: { kind: "left", leftPercent: 20, accounts: 2 },
    });
  });

  it("does not invent API billing from plan plus unknown sign-ins", () => {
    const picture = usageBillingPicture(
      presentations(
        { id: "plan", providers: [provider("codex", { type: "chatgpt" })] },
        { id: "unknown", providers: [provider("codex", { type: "status-check-failed" })] },
      ),
      null,
      NOW,
    );
    expect(picture.byProvider.get("codex")).toMatchObject({ mode: "mixed", hasApiBilling: false });
  });

  it("never reports a stale, offline, reset or model-scoped window as allowance left", () => {
    const stale = usageBillingPicture(
      presentations({
        id: "a",
        providers: [
          provider(
            "codex",
            { type: "chatgpt" },
            { windows: [window("secondary", "Weekly", 10)], checkedAt: minutesAgo(40) },
          ),
        ],
      }),
      null,
      NOW,
    );
    expect(stale.byProvider.get("codex")?.allowance).toEqual({
      kind: "stale",
      checkedAt: minutesAgo(40),
    });

    const offline = usageBillingPicture(
      presentations({
        id: "a",
        phase: "reconnecting",
        providers: [
          provider("codex", { type: "chatgpt" }, { windows: [window("secondary", "Weekly", 10)] }),
        ],
      }),
      null,
      NOW,
    );
    expect(offline.byProvider.get("codex")?.allowance?.kind).toBe("stale");

    const onlyScopedOrReset = usageBillingPicture(
      presentations({
        id: "a",
        providers: [
          provider(
            "claudeAgent",
            { type: "max" },
            {
              windows: [
                window("seven_day_fable", "Weekly · Fable", 100),
                window("seven_day", "Weekly", 90, { resetsAt: inHours(-1) }),
              ],
            },
          ),
        ],
      }),
      null,
      NOW,
    );
    expect(onlyScopedOrReset.byProvider.get("claude")?.allowance).toEqual({ kind: "notReported" });
  });

  it("lists connected providers with no readable history and skips signed-out or disabled ones", () => {
    const picture = usageBillingPicture(
      presentations({
        id: "a",
        providers: [
          provider(
            "acpRegistry",
            {},
            { instanceId: "acpRegistry_copilot", displayName: "GitHub Copilot" },
          ),
          provider(
            "acpRegistry",
            { type: "vertex-ai" },
            { instanceId: "acpRegistry_gemini", displayName: "Gemini CLI" },
          ),
          provider(
            "acpRegistry",
            {},
            { instanceId: "acpRegistry_off", displayName: "Off", enabled: false },
          ),
          provider("grok", { status: "unauthenticated" }),
        ],
      }),
      null,
      NOW,
    );
    expect(picture.untracked).toEqual(["Gemini CLI", "GitHub Copilot"]);
    expect(picture.byProvider.has("grok")).toBe(false);
  });

  it("only reads the selected environments and leaves an unrecognised sign-in unknown", () => {
    const picture = usageBillingPicture(
      presentations(
        { id: "a", providers: [provider("opencode", {})] },
        { id: "b", providers: [provider("claudeAgent", { type: "apiKey" })] },
      ),
      new Set([EnvironmentId.make("a")]),
      NOW,
    );
    expect(picture.byProvider.get("opencode")?.mode).toBe("unknown");
    expect(picture.byProvider.has("claude")).toBe(false);
  });
});

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitPresentations,
  NO_READING_API_BILLING,
  collectLimitAccounts,
  collectUnreportedLimitAccounts,
} from "./usageLimits.ts";

const checkedAt = "2026-09-03T11:00:00.000Z";
const window = {
  id: "premium_interactions",
  kind: "monthly",
  label: "Premium requests",
  usedPercent: 41,
  resetsAt: "2026-10-01T00:00:00.000Z",
} as const;
const acp = ProviderDriverKind.make("acpRegistry");
const cursor = ProviderDriverKind.make("cursor");
const claude = ProviderDriverKind.make("claudeAgent");

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const machine = (
  label: string,
  providers: ServerProvider[],
  connected = true,
): LimitPresentations extends ReadonlyMap<EnvironmentId, infer V> ? V : never => ({
  entry: { target: { label } },
  ...(connected ? {} : { connection: { phase: "disconnected" } }),
  serverConfig: { providers },
});

const board = (presentations: LimitPresentations) =>
  collectUnreportedLimitAccounts(presentations, collectLimitAccounts(presentations), {
    drivers: "all",
    driverLabel: (driver) => (driver === acp ? "ACP agent" : String(driver)),
  });

describe("collectUnreportedLimitAccounts for the Subscriptions board", () => {
  it("gives no second row to a Cursor instance whose reader is off when another machine reads it", () => {
    const off = provider({
      instanceId: ProviderInstanceId.make("cursor"),
      driver: cursor,
      auth: { status: "authenticated", email: "me@example.com" },
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: { reason: "unsupported", message: "Cursor usage reading is off." },
      },
    });
    const read = provider({
      instanceId: ProviderInstanceId.make("cursor"),
      driver: cursor,
      auth: { status: "authenticated", email: "Me@example.com" },
      usageLimits: { checkedAt, windows: [{ ...window, id: "includedPool", kind: "weekly" }] },
    });
    const presentations = new Map([
      [EnvironmentId.make("desk"), machine("Desk", [off])],
      [EnvironmentId.make("laptop"), machine("Laptop", [read])],
    ]);
    expect(board(presentations)).toEqual([]);
    // Alone, the same instance gets its row with the reader's notice.
    expect(board(new Map([[EnvironmentId.make("desk"), machine("Desk", [off])]]))).toEqual([
      expect.objectContaining({
        key: "desk:cursor",
        reason: "unread",
        message: "Cursor usage reading is off.",
      }),
    ]);
  });

  it("gives a Copilot instance without a reading its own row beside a Copilot reading row", () => {
    const reading = provider({
      instanceId: ProviderInstanceId.make("copilot-work"),
      driver: acp,
      displayName: "Copilot work",
      auth: { status: "unknown" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const unread = provider({
      instanceId: ProviderInstanceId.make("copilot-home"),
      driver: acp,
      displayName: "Copilot home",
      auth: { status: "unknown" },
    });
    const presentations = new Map([
      [EnvironmentId.make("desk"), machine("Desk", [reading, unread])],
    ]);
    expect(collectLimitAccounts(presentations)).toHaveLength(1);
    expect(board(presentations)).toEqual([
      {
        key: "desk:copilot-home",
        driver: acp,
        environmentLabel: "Desk",
        offline: false,
        email: undefined,
        plan: undefined,
        reason: "unread",
        message: "Usage not reported by Copilot home",
        environmentId: EnvironmentId.make("desk"),
        instanceId: ProviderInstanceId.make("copilot-home"),
        displayName: "Copilot home",
      },
    ]);
  });

  it("follows the table: API billing, signed out, other drivers signed out, external usage, disabled", () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        machine(
          "Desk",
          [
            provider({
              instanceId: ProviderInstanceId.make("claudeAgent"),
              driver: claude,
              auth: { status: "authenticated", type: "apiKey", email: "api@example.com" },
              usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
            }),
            provider({ auth: { status: "unauthenticated" } }),
            provider({
              instanceId: ProviderInstanceId.make("codex-shared"),
              usageLimits: {
                checkedAt,
                windows: [],
                externalUsage: { label: "ChatGPT", url: "https://chatgpt.com" },
              },
            }),
            provider({
              instanceId: ProviderInstanceId.make("gemini"),
              driver: ProviderDriverKind.make("geminiCli"),
              auth: { status: "unauthenticated" },
            }),
            provider({
              instanceId: ProviderInstanceId.make("opencode"),
              driver: ProviderDriverKind.make("opencode"),
              usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
            }),
            provider({
              instanceId: ProviderInstanceId.make("devin"),
              driver: acp,
              enabled: false,
            }),
            provider({ instanceId: ProviderInstanceId.make("pi"), driver: acp, installed: false }),
          ],
          false,
        ),
      ],
    ]);
    expect(
      board(presentations).map(({ key, reason, message, offline }) => ({
        key,
        reason,
        message,
        offline,
      })),
    ).toEqual([
      {
        key: "desk:claudeAgent",
        reason: "apiBilling",
        message: NO_READING_API_BILLING,
        offline: true,
      },
      { key: "desk:codex", reason: "signedOut", message: "Signed out", offline: true },
      {
        key: "desk:opencode",
        reason: "unread",
        message: "Usage not reported by opencode",
        offline: true,
      },
    ]);
  });

  it("leaves the default result without the board's fields", () => {
    const presentations = new Map([
      [EnvironmentId.make("desk"), machine("Desk", [provider({ auth: { status: "unknown" } })])],
    ]);
    const [account] = collectUnreportedLimitAccounts(presentations, []);
    expect(Object.keys(account ?? {}).toSorted()).toEqual(
      ["driver", "email", "environmentLabel", "key", "message", "offline", "plan", "reason"],
    );
  });
});

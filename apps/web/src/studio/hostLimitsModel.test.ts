import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectHostLimitBlocks,
  formatAgo,
  hostStatus,
  savableReadings,
  type HostLimitPresentations,
  type SavedHostReading,
} from "./hostLimitsModel";

const now = Date.parse("2026-10-10T12:00:00.000Z");
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const label = (driver: string) =>
  ({ claudeAgent: "Claude", codex: "Codex", grok: "Grok" })[driver] ?? driver;

function provider(
  overrides: Omit<Partial<ServerProvider>, "driver"> & { driver: string },
): ServerProvider {
  const { driver, ...rest } = overrides;
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: at(0),
    models: [],
    slashCommands: [],
    skills: [],
    ...rest,
  };
}

const limits = (used: number, resetHours: number, checkedHours = 0) => ({
  checkedAt: at(checkedHours),
  windows: [
    {
      id: "five_hour",
      kind: "session" as const,
      label: "5-hour",
      usedPercent: used,
      resetsAt: at(resetHours),
    },
  ],
});

const m4 = EnvironmentId.make("env-m4");
const m3 = EnvironmentId.make("env-m3");
const m1 = EnvironmentId.make("env-m1");

function host(name: string, phase: string, providers: ServerProvider[] | null) {
  return {
    entry: { target: { label: name } },
    connection: { phase },
    serverConfig: providers === null ? null : { providers },
  };
}

describe("host limit blocks", () => {
  const presentations: HostLimitPresentations = new Map([
    [
      m3,
      host("M3", "connected", [
        provider({
          driver: "claudeAgent",
          auth: { status: "authenticated", email: "Anton@example.com", label: "Max" },
          usageLimits: limits(30, 2),
        }),
      ]),
    ],
    [
      m4,
      host("m4", "connected", [
        provider({ driver: "codex", usageLimits: limits(10, 1, -0.1) }),
        provider({
          driver: "claudeAgent",
          auth: { status: "authenticated", email: "anton@example.com", label: "Max" },
          usageLimits: limits(42, 3),
        }),
        provider({ driver: "grok" }),
        provider({ driver: "cursor", enabled: false }),
      ]),
    ],
    [m1, host("M1", "offline", null)],
  ]);

  it("lists the project's host first, then online, then offline hosts", () => {
    const blocks = collectHostLimitBlocks(presentations, {
      projectEnvironmentId: m4,
      saved: new Map(),
      driverLabel: label,
      now,
    });
    expect(blocks.map((block) => [block.label, block.status, block.isProjectHost])).toEqual([
      ["m4", "online", true],
      ["M3", "online", false],
      ["M1", "offline", false],
    ]);
  });

  it("orders providers, names identities and marks one account on two hosts", () => {
    const [m4Block, m3Block] = collectHostLimitBlocks(presentations, {
      projectEnvironmentId: m4,
      saved: new Map(),
      driverLabel: label,
      now,
    });
    expect(m4Block?.providers.map((row) => row.label)).toEqual(["Claude", "Codex", "Grok"]);
    const claude = m4Block?.providers[0];
    expect(claude).toMatchObject({ identity: "anton@example.com", plan: "Max", peak: 42 });
    expect(claude?.sharedWith).toEqual(["M3"]);
    expect(m3Block?.providers[0]?.sharedWith).toEqual(["m4"]);
    expect(m4Block?.providers[1]?.sharedWith).toEqual([]);
    expect(m4Block?.providers[2]?.notice).toBe("Does not report subscription limits.");
    expect(m4Block?.readAt).toBe(now);
  });

  it("shows an offline host's saved reading with stale windows marked", () => {
    const saved: SavedHostReading = {
      label: "M1",
      savedAt: now - 3 * 3_600_000,
      providers: [
        {
          key: "claudeAgent:m1@example.com",
          driver: ProviderDriverKind.make("claudeAgent"),
          label: "Claude",
          iconUrl: undefined,
          identity: "m1@example.com",
          plan: null,
          sharedWith: [],
          windows: [
            {
              id: "five_hour",
              label: "5-hour",
              kind: "session",
              usedPercent: 88,
              resetsAt: now - 3_600_000,
              stale: false,
            },
            {
              id: "seven_day",
              label: "Weekly",
              kind: "weekly",
              usedPercent: 50,
              resetsAt: now + 3_600_000,
              stale: false,
            },
          ],
          peak: 88,
          bankedResets: 0,
          notice: null,
          checkedAt: now - 3 * 3_600_000,
        },
      ],
    };
    const blocks = collectHostLimitBlocks(presentations, {
      projectEnvironmentId: m4,
      saved: new Map([[m1, saved]]),
      driverLabel: label,
      now,
    });
    const offline = blocks.find((block) => block.label === "M1");
    expect(offline?.fromSavedReading).toBe(true);
    expect(offline?.readAt).toBe(now - 3 * 3_600_000);
    expect(offline?.providers[0]?.windows[0]).toMatchObject({ stale: true, resetsAt: null });
    expect(offline?.providers[0]?.peak).toBe(50);
  });

  it("saves only live online readings", () => {
    const blocks = collectHostLimitBlocks(presentations, {
      projectEnvironmentId: m4,
      saved: new Map(),
      driverLabel: label,
      now,
    });
    expect([...savableReadings(blocks, now).keys()].sort()).toEqual([m3, m4].sort());
  });

  it("maps connection phases and formats ages", () => {
    expect(hostStatus("connected")).toBe("online");
    expect(hostStatus("reconnecting")).toBe("connecting");
    expect(hostStatus("error")).toBe("offline");
    expect(formatAgo(now - 30_000, now)).toBe("just now");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatAgo(now - 72 * 3_600_000, now)).toBe("3d ago");
  });

  it("grays a window a spent one caps and keeps the peak to account-wide windows", () => {
    const windows = (weeklyUsed: number, fableUsed: number) => ({
      checkedAt: at(0),
      windows: [
        {
          id: "five_hour",
          kind: "session" as const,
          label: "Session",
          usedPercent: 0,
          resetsAt: at(3),
        },
        {
          id: "seven_day",
          kind: "weekly" as const,
          label: "Weekly",
          usedPercent: weeklyUsed,
          resetsAt: at(39),
        },
        {
          id: "seven_day_fable",
          kind: "weekly" as const,
          label: "Weekly · Fable",
          modelScope: "Fable",
          usedPercent: fableUsed,
          resetsAt: at(39),
        },
      ],
    });
    const rowFor = (weeklyUsed: number, fableUsed: number) =>
      collectHostLimitBlocks(
        new Map([
          [
            m4,
            host("m4", "connected", [
              provider({ driver: "claudeAgent", usageLimits: windows(weeklyUsed, fableUsed) }),
            ]),
          ],
        ]),
        { projectEnvironmentId: m4, saved: new Map(), driverLabel: label, now },
      )[0]!.providers[0]!;
    const spent = rowFor(100, 7);
    expect(spent.windows.map((window) => window.blockedBy ?? null)).toEqual([
      { label: "Weekly", resetsAt: Date.parse(at(39)) },
      null,
      { label: "Weekly", resetsAt: Date.parse(at(39)) },
    ]);
    expect(spent.peak).toBe(100);
    // A spent Fable weekly stops Fable only: the session stays usable.
    const fableSpent = rowFor(40, 100);
    expect(fableSpent.windows.map((window) => window.blockedBy ?? null)).toEqual([
      null,
      null,
      null,
    ]);
    expect(fableSpent.peak).toBe(40);
  });
});

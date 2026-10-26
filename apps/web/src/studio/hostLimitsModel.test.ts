import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bindingWindowId,
  collectHostLimitBlocks,
  formatAgo,
  groupLimitsByAccount,
  hostStatus,
  savableReadings,
  windowDisplayLabel,
  type HostLimitBlock,
  type HostLimitPresentations,
  type HostProviderRow,
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
          auth: {
            status: "authenticated",
            email: "Anton@example.com",
            label: "Claude Max Subscription",
          },
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
          auth: {
            status: "authenticated",
            email: "anton@example.com",
            label: "Claude Max Subscription",
          },
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

  it("marks the app's own machine and lists it right after the project's host", () => {
    const withPrimary: HostLimitPresentations = new Map([
      ...presentations,
      [
        EnvironmentId.make("env-local"),
        {
          ...host("Local Mac", "connected", []),
          entry: { target: { label: "Local Mac", _tag: "PrimaryConnectionTarget" } },
        },
      ],
    ]);
    const blocks = collectHostLimitBlocks(withPrimary, {
      projectEnvironmentId: m4,
      saved: new Map(),
      driverLabel: label,
      now,
    });
    expect(blocks.map((block) => [block.label, block.isThisMachine])).toEqual([
      ["m4", false],
      ["Local Mac", true],
      ["M3", false],
      ["M1", false],
    ]);
    expect(blocks[0]?.providers[0]?.instanceId).toBe("claudeAgent");
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
    expect(claude).toMatchObject({ identity: "anton@example.com", plan: "Claude Max", peak: 42 });
    expect(claude?.sharedWith).toEqual(["M3"]);
    expect(m3Block?.providers[0]?.sharedWith).toEqual(["m4"]);
    expect(m4Block?.providers[1]?.sharedWith).toEqual([]);
    expect(m4Block?.providers[2]?.notice).toBe("Does not report subscription limits.");
    expect(m4Block?.providers[1]?.notice).toBeNull();
    expect(m4Block?.readAt).toBe(now);
  });

  it("never shows a failed probe's status message as the plan", () => {
    const [block] = collectHostLimitBlocks(
      new Map([
        [
          m4,
          host("m4", "connected", [
            provider({
              driver: "claudeAgent",
              auth: { status: "unknown", label: "Status check did not finish" },
              usageLimits: limits(30, 2),
            }),
          ]),
        ],
      ]),
      { projectEnvironmentId: null, saved: new Map(), driverLabel: label, now },
    );
    expect(block?.providers[0]?.plan).toBeNull();
  });

  it("says why a subscription agent without limits shows none, as the account view does", () => {
    const [block] = collectHostLimitBlocks(
      new Map([
        [
          m4,
          host("m4", "connected", [
            provider({ driver: "claudeAgent", auth: { status: "unauthenticated" } }),
            provider({ driver: "codex", auth: { status: "unknown" } }),
          ]),
        ],
      ]),
      { projectEnvironmentId: null, saved: new Map(), driverLabel: label, now },
    );
    expect(block?.providers.map((row) => row.notice)).toEqual([
      "Not signed in, so no limits to show.",
      "Could not check the sign-in, so no limits to show.",
    ]);
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

  it("names a session by its reported length, never Session, and keeps other labels", () => {
    const base = { id: "w", usedPercent: 0, resetsAt: null, stale: false } as const;
    expect(
      windowDisplayLabel({ ...base, label: "Session", kind: "session", durationMins: 300 }),
    ).toBe("5-hour");
    expect(
      windowDisplayLabel({ ...base, label: "team: Session", kind: "session", durationMins: 60 }),
    ).toBe("team: 1-hour");
    expect(windowDisplayLabel({ ...base, label: "Session", kind: "session" })).toBe("Short-term");
    // A reading saved before lengths were kept still names Claude's 5-hour.
    expect(
      windowDisplayLabel({ ...base, id: "five_hour", label: "Session", kind: "session" }),
    ).toBe("5-hour");
    expect(
      windowDisplayLabel({ ...base, label: "Weekly", kind: "weekly", durationMins: 10_080 }),
    ).toBe("Weekly");
  });

  it("picks the fullest current account-wide window as binding, never a model one", () => {
    const w = (id: string, used: number, extra: Record<string, unknown> = {}) => ({
      id,
      label: id,
      kind: "weekly" as const,
      usedPercent: used,
      resetsAt: Date.parse("2026-10-20T00:00:00Z"),
      stale: false,
      ...extra,
    });
    expect(bindingWindowId([w("five", 30), w("week", 88)])).toBe("weekly:week");
    expect(
      bindingWindowId([w("five", 90), w("week", 10), w("fable", 100, { modelScope: "Fable" })]),
    ).toBe("weekly:five");
    // A stale reading never binds; a tie goes to the window that resets last.
    expect(bindingWindowId([w("five", 95, { stale: true }), w("week", 20)])).toBe("weekly:week");
    expect(
      bindingWindowId([w("a", 50), w("b", 50, { resetsAt: Date.parse("2026-10-25T00:00:00Z") })]),
    ).toBe("weekly:b");
    expect(bindingWindowId([w("fable", 40, { modelScope: "Fable" })])).toBe("weekly:fable");
    expect(bindingWindowId([])).toBeNull();
  });
});

describe("groupLimitsByAccount", () => {
  const row = (
    key: string,
    instanceId: string,
    checkedAt: number,
    extra: Partial<HostProviderRow> = {},
  ): HostProviderRow => ({
    key,
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    iconUrl: undefined,
    identity: null,
    plan: null,
    sharedWith: [],
    windows: [],
    peak: null,
    bankedResets: 0,
    notice: null,
    checkedAt,
    ...extra,
  });
  const block = (id: string, label: string, providers: HostProviderRow[]): HostLimitBlock => ({
    environmentId: EnvironmentId.make(id),
    label,
    isProjectHost: false,
    isThisMachine: false,
    status: "online",
    readAt: null,
    fromSavedReading: false,
    providers,
  });

  it("puts the current account first, then the fallback order, then each other account once", () => {
    const blocks = [
      block("m4", "M4", [
        row("claude:a", "claudeAgent", 100),
        row("codex:b", "codex", 100, { driver: ProviderDriverKind.make("codex"), label: "Codex" }),
        row("instance:grok:grok", "grok", 100, {
          driver: ProviderDriverKind.make("grok"),
          label: "Grok",
        }),
      ]),
      block("m3", "M3", [
        row("claude:a", "claudeAgent", 300),
        row("claude:c", "claudeWork", 50),
        row("instance:grok:grok", "grok", 90, {
          driver: ProviderDriverKind.make("grok"),
          label: "Grok",
        }),
      ]),
    ];
    const groups = groupLimitsByAccount(blocks, {
      current: { environmentId: EnvironmentId.make("m4"), instanceId: "claudeAgent" },
      fallback: [{ instanceId: "codex", label: "Codex · GPT-6.1-Sol" }],
    });
    // The current account keeps its own machine's reading, though M3 read it later.
    expect(groups.current).toMatchObject({ machine: "M4", readAt: 100, machines: ["M4", "M3"] });
    expect(groups.fallback).toEqual([
      expect.objectContaining({
        instanceId: "codex",
        group: expect.objectContaining({ machine: "M4" }),
      }),
    ]);
    // Grok has no reported identity, so each machine keeps its own row.
    expect(groups.others.map((group) => `${group.key}:${group.machine}`)).toEqual([
      "instance:grok:grok@m4:M4",
      "claude:c:M3",
      "instance:grok:grok@m3:M3",
    ]);
  });

  it("shows another account's freshest reading and names every machine", () => {
    const blocks = [
      block("m4", "M4", [row("claude:a", "claudeAgent", 100)]),
      block("m3", "M3", [row("claude:a", "claudeAgent", 300)]),
    ];
    const groups = groupLimitsByAccount(blocks, { current: null });
    expect(groups.others).toEqual([
      expect.objectContaining({
        key: "claude:a",
        machine: "M3",
        readAt: 300,
        machines: ["M3", "M4"],
      }),
    ]);
  });
});

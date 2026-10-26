// @effect-diagnostics globalDate:off
import { rollupStatusLevels, type ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildStatusServices,
  decodeHealthWatch,
  publicIncidents,
  type StatusInputs,
} from "./catalog.ts";
import { parseGoogleCloudIncidents, parseStatuspageSummary, parseXaiStatusRss } from "./feeds.ts";
import {
  dayLevel,
  emptyStatusHistory,
  localDate,
  recordStatusChecks,
  recordUnexpectedStop,
  serviceDays,
  serviceUptime,
} from "./history.ts";

const NOW = Date.parse("2026-10-16T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const claudeSummary = JSON.stringify({
  status: { indicator: "minor", description: "Minor Service Outage" },
  components: [
    { id: "a", name: "claude.ai", status: "operational" },
    { id: "b", name: "Claude API (api.anthropic.com)", status: "degraded_performance" },
    { id: "c", name: "Claude Code", status: "operational" },
    { id: "d", name: "Claude for Government", status: "major_outage" },
  ],
  incidents: [
    {
      id: "inc1",
      name: "Elevated errors on Claude API",
      status: "identified",
      impact: "minor",
      started_at: "2026-10-16T14:10:00Z",
      updated_at: "2026-10-16T14:40:00Z",
      shortlink: "https://stspg.io/inc1",
      components: [{ id: "b" }],
    },
    {
      id: "inc2",
      name: "Government outage",
      status: "investigating",
      impact: "critical",
      started_at: "2026-10-16T14:00:00Z",
      components: [{ id: "d" }],
    },
  ],
});

describe("status feeds", () => {
  it("reads Statuspage components and incidents, keeping only the matching ones", () => {
    const reading = parseStatuspageSummary(claudeSummary, {
      serviceId: "claude",
      pageUrl: "https://status.claude.com",
      include: (name) => /^(Claude API|Claude Code|claude\.ai)/iu.test(name),
    });
    expect(reading.components.map((component) => component.name)).toEqual([
      "claude.ai",
      "Claude API (api.anthropic.com)",
      "Claude Code",
    ]);
    expect(reading.level).toBe("degraded");
    expect(reading.incidents).toHaveLength(1);
    expect(reading.incidents[0]).toMatchObject({
      title: "Elevated errors on Claude API",
      stage: "identified",
      url: "https://stspg.io/inc1",
      resolvedAt: null,
    });
  });

  it("treats offline and malformed feeds as unknown", () => {
    const options = { serviceId: "x", pageUrl: "https://x", include: () => true };
    expect(parseStatuspageSummary(null, options).level).toBe("unknown");
    expect(parseStatuspageSummary("<html>", options).level).toBe("unknown");
    expect(parseStatuspageSummary("{}", options).level).toBe("unknown");
  });

  it("reads open Gemini incidents from Google Cloud and skips other products", () => {
    const reading = parseGoogleCloudIncidents(
      JSON.stringify([
        {
          id: "g1",
          begin: "2026-10-16T13:00:00+00:00",
          external_desc: "Vertex Gemini API elevated latency",
          severity: "medium",
          affected_products: [{ title: "Vertex Gemini API" }],
          uri: "incidents/g1",
        },
        {
          id: "g2",
          begin: "2026-10-16T13:00:00+00:00",
          external_desc: "Cloud Storage errors",
          severity: "high",
          affected_products: [{ title: "Google Cloud Storage" }],
        },
      ]),
      {
        serviceId: "google",
        pageUrl: "https://status.cloud.google.com",
        product: /Gemini/u,
        now: NOW,
        lookbackMs: 7 * DAY,
      },
    );
    expect(reading.incidents).toHaveLength(1);
    expect(reading.level).toBe("partial_outage");
    expect(reading.incidents[0]!.url).toBe("https://status.cloud.google.com/incidents/g1");
  });

  it("reads xAI's RSS, resolving items marked resolved", () => {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>[grok.com] grok.com</title><link>https://status.x.ai/a</link><guid>a</guid>
        <description><![CDATA[<h3>Status: RESOLVED</h3><p>Severity: outage</p><p>Resolved: Thu, 15 Oct 2026 10:30:00 GMT</p>]]></description>
        <pubDate>Thu, 15 Oct 2026 10:00:00 GMT</pubDate><category>outage</category><category>resolved</category></item>
      <item><title>[API] Elevated API errors</title><link>https://status.x.ai/b</link><guid>b</guid>
        <description><![CDATA[<h3>Status: INVESTIGATING</h3><p>Severity: disruption</p>]]></description>
        <pubDate>Fri, 16 Oct 2026 14:00:00 GMT</pubDate><category>disruption</category></item>
    </channel></rss>`;
    const reading = parseXaiStatusRss(rss, {
      serviceId: "xai",
      pageUrl: "https://status.x.ai",
      now: NOW,
      lookbackMs: 7 * DAY,
    });
    expect(reading.incidents.map((incident) => [incident.title, incident.stage])).toEqual([
      ["[grok.com] grok.com", "resolved"],
      ["[API] Elevated API errors", "investigating"],
    ]);
    expect(reading.level).toBe("partial_outage");
  });
});

describe("status history", () => {
  const sample = (level: "operational" | "major_outage" | "unknown") => ({
    serviceId: "local-service",
    serviceName: "Local service",
    level,
    note: level === "operational" ? null : "Database did not answer",
    tracksIncidents: true,
  });

  it("opens an incident after two failing checks and resolves after two healthy ones", () => {
    let history = emptyStatusHistory();
    history = recordStatusChecks(history, [sample("major_outage")], NOW);
    expect(history.incidents).toHaveLength(0);
    history = recordStatusChecks(history, [sample("major_outage")], NOW + 60_000);
    expect(history.incidents).toHaveLength(1);
    expect(history.incidents[0]).toMatchObject({ stage: "investigating", resolvedAt: null });
    history = recordStatusChecks(history, [sample("unknown")], NOW + 120_000);
    history = recordStatusChecks(history, [sample("operational")], NOW + 180_000);
    expect(history.incidents[0]!.stage).toBe("monitoring");
    history = recordStatusChecks(history, [sample("operational")], NOW + 240_000);
    expect(history.incidents[0]!.stage).toBe("resolved");
    expect(history.incidents[0]!.resolvedAt).not.toBeNull();
  });

  it("builds 90 days ending today with notes, and an uptime over known checks", () => {
    let history = emptyStatusHistory();
    history = recordStatusChecks(history, [sample("major_outage")], NOW - 2 * DAY);
    history = recordStatusChecks(history, [sample("major_outage")], NOW - 2 * DAY + 60_000);
    for (let index = 0; index < 6; index += 1) {
      history = recordStatusChecks(history, [sample("operational")], NOW + index * 60_000);
    }
    history = recordStatusChecks(history, [sample("unknown")], NOW + 10 * 60_000);
    const days = serviceDays(history, "local-service", NOW);
    expect(days).toHaveLength(90);
    expect(days.at(-1)).toMatchObject({ date: localDate(NOW), level: "operational", checks: 7 });
    expect(days.at(-3)).toMatchObject({
      level: "major_outage",
      failures: 2,
      notes: ["Database did not answer"],
    });
    expect(days[0]!.level).toBe("unknown");
    expect(serviceUptime(days, history, "local-service")).toBe(75);
  });

  it("caps a single failing check among healthy ones at Needs attention", () => {
    expect(dayLevel({ operational: 200, major_outage: 1 })).toBe("degraded");
    expect(dayLevel({ operational: 200, major_outage: 2 })).toBe("major_outage");
    expect(dayLevel({ major_outage: 1 })).toBe("major_outage");
    expect(dayLevel({ unknown: 3 })).toBe("unknown");
    expect(dayLevel({})).toBe("unknown");
  });

  it("records an unexpected stop from the last finished check to the restart, once", () => {
    let history = recordStatusChecks(
      emptyStatusHistory(),
      [sample("operational")],
      NOW - 30 * 60_000,
    );
    const stop = { previousStartedAt: NOW - 5 * 60 * 60_000, restartedAt: NOW - 20 * 60_000 };
    history = recordUnexpectedStop(history, stop);
    history = recordUnexpectedStop(history, stop);
    expect(history.incidents).toHaveLength(1);
    expect(history.incidents[0]).toMatchObject({
      serviceId: "local-service",
      title: "Local service stopped unexpectedly",
      level: "major_outage",
      stage: "resolved",
      startedAt: new Date(NOW - 30 * 60_000).toISOString(),
      resolvedAt: new Date(NOW - 20 * 60_000).toISOString(),
    });
    const today = serviceDays(history, "local-service", NOW).at(-1)!;
    expect(today.level).toBe("degraded");
    expect(today.notes[0]).toMatch(/^Stopped unexpectedly; restarted at /u);
  });

  it("drops days older than the window", () => {
    let history = emptyStatusHistory();
    history = recordStatusChecks(history, [sample("operational")], NOW - 120 * DAY);
    history = recordStatusChecks(history, [sample("operational")], NOW);
    expect(Object.keys(history.days)).toEqual([localDate(NOW)]);
  });
});

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-16T14:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const inputs = (overrides: Partial<StatusInputs> = {}): StatusInputs => ({
  now: NOW,
  serverVersion: "1.0.34",
  startedAt: NOW - 3 * 60 * 60 * 1000,
  databaseOk: true,
  providers: [provider({})],
  threads: [],
  coordinators: [],
  fleet: null,
  tailscale: null,
  feeds: {},
  releaseFeedReachable: true,
  ...overrides,
});

describe("status catalog", () => {
  it("shows the app's own services and only the configured providers", () => {
    const services = buildStatusServices(inputs());
    expect(services.map((service) => service.id)).toEqual([
      "local-service",
      "coordinators",
      "updates",
      "provider:claude",
      "github",
    ]);
    expect(services[0]).toMatchObject({
      level: "operational",
      detail: "SpecWithCode 1.0.34 · up 3 hr",
    });
  });

  it("combines a provider's public status, sign-in and observed errors", () => {
    const claude = parseStatuspageSummary(claudeSummary, {
      serviceId: "claude",
      pageUrl: "https://status.claude.com",
      include: (name) => /^(Claude API|Claude Code|claude\.ai)/iu.test(name),
    });
    const services = buildStatusServices(
      inputs({
        feeds: { claude },
        threads: [
          ...Array.from({ length: 3 }, () => ({
            providerInstanceId: "claudeAgent",
            status: "failed",
            lastErrorClass: "provider_error",
            updatedAtMs: NOW - 10 * 60_000,
          })),
          {
            providerInstanceId: "claudeAgent",
            status: "failed",
            lastErrorClass: "provider_error",
            updatedAtMs: NOW - 3 * 60 * 60_000,
          },
        ],
      }),
    );
    const service = services.find((entry) => entry.id === "provider:claude")!;
    expect(service.level).toBe("partial_outage");
    expect(service.components.find((entry) => entry.id === "observed:claude")).toMatchObject({
      level: "partial_outage",
      detail: "3 threads failed with provider errors.",
    });
    expect(service.components.some((entry) => entry.name === "Claude Code")).toBe(true);
    expect(service.dependents).toContain("Claude threads and subagents");
    expect(publicIncidents(services, { claude }).map((incident) => incident.serviceId)).toEqual([
      "provider:claude",
    ]);
  });

  it("marks a signed-out provider and an unreachable machine", () => {
    const services = buildStatusServices(
      inputs({
        providers: [
          provider({ auth: { status: "unauthenticated" } as ServerProvider["auth"] }),
          provider({
            instanceId: "copilot" as never,
            driver: "acpRegistry" as never,
            displayName: "GitHub Copilot" as never,
          }),
        ],
        fleet: {
          configured: true,
          connectPermission: "access:write",
          observedAt: "2026-10-16T15:00:00.000Z",
          listener: "network",
          machines: [
            {
              id: "m1" as never,
              label: "M1",
              environmentId: "env-m1" as never,
              url: "https://m1.tailnet.ts.net",
              status: "unreachable",
              pairingConfigured: true,
            },
          ],
        },
        tailscale: { state: "running", dnsName: "m4.tailnet.ts.net" },
      }),
    );
    expect(services.find((entry) => entry.id === "provider:claude")!.level).toBe("degraded");
    expect(services.some((entry) => entry.id === "provider:copilot")).toBe(true);
    expect(services.find((entry) => entry.id === "machine:m1")).toMatchObject({
      group: "machines",
      level: "major_outage",
    });
    expect(services.find((entry) => entry.id === "tailscale")!.level).toBe("operational");
  });

  const tailnetFleet = (url: string): StatusInputs["fleet"] => ({
    configured: true,
    connectPermission: "access:write",
    observedAt: "2026-10-16T15:00:00.000Z",
    listener: "network",
    machines: [
      {
        id: "m1" as never,
        label: "M1",
        environmentId: "env-m1" as never,
        url,
        status: "reachable",
        pairingConfigured: true,
      },
    ],
  });

  it("does not degrade for missing Tailscale when Connect is linked", () => {
    const services = buildStatusServices(
      inputs({
        fleet: tailnetFleet("https://m1.tailnet.ts.net"),
        tailscale: { state: "unavailable" },
        connect: { mode: "managed", tunnel: "running" },
      }),
    );
    const tailscale = services.find((entry) => entry.id === "tailscale")!;
    expect(tailscale.level).toBe("operational");
    expect(tailscale.dependents).toEqual(["Remote machines (worker delegation)"]);
    expect(services.find((entry) => entry.id === "connect")).toMatchObject({
      name: "SpecWithCode Connect",
      level: "operational",
      dependents: ["Phone and browser access"],
    });
    // Feeds are not read here, so GitHub stays unknown; nothing is degraded.
    expect(rollupStatusLevels(services.map((entry) => entry.level))).toBe("unknown");
    expect(
      services.filter((entry) => entry.level !== "unknown").map((entry) => entry.level),
    ).toEqual(services.filter((entry) => entry.level !== "unknown").map(() => "operational"));
  });

  it("hides Tailscale when it is absent and no machine uses a tailnet address", () => {
    const services = buildStatusServices(
      inputs({
        fleet: tailnetFleet("https://m1.example.com"),
        tailscale: { state: "unavailable" },
      }),
    );
    expect(services.some((entry) => entry.id === "tailscale")).toBe(false);
  });

  it("shows Tailscale for a machine at a Tailscale IP address", () => {
    const services = buildStatusServices(
      inputs({
        fleet: tailnetFleet("http://100.101.102.103:3773"),
        tailscale: { state: "unavailable" },
      }),
    );
    expect(services.find((entry) => entry.id === "tailscale")!.level).toBe("degraded");
  });

  it("degrades missing Tailscale only when tailnet machines need it and Connect is not linked", () => {
    const tailscale = buildStatusServices(
      inputs({
        fleet: tailnetFleet("https://m1.tailnet.ts.net"),
        tailscale: { state: "unavailable" },
        connect: { mode: "not_linked", tunnel: "unknown" },
      }),
    ).find((entry) => entry.id === "tailscale")!;
    expect(tailscale.level).toBe("degraded");
  });

  it("shows Connect as informational when not linked and degraded when its tunnel is down", () => {
    const notLinked = buildStatusServices(
      inputs({ connect: { mode: "not_linked", tunnel: "unknown" } }),
    ).find((entry) => entry.id === "connect")!;
    expect(notLinked.level).toBe("operational");
    expect(notLinked.detail).toContain("Not linked");

    const publishOnly = buildStatusServices(
      inputs({ connect: { mode: "publish_only", tunnel: "unknown" } }),
    ).find((entry) => entry.id === "connect")!;
    expect(publishOnly.level).toBe("operational");
    expect(publishOnly.components.map((entry) => entry.id)).toEqual(["connect:link"]);

    const down = buildStatusServices(inputs({ connect: { mode: "managed", tunnel: "down" } })).find(
      (entry) => entry.id === "connect",
    )!;
    expect(down.level).toBe("degraded");
    expect(down.detail).toBe("Tunnel: Connector is not running; the relay cannot reach this Mac.");
    expect(down.tracksIncidents).toBe(true);
  });

  it("stays unknown, not failing, when every feed is offline", () => {
    const services = buildStatusServices(inputs({ releaseFeedReachable: null }));
    expect(services.find((entry) => entry.id === "github")!.level).toBe("unknown");
    expect(services.find((entry) => entry.id === "updates")!.level).toBe("unknown");
    expect(services.find((entry) => entry.id === "provider:claude")!.level).toBe("operational");
  });

  it("degrades the local service when the health watch reports a stale update hold", () => {
    const healthWatch = decodeHealthWatch({
      status: "degraded",
      checkedAt: new Date(NOW - 2 * 60_000).toISOString(),
      problems: ["Update hold refuses new work: no install request since it began, held for 3m00s"],
    });
    const local = buildStatusServices(inputs({ healthWatch })).find(
      (entry) => entry.id === "local-service",
    )!;
    expect(local.level).toBe("degraded");
    expect(local.detail).toBe(
      "Health watch: Update hold refuses new work: no install request since it began, held for 3m00s",
    );
    expect(local.tracksIncidents).toBe(true);
  });

  it("ignores a missing, malformed or stale health watch report", () => {
    expect(decodeHealthWatch({ status: "fine", checkedAt: "2026-10-16T15:00:00Z" })).toBeNull();
    expect(decodeHealthWatch(null)).toBeNull();
    const stale = decodeHealthWatch({
      status: "down",
      checkedAt: new Date(NOW - 60 * 60_000).toISOString(),
      problems: ["Server does not answer"],
    });
    const local = buildStatusServices(inputs({ healthWatch: stale })).find(
      (entry) => entry.id === "local-service",
    )!;
    expect(local.level).toBe("operational");
    expect(local.components.find((entry) => entry.id === "health-watch")).toMatchObject({
      level: "unknown",
      detail: "Last report 1 hr ago.",
    });
    expect(
      buildStatusServices(inputs()).find((entry) => entry.id === "local-service")!.components,
    ).toHaveLength(3);
  });
});

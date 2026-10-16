// @effect-diagnostics globalDate:off
import type { ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildStatusServices, publicIncidents, type StatusInputs } from "./catalog.ts";
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

  it("stays unknown, not failing, when every feed is offline", () => {
    const services = buildStatusServices(inputs({ releaseFeedReachable: null }));
    expect(services.find((entry) => entry.id === "github")!.level).toBe("unknown");
    expect(services.find((entry) => entry.id === "updates")!.level).toBe("unknown");
    expect(services.find((entry) => entry.id === "provider:claude")!.level).toBe("operational");
  });
});

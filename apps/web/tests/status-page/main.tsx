// Synthetic data only: no server, account, provider, network or store.
// The host's real catalog, feed parsers and history fold build the snapshot,
// so the page shows what the monitor would produce for this scenario.
import type { ServerProvider } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { buildStatusServices, type StatusInputs } from "../../../server/src/statusPage/catalog";
import {
  parseGoogleCloudIncidents,
  parseStatuspageSummary,
  parseXaiStatusRss,
} from "../../../server/src/statusPage/feeds";
import {
  emptyStatusHistory,
  recordStatusChecks,
  recordUnexpectedStop,
} from "../../../server/src/statusPage/history";
import { snapshotFrom } from "../../../server/src/statusPage/snapshot";
import { withLocalComponents } from "../../src/components/status/statusModel";
import { StatusView } from "../../src/components/status/StatusView";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 16, 14, 30).getTime();

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date(NOW).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const providers = [
  provider({
    instanceId: "claudeAgent" as never,
    driver: "claudeAgent" as never,
    displayName: "Claude" as never,
    version: "2.1.4" as never,
  }),
  provider({
    instanceId: "codex" as never,
    driver: "codex" as never,
    displayName: "Codex" as never,
    version: "0.48.0" as never,
  }),
  provider({
    instanceId: "copilot" as never,
    driver: "acpRegistry" as never,
    displayName: "GitHub Copilot" as never,
  }),
  provider({
    instanceId: "gemini" as never,
    driver: "acpRegistry" as never,
    displayName: "Gemini CLI" as never,
  }),
  provider({ instanceId: "grok" as never, driver: "grok" as never, displayName: "Grok" as never }),
];

const statuspage = (
  components: ReadonlyArray<readonly [string, string]>,
  incidents: ReadonlyArray<Record<string, unknown>> = [],
) =>
  JSON.stringify({
    components: components.map(([name, status], index) => ({ id: `c${index}`, name, status })),
    incidents,
  });

function feedsFor(day: number) {
  const claudeDegraded = day === 0 || day === 5 || day === 41;
  const codexDown = day === 60;
  const claude = parseStatuspageSummary(
    statuspage(
      [
        ["claude.ai", "operational"],
        ["Claude API (api.anthropic.com)", claudeDegraded ? "degraded_performance" : "operational"],
        ["Claude Code", "operational"],
      ],
      day === 0
        ? [
            {
              id: "elevated-api",
              name: "Elevated errors on Claude API for some requests",
              status: "identified",
              impact: "minor",
              started_at: new Date(NOW - 95 * 60_000).toISOString(),
              updated_at: new Date(NOW - 20 * 60_000).toISOString(),
              shortlink: "https://status.claude.com/incidents/example",
              components: [{ id: "c1" }],
            },
          ]
        : [],
    ),
    {
      serviceId: "claude",
      pageUrl: "https://status.claude.com",
      include: (name) => /^(Claude API|Claude Code|claude\.ai)/iu.test(name),
    },
  );
  const openai = parseStatuspageSummary(
    statuspage(
      [
        ["Responses", codexDown ? "partial_outage" : "operational"],
        ["Codex in ChatGPT Desktop", "operational"],
        ["Login", "operational"],
      ],
      day <= 1
        ? [
            {
              id: "codex-latency",
              name: "Increased Codex task latency",
              status: "resolved",
              impact: "minor",
              started_at: new Date(NOW - DAY - 3 * 3_600_000).toISOString(),
              resolved_at: new Date(NOW - DAY - 2 * 3_600_000).toISOString(),
              shortlink: "https://status.openai.com/incidents/example",
            },
          ]
        : [],
    ),
    {
      serviceId: "openai",
      pageUrl: "https://status.openai.com",
      include: (name) => /Codex|^Responses$|^Login$|^Chat Completions$/iu.test(name),
    },
  );
  const github = parseStatuspageSummary(
    statuspage([
      ["Git Operations", "operational"],
      ["API Requests", day === 20 ? "degraded_performance" : "operational"],
      ["Pull Requests", "operational"],
      ["Actions", "operational"],
      ["Copilot", "operational"],
    ]),
    {
      serviceId: "github",
      pageUrl: "https://www.githubstatus.com",
      include: () => true,
    },
  );
  const tailscale = parseStatuspageSummary(
    statuspage([
      ["Coordination service", "operational"],
      ["DERP relay servers", "operational"],
    ]),
    { serviceId: "tailscale", pageUrl: "https://status.tailscale.com", include: () => true },
  );
  // Google's feed is offline in this scenario: Gemini's public status is unknown.
  const google = parseGoogleCloudIncidents(day === 0 ? null : "[]", {
    serviceId: "google",
    pageUrl: "https://status.cloud.google.com",
    product: /Gemini/u,
    now: NOW,
    lookbackMs: 7 * DAY,
  });
  const xai = parseXaiStatusRss("<rss><channel></channel></rss>", {
    serviceId: "xai",
    pageUrl: "https://status.x.ai",
    now: NOW,
    lookbackMs: 7 * DAY,
  });
  return { claude, openai, github, tailscale, google, xai };
}

function inputsFor(day: number, at: number): StatusInputs {
  const m3Down = day === 0 || day === 33 || day === 34;
  return {
    now: at,
    serverVersion: "1.0.35",
    startedAt: NOW - 6 * 3_600_000,
    databaseOk: true,
    providers,
    threads:
      day === 0
        ? [
            {
              providerInstanceId: "claudeAgent",
              status: "failed",
              lastErrorClass: "provider_error",
              updatedAtMs: at - 12 * 60_000,
            },
          ]
        : [],
    coordinators: [
      { projectTitle: "SpecWithCode", status: "running", lastErrorClass: null },
      { projectTitle: "EasyChamp", status: "idle", lastErrorClass: null },
    ],
    fleet: {
      configured: true,
      connectPermission: "access:write",
      observedAt: new Date(at).toISOString(),
      listener: "network",
      machines: [
        {
          id: "m1" as never,
          label: "M1",
          environmentId: "env-m1" as never,
          url: "https://m1.example.ts.net",
          status: "reachable",
          pairingConfigured: true,
        },
        {
          id: "m3" as never,
          label: "M3",
          environmentId: "env-m3" as never,
          url: "https://m3.example.ts.net",
          status: m3Down ? "unreachable" : "reachable",
          pairingConfigured: true,
        },
      ],
    },
    tailscale: { state: "running", dnsName: "m4.example.ts.net" },
    connect: { mode: "managed", tunnel: "running" },
    feeds: feedsFor(day),
    releaseFeedReachable: day !== 12,
  };
}

// Six checks a day for 90 days; today's last two checks are the current state.
let history = emptyStatusHistory();
for (let day = 89; day >= 0; day -= 1) {
  if (day === 0) {
    // The service crashed overnight: its last check finished at 1:36 AM and it restarted at 1:40 AM.
    history = {
      ...history,
      lastAliveAt: new Date(2026, 9, 16, 1, 36).getTime(),
    };
    history = recordUnexpectedStop(history, {
      previousStartedAt: NOW - DAY - 6 * 3_600_000,
      restartedAt: new Date(2026, 9, 16, 1, 40, 25).getTime(),
    });
  }
  for (let check = 0; check < 6; check += 1) {
    const at = NOW - day * DAY - (5 - check) * 10 * 60_000;
    // Day 20 has one failing GitHub API check among healthy ones.
    const inputs = inputsFor(day === 20 && check > 0 ? 21 : day, at);
    history = recordStatusChecks(
      history,
      buildStatusServices(inputs).map((service) => ({
        serviceId: service.id,
        serviceName: service.name,
        level: service.level,
        note: service.level === "operational" ? null : service.detail,
        tracksIncidents: service.tracksIncidents,
      })),
      at,
    );
  }
}

const empty = params.get("state") === "empty";
const snapshot = empty
  ? null
  : withLocalComponents(
      snapshotFrom(
        { inputs: inputsFor(0, NOW), checkedAt: NOW - 2 * 60_000, checking: false },
        history,
        NOW,
      ),
      {
        id: "desktop-updater",
        name: "Desktop updater",
        level: "operational",
        detail: "Up to date on 1.0.35.",
      },
    );

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-5xl px-6 py-6">
    <StatusView
      snapshot={snapshot}
      now={NOW}
      refreshing={false}
      error={null}
      onRefresh={() => undefined}
    />
  </main>,
);

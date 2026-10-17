/**
 * What the Status page shows and what each service's level is built from.
 * Pure: the monitor gathers the inputs, this turns them into services.
 */
import {
  rollupStatusLevels,
  type ServerProvider,
  type StatusComponent,
  type StatusIncident,
  type StatusLevel,
  type StatusServiceGroup,
} from "@specweave-studio/contracts";
import type { StudioFleetSnapshot } from "@specweave-studio/contracts/studioFleet";

import type { FeedReading } from "./feeds.ts";

export type FeedId = "claude" | "openai" | "github" | "google" | "xai" | "tailscale";

export const FEEDS: Record<
  FeedId,
  { readonly url: string; readonly pageUrl: string; readonly label: string }
> = {
  claude: {
    url: "https://status.claude.com/api/v2/summary.json",
    pageUrl: "https://status.claude.com",
    label: "status.claude.com",
  },
  openai: {
    url: "https://status.openai.com/api/v2/summary.json",
    pageUrl: "https://status.openai.com",
    label: "status.openai.com",
  },
  github: {
    url: "https://www.githubstatus.com/api/v2/summary.json",
    pageUrl: "https://www.githubstatus.com",
    label: "githubstatus.com",
  },
  google: {
    url: "https://status.cloud.google.com/incidents.json",
    pageUrl: "https://status.cloud.google.com",
    label: "status.cloud.google.com",
  },
  xai: {
    url: "https://status.x.ai/feed.xml",
    pageUrl: "https://status.x.ai",
    label: "status.x.ai",
  },
  tailscale: {
    url: "https://status.tailscale.com/api/v2/summary.json",
    pageUrl: "https://status.tailscale.com",
    label: "status.tailscale.com",
  },
};

/** The app's own release feed; reachability only, never the upstream product's. */
export const RELEASE_FEED_URL = "https://github.com/anton-abyzov/specwithcode/releases.atom";

export type ProviderKind = "claude" | "codex" | "copilot" | "gemini" | "grok";

interface ProviderDefinition {
  readonly name: string;
  readonly feed: FeedId;
  /** Statuspage components that matter to the app, by name. */
  readonly components?: RegExp;
  readonly dependents: ReadonlyArray<string>;
}

export const PROVIDERS: Record<ProviderKind, ProviderDefinition> = {
  claude: {
    name: "Claude",
    feed: "claude",
    components: /^(Claude API|Claude Code|claude\.ai)/iu,
    dependents: ["Claude threads and subagents", "Claude coordinators", "Claude usage limits"],
  },
  codex: {
    name: "Codex",
    feed: "openai",
    components: /Codex|^Responses$|^Login$|^Chat Completions$/iu,
    dependents: ["Codex threads", "ChatGPT sign-in", "Codex usage limits"],
  },
  copilot: {
    name: "GitHub Copilot",
    feed: "github",
    components: /Copilot/iu,
    dependents: ["Copilot threads", "Copilot model access"],
  },
  gemini: {
    name: "Gemini",
    feed: "google",
    dependents: ["Gemini threads", "Antigravity threads"],
  },
  grok: {
    name: "Grok",
    feed: "xai",
    dependents: ["Grok threads"],
  },
};

export const GITHUB_COMPONENTS = /^(Git Operations|API Requests|Pull Requests|Actions)$/iu;

export function providerKindOf(provider: ServerProvider): ProviderKind | null {
  switch (provider.driver) {
    case "claudeAgent":
      return "claude";
    case "codex":
      return "codex";
    case "grok":
      return "grok";
    case "antigravity":
      return "gemini";
  }
  const name =
    `${provider.driver} ${provider.instanceId} ${provider.displayName ?? ""}`.toLowerCase();
  if (name.includes("copilot")) return "copilot";
  if (name.includes("gemini")) return "gemini";
  if (name.includes("grok")) return "grok";
  return null;
}

export interface ObservedThread {
  readonly providerInstanceId: string;
  readonly status: string;
  readonly lastErrorClass: string | null;
  readonly updatedAtMs: number;
}

export interface CoordinatorState {
  readonly projectTitle: string;
  readonly status: string | null;
  readonly lastErrorClass: string | null;
}

export type TailscaleState =
  | { readonly state: "running"; readonly dnsName: string | null }
  | { readonly state: "unavailable" };

export interface StatusInputs {
  readonly now: number;
  readonly serverVersion: string;
  readonly startedAt: number;
  readonly databaseOk: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly threads: ReadonlyArray<ObservedThread>;
  readonly coordinators: ReadonlyArray<CoordinatorState>;
  readonly fleet: StudioFleetSnapshot | null;
  readonly tailscale: TailscaleState | null;
  readonly feeds: Partial<Record<FeedId, FeedReading>>;
  /** null when not checked yet. */
  readonly releaseFeedReachable: boolean | null;
  /** The external health watch's last report; absent or null when none is written. */
  readonly healthWatch?: HealthWatchReading | null;
}

/**
 * `<baseDir>/health/latest.json`, written every few minutes by
 * `scripts/studio-fleet/fleet_health.py --write` from a LaunchAgent. It reads
 * what this process cannot see about itself: an update hold left behind, a
 * failed install, failed user-facing RPCs and warning floods.
 */
export interface HealthWatchReading {
  readonly status: "ok" | "degraded" | "down";
  readonly checkedAtMs: number;
  readonly problems: ReadonlyArray<string>;
}

/** A report older than this no longer speaks for the service. */
export const HEALTH_WATCH_STALE_MS = 15 * 60_000;

export function decodeHealthWatch(raw: unknown): HealthWatchReading | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { status, checkedAt, problems } = raw as Record<string, unknown>;
  const checkedAtMs = typeof checkedAt === "string" ? Date.parse(checkedAt) : Number.NaN;
  if (
    (status !== "ok" && status !== "degraded" && status !== "down") ||
    !Number.isFinite(checkedAtMs)
  ) {
    return null;
  }
  return {
    status,
    checkedAtMs,
    problems: Array.isArray(problems)
      ? problems.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function healthWatchComponent(reading: HealthWatchReading, now: number): StatusComponent {
  const age = formatDuration(Math.max(0, now - reading.checkedAtMs));
  if (now - reading.checkedAtMs > HEALTH_WATCH_STALE_MS) {
    return component("health-watch", "Health watch", "unknown", `Last report ${age} ago.`);
  }
  if (reading.status === "ok") {
    return component("health-watch", "Health watch", "operational", `Checked ${age} ago.`);
  }
  return component(
    "health-watch",
    "Health watch",
    reading.status === "down" ? "partial_outage" : "degraded",
    reading.problems.length > 0 ? reading.problems.join("; ") : `Reported ${reading.status}.`,
  );
}

export interface BuiltService {
  readonly id: string;
  readonly group: StatusServiceGroup;
  readonly name: string;
  readonly level: StatusLevel;
  readonly detail: string;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly dependents: ReadonlyArray<string>;
  readonly components: ReadonlyArray<StatusComponent>;
  /** This host's own checks decide the level, so it opens local incidents. */
  readonly tracksIncidents: boolean;
}

export const OBSERVED_WINDOW_MS = 60 * 60 * 1000;

/** Which feeds the next check needs, given what is configured. */
export function neededFeeds(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly showTailscale: boolean;
}): ReadonlyArray<FeedId> {
  const feeds = new Set<FeedId>(["github"]);
  for (const kind of configuredProviderKinds(input.providers)) feeds.add(PROVIDERS[kind].feed);
  if (input.showTailscale) feeds.add("tailscale");
  return [...feeds];
}

export function configuredProviderKinds(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderKind> {
  const kinds = new Set<ProviderKind>();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    const kind = providerKindOf(provider);
    if (kind !== null) kinds.add(kind);
  }
  return (Object.keys(PROVIDERS) as Array<ProviderKind>).filter((kind) => kinds.has(kind));
}

function formatDuration(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.floor(hours / 24)} days`;
}

const component = (
  id: string,
  name: string,
  level: StatusLevel,
  detail: string | null = null,
): StatusComponent => ({ id, name, level, detail });

/** The worst known component decides; unknown only when nothing is known. */
function levelOf(components: ReadonlyArray<StatusComponent>): StatusLevel {
  const known = components.filter((entry) => entry.level !== "unknown");
  return rollupStatusLevels(known.length > 0 ? known.map((entry) => entry.level) : ["unknown"]);
}

function detailOf(components: ReadonlyArray<StatusComponent>, healthyDetail: string) {
  const level = levelOf(components);
  if (level === "operational") return healthyDetail;
  const worst = components.find((entry) => entry.level === level);
  return worst ? `${worst.name}: ${worst.detail ?? "not operational"}` : healthyDetail;
}

function publicComponent(
  feed: FeedReading | undefined,
  feedId: FeedId,
  name = "Public status",
): StatusComponent {
  if (feed === undefined) return component(`public:${feedId}`, name, "unknown", "Not checked yet.");
  return component(
    `public:${feedId}`,
    name,
    feed.level,
    feed.level === "operational" ? FEEDS[feedId].label : feed.detail,
  );
}

function providerInstanceComponent(provider: ServerProvider): StatusComponent {
  const id = `instance:${provider.instanceId}`;
  const name = provider.displayName ?? provider.instanceId;
  if (provider.availability === "unavailable") {
    return component(id, name, "unknown", provider.unavailableReason ?? "Driver unavailable.");
  }
  if (!provider.installed) return component(id, name, "degraded", "Not installed on this Mac.");
  if (provider.status === "error") {
    return component(id, name, "partial_outage", provider.message ?? "Provider check failed.");
  }
  if (provider.auth.status === "unauthenticated")
    return component(id, name, "degraded", "Signed out.");
  const limits = provider.usageLimits;
  if (limits?.rateLimitReachedType || limits?.ordinaryUsageAllowed === false) {
    return component(id, name, "degraded", "Usage limit reached.");
  }
  if (provider.status === "warning") {
    return component(id, name, "degraded", provider.message ?? "Provider reported a warning.");
  }
  return component(
    id,
    name,
    "operational",
    provider.version ? `Version ${provider.version}` : null,
  );
}

function observedComponent(
  kind: ProviderKind,
  instanceIds: ReadonlySet<string>,
  input: StatusInputs,
): StatusComponent {
  let errors = 0;
  let limits = 0;
  for (const thread of input.threads) {
    if (!instanceIds.has(thread.providerInstanceId)) continue;
    if (thread.status !== "failed" || input.now - thread.updatedAtMs > OBSERVED_WINDOW_MS) continue;
    if (thread.lastErrorClass === "usage_limit") limits += 1;
    else if (
      thread.lastErrorClass === "provider_error" ||
      thread.lastErrorClass === "transport_error"
    )
      errors += 1;
  }
  const parts = [
    errors > 0 ? `${errors} thread${errors === 1 ? "" : "s"} failed with provider errors` : null,
    limits > 0 ? `${limits} thread${limits === 1 ? "" : "s"} hit a usage limit` : null,
  ].filter((part): part is string => part !== null);
  return component(
    `observed:${kind}`,
    "Errors seen in this app (last hour)",
    errors >= 3 ? "partial_outage" : errors > 0 || limits > 0 ? "degraded" : "operational",
    parts.length > 0 ? `${parts.join(", ")}.` : "None.",
  );
}

/** A shared feed's incidents that belong to `serviceId`: Copilot and GitHub share one. */
function incidentsFor(serviceId: string, feed: FeedReading | undefined) {
  return (feed?.incidents ?? []).filter((incident) => {
    if (serviceId === "provider:copilot") return /copilot/iu.test(incident.title);
    if (serviceId === "github") return !/copilot/iu.test(incident.title);
    return true;
  });
}

export function buildStatusServices(input: StatusInputs): ReadonlyArray<BuiltService> {
  const services: Array<BuiltService> = [];

  const localComponents = [
    component("ws", "WebSocket API", "operational", "Serving this window."),
    component(
      "database",
      "Local database",
      input.databaseOk ? "operational" : "major_outage",
      input.databaseOk ? null : "The state database did not answer.",
    ),
    component("mcp", "MCP endpoint", "operational", "Served at /mcp for agent tools."),
    ...(input.healthWatch ? [healthWatchComponent(input.healthWatch, input.now)] : []),
  ];
  services.push({
    id: "local-service",
    group: "app",
    name: "Local service",
    level: levelOf(localComponents),
    detail: detailOf(
      localComponents,
      `SpecWithCode ${input.serverVersion} · up ${formatDuration(input.now - input.startedAt)}`,
    ),
    source: "This Mac",
    sourceUrl: null,
    dependents: ["Every thread and window", "Scheduled tasks", "MCP tools for agents"],
    components: localComponents,
    tracksIncidents: true,
  });

  const coordinatorComponents =
    input.coordinators.length === 0
      ? [component("coordinators:none", "Project coordinators", "operational", "None running.")]
      : input.coordinators.map((coordinator, index) =>
          component(
            `coordinator:${index}`,
            coordinator.projectTitle,
            coordinator.status === "failed"
              ? coordinator.lastErrorClass === "usage_limit"
                ? "degraded"
                : "partial_outage"
              : "operational",
            coordinator.status === "failed"
              ? coordinator.lastErrorClass === "usage_limit"
                ? "Coordinator stopped at a usage limit."
                : "Coordinator's last turn failed."
              : coordinator.status === null
                ? "Not started."
                : `Coordinator ${coordinator.status}.`,
          ),
        );
  services.push({
    id: "coordinators",
    group: "app",
    name: "MCP and coordinators",
    level: levelOf(coordinatorComponents),
    detail: detailOf(
      coordinatorComponents,
      input.coordinators.length === 0
        ? "MCP endpoint ready; no project coordinators."
        : `${input.coordinators.length} project coordinator${input.coordinators.length === 1 ? "" : "s"} healthy.`,
    ),
    source: "This Mac",
    sourceUrl: null,
    dependents: ["Project coordinators", "Delegated tasks", "Scheduled task runs"],
    components: coordinatorComponents,
    tracksIncidents: true,
  });

  const github = input.feeds.github;
  const githubApi = github?.components.find((entry) => entry.name === "API Requests");
  const updateComponents = [
    component(
      "release-feed",
      "Release feed",
      input.releaseFeedReachable === null
        ? "unknown"
        : input.releaseFeedReachable
          ? "operational"
          : "partial_outage",
      input.releaseFeedReachable === null
        ? "Not checked yet."
        : input.releaseFeedReachable
          ? "github.com/anton-abyzov/specwithcode"
          : "Could not reach the release feed.",
    ),
    githubApi
      ? { ...githubApi, id: "github-api", name: "GitHub API" }
      : component("github-api", "GitHub API", "unknown", github?.detail ?? "Not checked yet."),
  ];
  services.push({
    id: "updates",
    group: "app",
    name: "Updates",
    level: levelOf(updateComponents),
    detail: detailOf(updateComponents, "Release feed reachable."),
    source: "github.com",
    sourceUrl: "https://github.com/anton-abyzov/specwithcode/releases",
    dependents: ["App updates", "Service updates on paired machines"],
    components: updateComponents,
    tracksIncidents: true,
  });

  for (const machine of input.fleet?.machines ?? []) {
    const label = machine.machineName ?? machine.label;
    const level: StatusLevel =
      machine.status === "reachable"
        ? "operational"
        : machine.status === "identity-mismatch"
          ? "degraded"
          : "major_outage";
    const detail =
      machine.status === "reachable"
        ? `Reachable at ${machine.url}`
        : machine.status === "identity-mismatch"
          ? "Answered as a different machine."
          : "Unreachable over its private connection.";
    services.push({
      id: `machine:${machine.id}`,
      group: "machines",
      name: label,
      level,
      detail,
      source: "Private fleet",
      sourceUrl: null,
      dependents: [`Workers on ${label}`, `Handoffs to ${label}`],
      components: [
        component("identity", "Identity check", level, detail),
        component(
          "pairing",
          "Pairing",
          machine.pairingConfigured ? "operational" : "unknown",
          machine.pairingConfigured ? null : "No management token configured.",
        ),
      ],
      tracksIncidents: true,
    });
  }

  if (
    input.tailscale !== null &&
    (input.tailscale.state === "running" || (input.fleet?.machines.length ?? 0) > 0)
  ) {
    const local = component(
      "tailscale:local",
      "Tailscale on this Mac",
      input.tailscale.state === "running" ? "operational" : "degraded",
      input.tailscale.state === "running"
        ? (input.tailscale.dnsName ?? "Connected")
        : "Tailscale is not running or not installed.",
    );
    const tailscaleComponents = [local, publicComponent(input.feeds.tailscale, "tailscale")];
    services.push({
      id: "tailscale",
      group: "machines",
      name: "Tailscale",
      level: levelOf(tailscaleComponents),
      detail: detailOf(tailscaleComponents, "Connected to the tailnet."),
      source: "This Mac and status.tailscale.com",
      sourceUrl: FEEDS.tailscale.pageUrl,
      dependents: ["Remote machines", "Phone and browser access over Tailscale"],
      components: tailscaleComponents,
      tracksIncidents: false,
    });
  }

  for (const kind of configuredProviderKinds(input.providers)) {
    const definition = PROVIDERS[kind];
    const instances = input.providers.filter(
      (provider) => provider.enabled && providerKindOf(provider) === kind,
    );
    const feed = input.feeds[definition.feed];
    const publicComponents =
      feed && definition.components
        ? feed.components.filter((entry) => definition.components!.test(entry.name))
        : [];
    const openIncidents = incidentsFor(`provider:${kind}`, feed).filter(
      (incident) => incident.resolvedAt === null,
    );
    const publicLevel =
      feed === undefined || feed.level === "unknown"
        ? "unknown"
        : definition.components
          ? rollupStatusLevels([
              ...publicComponents.map((entry) => entry.level),
              ...openIncidents.map((incident) => incident.level),
              "operational",
            ])
          : feed.level;
    const publicStatus = publicComponent(feed, definition.feed);
    const components = [
      {
        ...publicStatus,
        level: publicLevel,
        detail:
          publicLevel === "operational" || publicLevel === "unknown"
            ? publicStatus.detail
            : (openIncidents[0]?.title ??
              publicComponents.find((entry) => entry.level === publicLevel)?.name ??
              publicStatus.detail),
      },
      ...instances.map(providerInstanceComponent),
      observedComponent(kind, new Set(instances.map((provider) => provider.instanceId)), input),
    ];
    services.push({
      id: `provider:${kind}`,
      group: "dependencies",
      name: definition.name,
      level: levelOf(components),
      detail: detailOf(
        components,
        publicLevel === "unknown"
          ? "Sign-in and recent turns look healthy; public status unavailable."
          : "Public status, this Mac's sign-in and recent turns all look healthy.",
      ),
      source: FEEDS[definition.feed].label,
      sourceUrl: FEEDS[definition.feed].pageUrl,
      dependents: definition.dependents,
      components: [
        ...components,
        ...publicComponents.map((entry) => ({ ...entry, id: `${entry.id}:${kind}` })),
      ],
      tracksIncidents: false,
    });
  }

  const githubComponents = github
    ? github.components.filter((entry) => GITHUB_COMPONENTS.test(entry.name))
    : [];
  const githubLevel =
    github === undefined || github.level === "unknown"
      ? "unknown"
      : rollupStatusLevels([
          ...githubComponents.map((entry) => entry.level),
          ...incidentsFor("github", github)
            .filter((incident) => incident.resolvedAt === null)
            .map((incident) => incident.level),
          "operational",
        ]);
  services.push({
    id: "github",
    group: "dependencies",
    name: "GitHub",
    level: githubLevel,
    detail:
      github === undefined
        ? "Not checked yet."
        : githubLevel === "operational"
          ? "Git, API and pull requests operational."
          : detailOf(githubComponents, github.detail),
    source: FEEDS.github.label,
    sourceUrl: FEEDS.github.pageUrl,
    dependents: ["Code Review and pull requests", "Clone and publish", "App updates"],
    components:
      githubComponents.length > 0 ? githubComponents : [publicComponent(github, "github")],
    tracksIncidents: false,
  });

  return services;
}

/** Public incidents for the services shown, re-keyed to the service ids. */
export function publicIncidents(
  services: ReadonlyArray<BuiltService>,
  feeds: Partial<Record<FeedId, FeedReading>>,
): ReadonlyArray<StatusIncident> {
  const incidents: Array<StatusIncident> = [];
  for (const service of services) {
    let feedId: FeedId | null = null;
    if (service.id === "github") feedId = "github";
    else if (service.id === "tailscale") feedId = "tailscale";
    else if (service.id.startsWith("provider:")) {
      feedId = PROVIDERS[service.id.slice("provider:".length) as ProviderKind].feed;
    }
    if (feedId === null) continue;
    for (const incident of incidentsFor(service.id, feeds[feedId])) {
      incidents.push({ ...incident, id: `${service.id}:${incident.id}`, serviceId: service.id });
    }
  }
  return incidents;
}

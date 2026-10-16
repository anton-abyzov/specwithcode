// @effect-diagnostics globalDate:off - pure parsers turn feed timestamps into ISO strings.
/**
 * Public provider status feeds, read in the background by the status monitor.
 *
 * Claude, OpenAI, GitHub and Tailscale publish Atlassian Statuspage JSON;
 * Google publishes a Cloud incidents list and xAI an RSS feed. Parsers are
 * pure and tolerant: anything they cannot read becomes "unknown", never a
 * thrown error.
 */
import {
  rollupStatusLevels,
  type StatusComponent,
  type StatusIncident,
  type StatusIncidentStage,
  type StatusLevel,
} from "@specweave-studio/contracts";

export const FEED_TIMEOUT_MS = 8_000;
const FEED_MAX_BYTES = 2_000_000;

export interface FeedReading {
  readonly level: StatusLevel;
  readonly detail: string;
  readonly components: ReadonlyArray<StatusComponent>;
  readonly incidents: ReadonlyArray<StatusIncident>;
}

export const unavailableFeed = (detail: string): FeedReading => ({
  level: "unknown",
  detail,
  components: [],
  incidents: [],
});

/** GET `url` as text with a timeout and size cap; null when offline or failing. */
export async function fetchFeedText(
  url: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json, application/rss+xml, text/xml;q=0.9, */*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await response.text();
    return text.length > FEED_MAX_BYTES ? null : text;
  } catch {
    return null;
  }
}

/** HEAD `url`; false when offline or failing. */
export async function isReachable(
  url: string,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const iso = (value: unknown): string | null => {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 60);

const STATUSPAGE_COMPONENT_LEVELS: Record<string, StatusLevel> = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "partial_outage",
  major_outage: "major_outage",
  under_maintenance: "maintenance",
};

const STATUSPAGE_IMPACT_LEVELS: Record<string, StatusLevel> = {
  none: "degraded",
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
  maintenance: "maintenance",
};

const incidentStage = (value: unknown): StatusIncidentStage => {
  switch (value) {
    case "identified":
    case "monitoring":
    case "resolved":
      return value;
    case "postmortem":
    case "completed":
      return "resolved";
    default:
      return "investigating";
  }
};

/**
 * Reads a Statuspage `summary.json`. `include` picks the components that
 * matter to the app; incidents are kept when they touch one of them or name
 * no component at all.
 */
export function parseStatuspageSummary(
  raw: string | null,
  options: {
    readonly serviceId: string;
    readonly pageUrl: string;
    readonly include: (componentName: string) => boolean;
  },
): FeedReading {
  if (raw === null) return unavailableFeed("Public status page unreachable.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return unavailableFeed("Public status page sent an unreadable response.");
  }
  if (!record(json) || !Array.isArray(json.components)) {
    return unavailableFeed("Public status page sent an unexpected response.");
  }
  const seen = new Set<string>();
  const components: Array<StatusComponent> = [];
  const includedIds = new Set<string>();
  for (const component of json.components) {
    if (!record(component) || component.group === true) continue;
    const name = text(component.name);
    if (name === null || !options.include(name) || seen.has(name)) continue;
    seen.add(name);
    if (typeof component.id === "string") includedIds.add(component.id);
    const level = STATUSPAGE_COMPONENT_LEVELS[String(component.status)] ?? "unknown";
    components.push({
      id: `public:${slug(name)}`,
      name,
      level,
      detail: level === "operational" ? null : String(component.status).replaceAll("_", " "),
    });
  }
  const incidents: Array<StatusIncident> = [];
  for (const incident of Array.isArray(json.incidents) ? json.incidents : []) {
    if (!record(incident)) continue;
    const title = text(incident.name);
    const startedAt = iso(incident.started_at) ?? iso(incident.created_at);
    if (title === null || startedAt === null) continue;
    const touched = Array.isArray(incident.components)
      ? incident.components.filter(record).map((component) => component.id)
      : [];
    if (touched.length > 0 && !touched.some((id) => includedIds.has(String(id)))) continue;
    const stage = incidentStage(incident.status);
    incidents.push({
      id: `${options.serviceId}:${String(incident.id ?? slug(title))}`,
      serviceId: options.serviceId,
      title,
      level: STATUSPAGE_IMPACT_LEVELS[String(incident.impact)] ?? "degraded",
      stage,
      origin: "public",
      startedAt,
      updatedAt: iso(incident.updated_at) ?? startedAt,
      resolvedAt: stage === "resolved" ? (iso(incident.resolved_at) ?? startedAt) : null,
      url: text(incident.shortlink) ?? options.pageUrl,
    });
  }
  const openIncidents = incidents.filter((incident) => incident.resolvedAt === null);
  const level = rollupStatusLevels([
    ...(components.length > 0 ? components.map((component) => component.level) : ["operational"]),
    ...openIncidents.map((incident) => incident.level),
  ] as ReadonlyArray<StatusLevel>);
  const affected = components.filter((component) => component.level !== "operational");
  return {
    level,
    detail:
      openIncidents.length > 0
        ? openIncidents[0]!.title
        : affected.length > 0
          ? `${affected.map((component) => component.name).join(", ")} reported ${affected[0]!.detail ?? "issues"}.`
          : "All tracked components operational.",
    components,
    incidents,
  };
}

const GOOGLE_SEVERITY_LEVELS: Record<string, StatusLevel> = {
  low: "degraded",
  medium: "partial_outage",
  high: "major_outage",
};

/** Reads Google Cloud's `incidents.json`, keeping incidents on matching products. */
export function parseGoogleCloudIncidents(
  raw: string | null,
  options: {
    readonly serviceId: string;
    readonly pageUrl: string;
    readonly product: RegExp;
    readonly now: number;
    readonly lookbackMs: number;
  },
): FeedReading {
  if (raw === null) return unavailableFeed("Public status page unreachable.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return unavailableFeed("Public status page sent an unreadable response.");
  }
  if (!Array.isArray(json))
    return unavailableFeed("Public status page sent an unexpected response.");
  const incidents: Array<StatusIncident> = [];
  for (const incident of json) {
    if (!record(incident)) continue;
    const products = Array.isArray(incident.affected_products)
      ? incident.affected_products.filter(record).flatMap((product) => text(product.title) ?? [])
      : [];
    if (!products.some((product) => options.product.test(product))) continue;
    const startedAt = iso(incident.begin) ?? iso(incident.created);
    if (startedAt === null) continue;
    const resolvedAt = iso(incident.end);
    if (resolvedAt !== null && options.now - Date.parse(resolvedAt) > options.lookbackMs) continue;
    incidents.push({
      id: `${options.serviceId}:${String(incident.id ?? startedAt)}`,
      serviceId: options.serviceId,
      title: (text(incident.external_desc) ?? products.join(", ")).slice(0, 240),
      level: GOOGLE_SEVERITY_LEVELS[String(incident.severity)] ?? "degraded",
      stage: resolvedAt === null ? "investigating" : "resolved",
      origin: "public",
      startedAt,
      updatedAt: iso(incident.modified) ?? startedAt,
      resolvedAt,
      url:
        typeof incident.uri === "string"
          ? `https://status.cloud.google.com/${incident.uri}`
          : options.pageUrl,
    });
  }
  const open = incidents.filter((incident) => incident.resolvedAt === null);
  return {
    level: rollupStatusLevels(
      open.length > 0 ? open.map((incident) => incident.level) : ["operational"],
    ),
    detail: open.length > 0 ? open[0]!.title : "No open incidents on Gemini products.",
    components: [],
    incidents,
  };
}

const XAI_SEVERITY_LEVELS: Record<string, StatusLevel> = {
  outage: "major_outage",
  disruption: "partial_outage",
  degraded: "degraded",
  maintenance: "maintenance",
};

const decodeXml = (value: string) =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .trim();
const tag = (item: string, name: string) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "u").exec(item);
  return match ? decodeXml(match[1]!) : null;
};

/** Reads xAI's status RSS: each item is an incident with a status and severity. */
export function parseXaiStatusRss(
  raw: string | null,
  options: {
    readonly serviceId: string;
    readonly pageUrl: string;
    readonly now: number;
    readonly lookbackMs: number;
  },
): FeedReading {
  if (raw === null) return unavailableFeed("Public status page unreachable.");
  if (!raw.includes("<rss") && !raw.includes("<channel")) {
    return unavailableFeed("Public status page sent an unexpected response.");
  }
  const incidents: Array<StatusIncident> = [];
  for (const match of raw.matchAll(/<item>([\s\S]*?)<\/item>/gu)) {
    const item = match[1]!;
    const title = tag(item, "title");
    const startedAt = iso(tag(item, "pubDate"));
    if (title === null || startedAt === null) continue;
    const description = tag(item, "description") ?? "";
    const categories = [...item.matchAll(/<category>([\s\S]*?)<\/category>/gu)].map((category) =>
      decodeXml(category[1]!).toLowerCase(),
    );
    const resolved = categories.includes("resolved") || /Status:\s*RESOLVED/iu.test(description);
    const resolvedAt = resolved
      ? (iso(/Resolved:\s*([^<]+)/u.exec(description)?.[1]) ?? startedAt)
      : null;
    if (resolvedAt !== null && options.now - Date.parse(resolvedAt) > options.lookbackMs) continue;
    const severity = /Severity:\s*([a-z]+)/iu.exec(description)?.[1]?.toLowerCase();
    incidents.push({
      id: `${options.serviceId}:${tag(item, "guid") ?? slug(title)}`,
      serviceId: options.serviceId,
      title: title.slice(0, 240),
      level:
        XAI_SEVERITY_LEVELS[severity ?? ""] ??
        XAI_SEVERITY_LEVELS[categories.find((category) => category in XAI_SEVERITY_LEVELS) ?? ""] ??
        "degraded",
      stage: resolved ? "resolved" : "investigating",
      origin: "public",
      startedAt,
      updatedAt: resolvedAt ?? startedAt,
      resolvedAt,
      url: tag(item, "link") ?? options.pageUrl,
    });
  }
  const open = incidents.filter((incident) => incident.resolvedAt === null);
  return {
    level: rollupStatusLevels(
      open.length > 0 ? open.map((incident) => incident.level) : ["operational"],
    ),
    detail: open.length > 0 ? open[0]!.title : "No open incidents.",
    components: [],
    incidents,
  };
}

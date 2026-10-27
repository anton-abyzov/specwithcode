import { sha256 } from "@noble/hashes/sha2";

/**
 * Managed SpecWithCode Connect endpoints. The relay names each tunnel host
 * `<slug(namespace)>-<sha256(namespace:userId:environmentId)[0..16]>.<baseDomain>`
 * (infra/relay/src/deploymentConfig.ts). The relay's own host (`relay.<base>`)
 * lives in the same zone, so a plain suffix match is not enough: a managed host
 * is exactly one label of that shape directly above the base domain.
 */
export const DEFAULT_MANAGED_ENDPOINT_BASE_DOMAIN = "spec-weave.com";
export const MANAGED_ENDPOINT_HASH_LENGTH = 16;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MANAGED_LABEL = new RegExp(
  `^([a-z0-9](?:[a-z0-9-]{0,45}[a-z0-9])?)-([0-9a-f]{${MANAGED_ENDPOINT_HASH_LENGTH}})$`,
);

function isDnsName(name: string): boolean {
  return (
    name.length > 0 && name.length <= 253 && name.split(".").every((label) => DNS_LABEL.test(label))
  );
}

/** `relay.<base>` or `relay-<stage>.<base>` gives `<base>`; null otherwise or when fewer than 2 labels remain. */
export function managedEndpointBaseDomainFromRelayUrl(relayUrl: string): string | null {
  let hostname: string;
  try {
    const url = new URL(relayUrl);
    if (url.protocol !== "https:") return null;
    hostname = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  const [first, ...rest] = hostname.split(".");
  if (first === undefined || !/^relay(?:-[a-z0-9-]+)?$/.test(first)) return null;
  const base = rest.join(".");
  return rest.length >= 2 && isAcceptableManagedBaseDomain(base) ? base : null;
}

/** Second-level labels registries hand out to the public (`co.uk`, `com.au`, …). */
const PUBLIC_SECOND_LEVEL = new Set([
  "ac",
  "biz",
  "co",
  "com",
  "edu",
  "gen",
  "go",
  "gob",
  "gov",
  "gv",
  "info",
  "ltd",
  "me",
  "mil",
  "ne",
  "net",
  "nom",
  "or",
  "org",
  "plc",
  "sch",
]);
/** Shared hosting suffixes where anyone can register a name directly below. */
const SHARED_HOSTING_SUFFIXES = new Set([
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "firebaseapp.com",
  "fly.dev",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "netlify.app",
  "ngrok-free.app",
  "ngrok.io",
  "onrender.com",
  "pages.dev",
  "trycloudflare.com",
  "ts.net",
  "vercel.app",
  "web.app",
  "workers.dev",
]);

/**
 * Whether `name` may serve as a managed base domain: a valid DNS name of at
 * least two labels that is not a public suffix anyone can register under
 * (`co.uk`, `github.io`), since every single label directly above it then
 * counts as a SpecWithCode Connect address.
 */
export function isAcceptableManagedBaseDomain(name: string): boolean {
  if (!isDnsName(name)) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  if (SHARED_HOSTING_SUFFIXES.has(name)) return false;
  return !(labels.length === 2 && PUBLIC_SECOND_LEVEL.has(labels[0]!));
}

/** Env STUDIO_MANAGED_ENDPOINT_BASE_DOMAIN (an acceptable base domain) wins, then the relay URL, then the default. */
export function resolveManagedEndpointBaseDomain(input: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly relayUrl?: string | undefined;
}): string {
  const override = input.env?.STUDIO_MANAGED_ENDPOINT_BASE_DOMAIN?.trim().toLowerCase();
  if (override && isAcceptableManagedBaseDomain(override)) return override;
  const derived = input.relayUrl ? managedEndpointBaseDomainFromRelayUrl(input.relayUrl) : null;
  return derived ?? DEFAULT_MANAGED_ENDPOINT_BASE_DOMAIN;
}

/** The managed label's slug prefix and hash, or null when `hostname` is not exactly one managed label above `baseDomain`. */
export function splitManagedEndpointLabel(
  hostname: string,
  baseDomain: string,
): { readonly prefix: string; readonly hash: string } | null {
  const base = baseDomain.toLowerCase();
  if (!isDnsName(base) || !isDnsName(hostname) || hostname !== hostname.toLowerCase()) return null;
  if (!hostname.endsWith(`.${base}`)) return null;
  const label = hostname.slice(0, hostname.length - base.length - 1);
  if (label.includes(".")) return null;
  const match = MANAGED_LABEL.exec(label);
  return match ? { prefix: match[1]!, hash: match[2]! } : null;
}

/** Exactly one label `<slug>-<16 hex>` directly above `baseDomain`, lowercase, no trailing dot. */
export function isManagedEndpointHostname(hostname: string, baseDomain: string): boolean {
  return splitManagedEndpointLabel(hostname, baseDomain) !== null;
}

/** The relay's hostname hash: sha256(`namespace:userId:environmentId`) as hex, first 16 characters. */
export function managedEndpointHashFor(
  namespace: string,
  userId: string,
  environmentId: string,
): string {
  const digest = sha256(new TextEncoder().encode(`${namespace}:${userId}:${environmentId}`));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, MANAGED_ENDPOINT_HASH_LENGTH);
}

/** Lowercase, dash-collapsed slug, matching the relay's stage slug. */
export function managedEndpointSlug(namespace: string): string {
  return namespace
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

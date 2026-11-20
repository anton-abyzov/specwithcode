/**
 * The one place a team usage request is shaped (0898 AC-02, AC-04): HTTPS
 * only, the member's verified-skill.com token only to verified-skill.com, a
 * self-hosted endpoint only with its own credential, and a body that is
 * refused unless every key is on the summary allowlist.
 *
 * @module teamUsage/teamUsageTransport
 */
import {
  TEAM_USAGE_HOSTED_ORIGIN,
  type TeamUsageEndpoint,
  type TeamUsageSummary,
  teamUsageSummaryExtraKeys,
} from "@specweave-studio/contracts";

export interface TeamUsageRequest {
  readonly method: "POST" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type TeamUsageRequestResult =
  | { readonly ok: true; readonly request: TeamUsageRequest }
  | { readonly ok: false; readonly reason: string };

export interface TeamUsageCredentials {
  /** The member's `vsk_` token; used for the hosted endpoint only. */
  readonly hostedToken: string | undefined;
  /** The bearer credential the member stored for a self-hosted endpoint. */
  readonly selfHostedCredential: string | undefined;
}

const VSK_TOKEN = /^vsk_[A-Za-z0-9_-]+$/;
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The summaries URL of an endpoint, or a reason it is refused. */
export function teamUsageEndpointUrl(
  endpoint: TeamUsageEndpoint,
): { readonly url: URL } | { readonly reason: string } {
  if (endpoint.kind === "hosted") {
    // A tenant id is one path segment; "..", "/" or "?" would leave the summaries route.
    if (!TENANT_ID.test(endpoint.tenantId)) return { reason: "Pick your org again." };
    const url = new URL(
      `/api/v1/tenants/${encodeURIComponent(endpoint.tenantId)}/usage-summaries`,
      TEAM_USAGE_HOSTED_ORIGIN,
    );
    return { url };
  }
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    return { reason: "The team endpoint is not a valid address." };
  }
  if (url.protocol !== "https:") return { reason: "The team endpoint must use https://." };
  if (url.username !== "" || url.password !== "")
    return { reason: "Put the credential in its own field, not in the address." };
  if (url.origin === TEAM_USAGE_HOSTED_ORIGIN)
    return { reason: "Pick the hosted team view for verified-skill.com." };
  return { url };
}

function credentialHeader(
  endpoint: TeamUsageEndpoint,
  credentials: TeamUsageCredentials,
): { readonly header: string } | { readonly reason: string } {
  if (endpoint.kind === "hosted") {
    const token = credentials.hostedToken?.trim();
    if (!token || !VSK_TOKEN.test(token))
      return { reason: "Sign in with `vskill auth login` to send to your team." };
    return { header: `Bearer ${token}` };
  }
  const credential = credentials.selfHostedCredential?.trim();
  if (!credential) return { reason: "Add the self-hosted endpoint's credential." };
  if (VSK_TOKEN.test(credential))
    return { reason: "A verified-skill.com token is never sent to another host." };
  return { header: `Bearer ${credential}` };
}

export function teamUsageSendRequest(
  endpoint: TeamUsageEndpoint,
  credentials: TeamUsageCredentials,
  summary: TeamUsageSummary,
): TeamUsageRequestResult {
  const target = teamUsageEndpointUrl(endpoint);
  if ("reason" in target) return { ok: false, reason: target.reason };
  const auth = credentialHeader(endpoint, credentials);
  if ("reason" in auth) return { ok: false, reason: auth.reason };
  const extra = teamUsageSummaryExtraKeys(summary);
  if (extra.length > 0)
    return { ok: false, reason: `Refused to send fields outside the list: ${extra.join(", ")}` };
  return {
    ok: true,
    request: {
      method: "POST",
      url: target.url.toString(),
      headers: { Authorization: auth.header, "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    },
  };
}

/** Removes every summary this machine label sent (opt-out, AC-01). */
export function teamUsageDeleteRequest(
  endpoint: TeamUsageEndpoint,
  credentials: TeamUsageCredentials,
  machineLabel: string,
): TeamUsageRequestResult {
  const target = teamUsageEndpointUrl(endpoint);
  if ("reason" in target) return { ok: false, reason: target.reason };
  const auth = credentialHeader(endpoint, credentials);
  if ("reason" in auth) return { ok: false, reason: auth.reason };
  const url = new URL(target.url);
  url.searchParams.set("machineLabel", machineLabel);
  return {
    ok: true,
    request: { method: "DELETE", url: url.toString(), headers: { Authorization: auth.header } },
  };
}

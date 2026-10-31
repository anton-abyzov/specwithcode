#!/usr/bin/env node
// Adds the relay's edge rules to the API zone: a WAF custom rule that blocks
// scanner paths and a rate-limiting rule for the relay API. Rules are matched
// by ref and appended or updated one at a time, so rules other services own in
// the same zone are never replaced. Webhook forwarding (/v1/hooks/) keeps its
// own per-endpoint limiter in the Worker and is excluded here.
//
// CLOUDFLARE_API_TOKEN needs Zone Read and Zone WAF Edit on the zone. `--dry-run` only reads.
//   node infra/relay/scripts/edge-rules.mjs --zone spec-weave.com --host relay.spec-weave.com

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const dryRun = args.includes("--dry-run");
const zoneName = option("zone", process.env.RELAY_API_ZONE_NAME);
const host = option(
  "host",
  process.env.RELAY_DOMAIN || (zoneName ? `relay.${zoneName}` : undefined),
);
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!zoneName || !host || !token) {
  console.error("Need --zone, --host (or RELAY_API_ZONE_NAME) and CLOUDFLARE_API_TOKEN.");
  process.exit(2);
}

const hostMatch = `http.host eq "${host}"`;
const RULES = [
  {
    phase: "http_request_firewall_custom",
    rule: {
      ref: "studio_relay_block_scanners",
      description: "Connect relay: block secret and CMS probes",
      expression: `(${hostMatch} and (ends_with(lower(http.request.uri.path), ".env") or lower(http.request.uri.path) contains "/.env" or starts_with(http.request.uri.path, "/.git") or ends_with(lower(http.request.uri.path), ".php") or lower(http.request.uri.path) contains "/wp-"))`,
      action: "block",
      enabled: true,
    },
  },
  {
    phase: "http_ratelimit",
    rule: {
      ref: "studio_relay_api_rate_limit",
      description: "Connect relay: per-IP limit on the API",
      expression: `(${hostMatch} and starts_with(http.request.uri.path, "/v1/") and not starts_with(http.request.uri.path, "/v1/hooks/"))`,
      action: "block",
      enabled: true,
      // A household or office shares one address; the busiest measured
      // address made about 100 relay calls an hour, so this only stops loops.
      ratelimit: {
        characteristics: ["ip.src", "cf.colo.id"],
        period: 60,
        requests_per_period: 300,
        mitigation_timeout: 60,
      },
    },
  },
];

async function api(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

const zones = await api(`/zones?name=${encodeURIComponent(zoneName)}`);
const zone = zones.body.result?.[0];
if (!zone) {
  console.error(
    `Zone ${zoneName} not found (HTTP ${zones.status}).`,
    JSON.stringify(zones.body.errors ?? []),
  );
  process.exit(1);
}
console.log(`Zone ${zone.name} (${zone.plan?.name ?? "unknown plan"})`);

let failed = false;
for (const { phase, rule } of RULES) {
  const entry = await api(`/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`);
  if (entry.status === 404) {
    if (dryRun) {
      console.log(`${phase}: no entrypoint yet; would create it with ${rule.ref}`);
      continue;
    }
    const created = await api(`/zones/${zone.id}/rulesets/phases/${phase}/entrypoint`, {
      method: "PUT",
      body: JSON.stringify({ rules: [rule] }),
    });
    report(phase, rule.ref, "created", created);
    continue;
  }
  if (entry.status !== 200) {
    report(phase, rule.ref, "read", entry);
    continue;
  }
  const ruleset = entry.body.result;
  const existing = (ruleset.rules ?? []).find((candidate) => candidate.ref === rule.ref);
  console.log(
    `${phase}: ${ruleset.rules?.length ?? 0} rules, ${existing ? "updating" : "adding"} ${rule.ref}`,
  );
  if (dryRun) continue;
  const result = existing
    ? await api(`/zones/${zone.id}/rulesets/${ruleset.id}/rules/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(rule),
      })
    : await api(`/zones/${zone.id}/rulesets/${ruleset.id}/rules`, {
        method: "POST",
        body: JSON.stringify(rule),
      });
  report(phase, rule.ref, existing ? "updated" : "added", result);
}
process.exit(failed ? 1 : 0);

function report(phase, ref, verb, result) {
  if (result.status >= 200 && result.status < 300 && result.body.success !== false) {
    console.log(`${phase}: ${ref} ${verb}`);
    return;
  }
  failed = true;
  console.error(
    `${phase}: ${ref} not ${verb} (HTTP ${result.status})`,
    JSON.stringify(result.body.errors ?? []),
  );
}

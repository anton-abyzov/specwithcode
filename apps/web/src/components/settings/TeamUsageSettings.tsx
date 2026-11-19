import { useTx } from "../../i18n";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  TEAM_USAGE_RPC_METHODS,
  type TeamUsageConfig,
  type TeamUsageEndpoint,
  type TeamUsageOrg,
  type TeamUsageStatus,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

/** 0898: the machine's team usage calls. Status and changes are the member's own (settings:write). */
export const teamUsage = {
  status: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "team-usage:status",
    tag: TEAM_USAGE_RPC_METHODS.teamUsageStatus,
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "team-usage:update",
    tag: TEAM_USAGE_RPC_METHODS.teamUsageUpdate,
  }),
  orgs: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "team-usage:orgs",
    tag: TEAM_USAGE_RPC_METHODS.teamUsageOrgs,
  }),
};

const failureText = (result: { _tag: string }, fallback: string) => {
  const cause = squashAtomCommandFailure(result as never);
  return cause instanceof Error && cause.message ? cause.message : fallback;
};

type Destination = "hosted" | "selfHosted";

/**
 * Opt-in to the team usage view (0898 AC-01, AC-04), per machine. Off until the
 * member turns it on here; the exact summary that would be sent is shown first.
 * Turning it off removes this machine's history from the team.
 */
export function TeamUsageSettings({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const tx = useTx();
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const options = { reportFailure: false } as const;
  const readStatus = useAtomCommand(teamUsage.status, options);
  const update = useAtomCommand(teamUsage.update, options);
  const readOrgs = useAtomCommand(teamUsage.orgs, options);
  const [status, setStatus] = useState<TeamUsageStatus | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<Destination>("hosted");
  const [orgs, setOrgs] = useState<readonly TeamUsageOrg[] | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [machineLabel, setMachineLabel] = useState("");

  const adopt = useCallback((next: TeamUsageStatus) => {
    setStatus(next);
    const endpoint = next.config.endpoint;
    if (endpoint?.kind === "selfHosted") {
      setDestination("selfHosted");
      setUrl(endpoint.url);
    } else if (endpoint?.kind === "hosted") {
      setDestination("hosted");
      setTenantId(endpoint.tenantId);
      if (endpoint.orgLabel)
        setOrgs(
          (current) => current ?? [{ tenantId: endpoint.tenantId, label: endpoint.orgLabel! }],
        );
    }
    setMachineLabel(next.config.machineLabel ?? "");
  }, []);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    void readStatus({ environmentId, input: {} }).then((result) => {
      if (!live) return;
      if (result._tag === "Success") adopt(result.value);
      else setUnsupported(true);
    });
    return () => {
      live = false;
    };
  }, [adopt, allowed, environmentId, readStatus]);

  if (!allowed) return null;
  if (unsupported)
    return (
      <p className="p-4 text-sm text-muted-foreground sm:p-5" data-slot="team-usage">
        {tx("{machine} needs a newer SpecWithCode to share usage with a team.", {
          machine: environmentLabel,
        })}
      </p>
    );
  if (status === null)
    return (
      <p className="p-4 text-sm text-muted-foreground sm:p-5" data-slot="team-usage">
        {tx("Reading team usage on {machine}…", { machine: environmentLabel })}
      </p>
    );

  const loadOrgs = async () => {
    setError(null);
    const result = await readOrgs({ environmentId, input: {} });
    if (result._tag !== "Success")
      return setError(failureText(result, "Could not list your orgs."));
    setOrgs(result.value.orgs);
    if (result.value.error) setError(result.value.error);
    if (result.value.orgs.length === 1) setTenantId(result.value.orgs[0]!.tenantId);
  };

  const endpoint = (): TeamUsageEndpoint | undefined => {
    if (destination === "selfHosted")
      return url.trim() ? { kind: "selfHosted", url: url.trim() } : undefined;
    const org = orgs?.find((entry) => entry.tenantId === tenantId);
    return tenantId
      ? { kind: "hosted", tenantId, ...(org ? { orgLabel: org.label } : {}) }
      : undefined;
  };

  const save = async (enabled: boolean) => {
    setError(null);
    const target = endpoint();
    if (enabled && target === undefined)
      return setError(
        destination === "hosted" ? "Pick your org first." : "Enter the team endpoint first.",
      );
    const { machineLabel: _label, endpoint: saved, ...rest } = status.config;
    const kept = target ?? saved;
    const config: TeamUsageConfig = {
      ...rest,
      enabled,
      ...(kept ? { endpoint: kept } : {}),
      ...(machineLabel.trim() ? { machineLabel: machineLabel.trim() } : {}),
    };
    setBusy(true);
    const result = await update({
      environmentId,
      input: { config, ...(credential.trim() ? { selfHostedCredential: credential.trim() } : {}) },
    });
    setBusy(false);
    if (result._tag !== "Success")
      return setError(failureText(result, "Could not save team usage."));
    setCredential("");
    adopt(result.value);
  };

  const enabled = status.config.enabled;
  return (
    <div className="space-y-4 p-4 text-sm sm:p-5" data-slot="team-usage">
      <label className="flex items-start justify-between gap-4">
        <span>
          <span className="block font-medium">{tx("Share daily usage with my team")}</span>
          <span className="block text-muted-foreground">
            {tx(
              "Off by default. When on, {machine} sends one small summary per hour at most: for each provider account, the label, plan, how much of each window is left, and how many limit hits, handoffs and provider switches it had today. Never prompts, code, file names, project names or credentials.",
              { machine: environmentLabel },
            )}
          </span>
        </span>
        <Switch
          aria-label={tx("Share daily usage with my team")}
          checked={enabled}
          disabled={busy}
          onCheckedChange={(checked) => void save(checked === true)}
        />
      </label>

      <fieldset className="space-y-2" disabled={busy}>
        <legend className="font-medium">{tx("Send to")}</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`team-usage-destination-${environmentId}`}
            checked={destination === "hosted"}
            onChange={() => setDestination("hosted")}
          />
          {tx("My org on verified-skill.com")}
        </label>
        {destination === "hosted" ? (
          <div className="ml-6 space-y-2">
            {status.hostedSignedIn === false ? (
              <p className="text-muted-foreground">
                {tx("Sign in with `vskill auth login` on this machine first.")}
              </p>
            ) : null}
            {orgs === null ? (
              <Button size="sm" variant="outline" onClick={() => void loadOrgs()}>
                {tx("Choose org")}
              </Button>
            ) : orgs.length === 0 ? (
              <p className="text-muted-foreground">
                {tx("You are not a member of any org on verified-skill.com.")}
              </p>
            ) : (
              <select
                aria-label={tx("Org")}
                className="rounded-md border border-input bg-background px-2 py-1"
                value={tenantId}
                onChange={(event) => setTenantId(event.target.value)}
              >
                <option value="">{tx("Pick an org")}</option>
                {orgs.map((org) => (
                  <option key={org.tenantId} value={org.tenantId}>
                    {org.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : null}
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`team-usage-destination-${environmentId}`}
            checked={destination === "selfHosted"}
            onChange={() => setDestination("selfHosted")}
          />
          {tx("A self-hosted team endpoint")}
        </label>
        {destination === "selfHosted" ? (
          <div className="ml-6 space-y-2">
            <Input
              aria-label={tx("Endpoint URL")}
              placeholder="https://team.example.com/usage"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Input
              aria-label={tx("Endpoint credential")}
              type="password"
              autoComplete="off"
              placeholder={
                status.selfHostedCredentialSet
                  ? tx("Saved. Type to replace it.")
                  : tx("Bearer credential")
              }
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {tx(
                "HTTPS only. The credential stays in this machine's secret store; your verified-skill.com token is never sent here.",
              )}
            </p>
          </div>
        ) : null}
      </fieldset>

      <label className="block space-y-1">
        <span className="font-medium">{tx("Machine name on the team page")}</span>
        <Input
          aria-label={tx("Machine name on the team page")}
          placeholder={status.preview.machineLabel}
          value={machineLabel}
          disabled={busy}
          onChange={(event) => setMachineLabel(event.target.value)}
        />
      </label>

      {enabled ? (
        <Button size="sm" disabled={busy} onClick={() => void save(true)}>
          {tx("Save")}
        </Button>
      ) : null}

      <div role="status" className="space-y-1 text-muted-foreground">
        {error ? <p className="text-destructive-foreground">{tx(error)}</p> : null}
        {status.lastError ? <p className="text-destructive-foreground">{status.lastError}</p> : null}
        {status.removalPending ? (
          <p>
            {tx('Removing "{label}" from the team. It retries until the team confirms.', {
              label: status.removalPending,
            })}
          </p>
        ) : null}
        {enabled && status.lastSentAt ? (
          <p>{tx("Last sent {when}.", { when: new Date(status.lastSentAt).toLocaleString() })}</p>
        ) : null}
      </div>

      <details>
        <summary className="cursor-pointer font-medium">{tx("What would be sent")}</summary>
        <pre
          data-team-usage-preview
          tabIndex={0}
          aria-label={tx("Team usage preview")}
          className="mt-2 max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed"
        >
          {JSON.stringify(status.preview, null, 2)}
        </pre>
      </details>
    </div>
  );
}

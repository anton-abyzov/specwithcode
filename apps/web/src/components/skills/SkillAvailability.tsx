import type {
  EnvironmentId,
  ProjectId,
  ProjectSkillRow,
  ProjectSkillsSnapshot,
} from "@specweave-studio/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useStudioFleet } from "../../studio/fleet";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useSkillControls, type SkillControls } from "../settings/ProjectSkillControls";
import { Button } from "../ui/button";

export interface SkillAvailabilityState {
  readonly state: "installed" | "missing" | "offline" | "denied" | "unknown" | "stale";
  readonly text: string;
  readonly row: ProjectSkillRow | null;
}

export function skillAvailabilityState(input: {
  connected: boolean;
  error: string | null;
  successful: boolean;
  pending: boolean;
  snapshot: ProjectSkillsSnapshot | null;
  name: string;
  skillId: string | null;
}): SkillAvailabilityState {
  const row =
    input.snapshot?.rows.find((candidate) =>
      input.skillId ? candidate.lock?.skillId === input.skillId : candidate.name === input.name,
    ) ?? null;
  if (!input.connected) return { state: "offline", text: "Offline · not checked", row: null };
  if (input.error)
    return {
      state: /permission|denied|forbidden|grant|scope/i.test(input.error) ? "denied" : "unknown",
      text: input.error,
      row: null,
    };
  if (!input.successful || input.pending || !input.snapshot)
    return { state: "unknown", text: input.pending ? "Checking…" : "Not checked", row: null };
  if (input.snapshot.providers.some((provider) => !["ok", "unsupported"].includes(provider.state)))
    return { state: "stale", text: "Scan incomplete · refresh", row };
  if (!input.snapshot.providers.some((provider) => provider.state === "ok"))
    return { state: "unknown", text: "No supported agent scan", row };
  if (!row || row.providers.length === 0)
    return { state: "missing", text: "Not found in this scope", row };
  const versions = [
    ...new Set(row.providers.map((presence) => presence.fileVersion).filter(Boolean)),
  ];
  const version = versions.length ? versions.join(" / ") : row.lock?.version;
  return {
    state: "installed",
    text: `${version ? `v${version}` : "Local copy"}${row.divergent ? " · copies differ" : ""}`,
    row,
  };
}

function AvailabilityMachine({
  controls,
  environmentId,
  projectId,
  label,
  reachable,
}: {
  controls: SkillControls;
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  label: string;
  reachable: boolean;
}) {
  const environment = useEnvironment(environmentId);
  const connected = reachable && environment?.connection.phase === "connected";
  const query = useEnvironmentQuery(
    connected && projectId
      ? projectWorkspace.skills({
          environmentId,
          input: {
            projectId,
            ...(controls.userLevel ? { userLevel: true } : {}),
            ...(environmentId === controls.environmentId && !controls.userLevel
              ? {
                  ...(controls.cwd ? { cwd: controls.cwd } : {}),
                  ...(controls.threadId ? { threadId: controls.threadId } : {}),
                }
              : {}),
          },
        })
      : null,
  );
  const state = skillAvailabilityState({
    connected,
    error: query.error,
    successful: query.isSuccess,
    pending: query.isPending,
    snapshot: query.data,
    name: controls.row.name,
    skillId: controls.row.lock?.skillId ?? null,
  });
  const [expanded, setExpanded] = useState(false);
  const text = !projectId
    ? "Project not linked · not checked"
    : !environment && reachable
      ? "Connect to inspect"
      : state.text;
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-background px-3 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="font-medium">{label}</span>
        <span className="break-words text-muted-foreground">{text}</span>
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2 rounded-lg border p-3 text-xs">
          {state.row ? (
            <ul className="space-y-1">
              {state.row.providers.map((agent) => (
                <li
                  key={`${agent.instanceId}:${agent.path}`}
                  className="flex flex-wrap justify-between gap-2"
                >
                  <span>{agent.label}</span>
                  <span className="text-muted-foreground">
                    {agent.enabled ? "Available to agent" : "Disabled"}
                    {agent.fileVersion ? ` · v${agent.fileVersion}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>{text}</p>
          )}
          <p className="text-muted-foreground">
            {query.data?.checkedAt
              ? `Last observation: ${new Date(query.data.checkedAt).toLocaleString()}`
              : "No current observation."}
          </p>
          <p className="text-muted-foreground">
            Availability is discovery evidence, not proof that an active session has loaded this
            version.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={!connected || !projectId || query.isPending}
            onClick={query.refresh}
          >
            <RefreshCwIcon aria-hidden />
            Refresh
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function SkillAvailability() {
  const controls = useSkillControls();
  return controls ? <ConnectedAvailability controls={controls} /> : null;
}
function ConnectedAvailability({ controls }: { controls: SkillControls }) {
  const fleet = useStudioFleet(controls.environmentId);
  const local = useEnvironment(controls.environmentId);
  const remote = (fleet.snapshot?.machines ?? []).filter(
    (machine) => machine.environmentId !== controls.environmentId,
  );
  const registry = Boolean(controls.row.lock?.skillId && controls.row.lock?.version);
  return (
    <section className="space-y-3" aria-label="Available on">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Available on</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!controls.canPush || !registry}
          onClick={() => controls.setPushOpen(true)}
        >
          Install on all
        </Button>
      </div>
      {!registry ? (
        <p className="text-xs text-muted-foreground">
          Publish this local skill before distributing it through the registry.
        </p>
      ) : null}
      {!controls.canPush ? (
        <p className="text-xs text-muted-foreground">
          Install on all needs permission to maintain machines.
        </p>
      ) : null}
      <ul className="grid gap-2 sm:grid-cols-2">
        <AvailabilityMachine
          controls={controls}
          environmentId={controls.environmentId}
          projectId={controls.projectId}
          label={local?.label ?? "This machine"}
          reachable
        />
        {remote.slice(0, 31).map((machine) => (
          <AvailabilityMachine
            key={machine.id}
            controls={controls}
            environmentId={machine.environmentId}
            projectId={
              controls.memberProjects.find(
                (member) => member.environmentId === machine.environmentId,
              )?.id ?? null
            }
            label={machine.machineName ?? machine.label}
            reachable={machine.status === "reachable"}
          />
        ))}
      </ul>
      {remote.length > 31 ? (
        <p className="text-xs text-muted-foreground">
          Showing the first 32 machines. Open Connections to inspect the rest.
        </p>
      ) : null}
      {fleet.failed ? (
        <p className="text-xs text-muted-foreground">
          Fleet availability could not be refreshed. Previously listed machines may be stale.
        </p>
      ) : fleet.loading && !fleet.snapshot ? (
        <p className="text-xs text-muted-foreground">Reading linked machines…</p>
      ) : null}
    </section>
  );
}

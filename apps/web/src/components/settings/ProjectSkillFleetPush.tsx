/**
 * The detail sheet's sticky footer: the confirm card, "Push to machines…"
 * (install this version on other fleet machines over Connect) and the
 * hand-off to Skill Studio for releasing a new version.
 */
import type { ProjectSkillsFleetPushResult } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { CheckIcon, ExternalLinkIcon, SendIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useStudioFleet } from "../../studio/fleet";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import {
  fleetPushMachines,
  fleetPushTargets,
  skillActionErrorText,
  skillVersionControl,
} from "./ProjectSkillActions.logic";
import { SkillActionPreviewCard, useSkillControls } from "./ProjectSkillControls";
import { SkillControlReason } from "./ProjectSkillReason";
import { projectSkillStudioTarget } from "./ProjectSkillLinks";
import { openSkillLink } from "./ProjectSkillRowMenu";

type PushResults = ProjectSkillsFleetPushResult["results"];

function FleetPushPanel() {
  const controls = useSkillControls()!;
  const fleet = useStudioFleet(controls.environmentId);
  const push = useAtomCommand(projectWorkspace.skillFleetPush, { reportFailure: false });
  const lock = skillVersionControl(controls.row);
  const version = controls.versions.data?.installedVersion ?? lock.installedVersion;
  const machines = useMemo(
    () =>
      fleetPushMachines(
        fleet.snapshot?.machines ?? [],
        controls.environmentId,
        controls.memberProjects,
      ),
    [controls.environmentId, controls.memberProjects, fleet.snapshot],
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [scope, setScope] = useState<"user" | "project">(
    controls.row.lock?.lockScope === "user" ? "user" : "project",
  );
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PushResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = fleetPushTargets(machines, checked, scope);
  const exact = version !== null && /^\d+\.\d+\.\d+$/.test(version);

  async function send() {
    if (!lock.skillId || !exact || plan.targets.length === 0) return;
    setBusy(true);
    setError(null);
    setResults(null);
    try {
      const result = await push({
        environmentId: controls.environmentId,
        input: {
          projectId: controls.projectId,
          skillId: lock.skillId,
          version: version!,
          pin,
          targets: plan.targets,
        },
      });
      if (result._tag === "Success") setResults(result.value.results);
      else setError(skillActionErrorText(squashAtomCommandFailure(result)));
    } catch {
      setError("The machine did not confirm the push.");
    } finally {
      setBusy(false);
    }
  }

  const labelOf = (machineId: string) =>
    machines.find((machine) => machine.machineId === machineId)?.label ?? machineId;
  return (
    <div className="space-y-3 text-xs" data-testid="skill-fleet-push">
      <p className="text-muted-foreground">
        Install <span className="font-mono text-foreground">{lock.skillId}</span>{" "}
        <span className="font-mono text-foreground">{version ?? "—"}</span> on other machines.
      </p>
      {fleet.loading && !fleet.snapshot ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="size-3" /> Reading the fleet…
        </p>
      ) : machines.length === 0 ? (
        <p className="text-muted-foreground">No other machines are in this machine's fleet.</p>
      ) : (
        <ul className="space-y-1.5" aria-label="Machines">
          {machines.map((machine) => (
            <li key={machine.machineId}>
              <label
                className="flex items-center gap-2 data-disabled:opacity-60"
                data-disabled={machine.reachable ? undefined : ""}
              >
                <Checkbox
                  checked={checked.has(machine.machineId)}
                  disabled={!machine.reachable || busy}
                  onCheckedChange={(next) => {
                    const updated = new Set(checked);
                    if (next) updated.add(machine.machineId);
                    else updated.delete(machine.machineId);
                    setChecked(updated);
                  }}
                />
                <span className="text-foreground">{machine.label}</span>
                {!machine.reachable ? (
                  <span className="text-muted-foreground">unreachable</span>
                ) : scope === "project" && !machine.projectId ? (
                  <span className="text-muted-foreground">project not there</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      )}
      <RadioGroup
        value={scope}
        onValueChange={(next) => setScope(next === "user" ? "user" : "project")}
        className="flex-row"
        aria-label="Install for"
      >
        <label className="flex items-center gap-1.5">
          <Radio value="project" disabled={busy} /> This project
        </label>
        <label className="flex items-center gap-1.5">
          <Radio value="user" disabled={busy} /> User
        </label>
      </RadioGroup>
      <label className="flex items-center gap-2">
        <Checkbox checked={pin} disabled={busy} onCheckedChange={(next) => setPin(next === true)} />
        Pin {version ?? "this version"}
      </label>
      {results ? (
        <ul className="space-y-1" aria-label="Results" data-testid="skill-fleet-results">
          {results.map((result) => (
            <li key={result.machineId} className="flex items-start gap-1.5">
              {result.ok ? (
                <CheckIcon
                  aria-hidden
                  className="mt-px size-3.5 shrink-0 text-success-foreground"
                />
              ) : (
                <XIcon
                  aria-hidden
                  className="mt-px size-3.5 shrink-0 text-destructive-foreground"
                />
              )}
              <span>
                <span className="text-foreground">{result.label ?? labelOf(result.machineId)}</span>
                {": "}
                {result.ok
                  ? `installed ${result.installedVersion ?? version}${result.pinnedVersion ? `, pinned` : ""}`
                  : (result.message ?? result.reason ?? "failed")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-destructive-foreground">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        {!controls.canPush ? (
          <span className="text-muted-foreground">Needs permission to maintain machines.</span>
        ) : null}
        <SkillControlReason
          reason={
            // Missing permission is already said beside the button.
            busy || !controls.canPush
              ? null
              : !exact
                ? "Pick an exact X.Y.Z version first."
                : plan.targets.length === 0
                  ? "Check at least one reachable machine."
                  : null
          }
        >
          <Button
            size="xs"
            type="button"
            disabled={!controls.canPush || busy || !exact || plan.targets.length === 0}
            onClick={() => void send()}
          >
            {busy ? <Spinner className="size-3" /> : <SendIcon aria-hidden />}
            Install on {plan.targets.length} {plan.targets.length === 1 ? "machine" : "machines"}
          </Button>
        </SkillControlReason>
      </div>
    </div>
  );
}

function StudioLinkButton() {
  const controls = useSkillControls()!;
  const link = useAtomCommand(projectWorkspace.skillStudioLink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = controls.row.providers
    .map((presence) => projectSkillStudioTarget(presence))
    .find((candidate) => candidate !== null);
  if (!target) return null;
  async function open() {
    setBusy(true);
    setError(null);
    try {
      const result = await link({
        environmentId: controls.environmentId,
        input: { projectId: controls.projectId, ...target! },
      });
      if (result._tag === "Success") await openSkillLink(result.value.url);
      else setError(skillActionErrorText(squashAtomCommandFailure(result)));
    } catch {
      setError("Skill Studio could not be opened.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <SkillControlReason
        reason={controls.canOpenStudio ? null : "Needs permission to open Skill Studio here."}
      >
        <Button
          size="xs"
          variant="ghost"
          type="button"
          disabled={busy || !controls.canOpenStudio}
          title={error ?? "Bump, publish and submit a new version in Skill Studio."}
          onClick={() => void open()}
        >
          {busy ? <Spinner className="size-3" /> : null}
          Release in Skill Studio
          <ExternalLinkIcon aria-hidden />
        </Button>
      </SkillControlReason>
      {error ? <span className="text-2xs text-destructive-foreground">{error}</span> : null}
    </>
  );
}

export function ProjectSkillSheetFooter() {
  const controls = useSkillControls();
  if (!controls) return null;
  const lock = skillVersionControl(controls.row);
  const canPushRow = lock.skillId !== null && lock.installedVersion !== null;
  return (
    <div className="space-y-2 border-t bg-popover px-6 py-3" data-testid="skill-sheet-footer">
      <SkillActionPreviewCard />
      <div className="flex flex-wrap items-center gap-2">
        {canPushRow ? (
          <Popover open={controls.pushOpen} onOpenChange={controls.setPushOpen}>
            <PopoverTrigger render={<Button size="xs" variant="outline" type="button" />}>
              <SendIcon aria-hidden />
              Push to machines…
            </PopoverTrigger>
            <PopoverPopup side="top" align="start" width="md">
              {controls.pushOpen ? <FleetPushPanel /> : null}
            </PopoverPopup>
          </Popover>
        ) : (
          <SkillControlReason reason="Only skills vskill installed from the registry can be pushed.">
            <Button size="xs" variant="outline" type="button" disabled>
              <SendIcon aria-hidden />
              Push to machines…
            </Button>
          </SkillControlReason>
        )}
        <StudioLinkButton />
      </div>
    </div>
  );
}

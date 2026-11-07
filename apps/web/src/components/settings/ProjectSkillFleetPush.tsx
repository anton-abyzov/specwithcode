import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
/**
 * The detail sheet's sticky footer: the confirm card, "Push to machines…"
 * (install this version on other fleet machines over Connect) and the
 * hand-off to Skill Studio for releasing a new version.
 */
import type {
  ProjectSkillsFleetPushResult,
  ProjectSkillsFleetTarget,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { CheckIcon, ExternalLinkIcon, SendIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useStudioFleet } from "../../studio/fleet";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { refreshSkillAvailability } from "../skills/SkillAvailability";
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

export function FleetPushPanel() {
  const tx = useTx();
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
  const [selection, setChecked] = useState<ReadonlySet<string> | null>(null);
  const checked =
    selection ??
    new Set(
      machines
        .filter((machine) => machine.reachable)
        .slice(0, 32)
        .map((machine) => machine.machineId),
    );
  const [scope, setScope] = useState<"user" | "project">(
    controls.row.lock?.lockScope === "user" ? "user" : "project",
  );
  const pin = true;
  const [agents, setAgents] = useState<ReadonlySet<"codex" | "claude-code" | "cursor">>(
    new Set(["codex"]),
  );
  const [preview, setPreview] = useState<{
    key: string;
    targets: readonly ProjectSkillsFleetTarget[];
    results: PushResults;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PushResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = fleetPushTargets(machines, checked, scope);
  const contentHash = controls.row.lock?.sha;
  const verifiedHash = typeof contentHash === "string" && /^[a-f0-9]{64}$/i.test(contentHash);
  const exact = version !== null && /^\d+\.\d+\.\d+$/.test(version);

  const key = JSON.stringify([
    lock.skillId,
    version,
    contentHash,
    scope,
    [...agents].sort(),
    [...checked].sort(),
  ]);
  const currentPreview = preview?.key === key ? preview : null;
  const successes = new Set(
    results?.filter((result) => result.ok).map((result) => result.machineId),
  );
  const remaining = plan.targets.filter((target) => !successes.has(target.machineId));
  async function send(confirm = false) {
    if (!controls.canPush || busy || !lock.skillId || !exact || !verifiedHash || !agents.size)
      return;
    const targets = confirm
      ? (currentPreview?.targets ?? [])
      : remaining.map((target) => ({ ...target, agents: [...agents] }));
    if (!targets.length) return;
    const recordUnknown = () => {
      if (!confirm) return;
      setResults((previous) => [
        ...(previous ?? []).filter(
          (entry) => !targets.some((target) => target.machineId === entry.machineId),
        ),
        ...targets.map((target) => ({
          machineId: target.machineId,
          ok: false,
          reason: "outcome_unknown",
          message: "Outcome unknown · check Available on before retrying.",
        })),
      ]);
      refreshSkillAvailability(controls.environmentId, lock.skillId!);
    };
    setBusy(true);
    setError(null);

    try {
      const result = await push({
        environmentId: controls.environmentId,
        input: {
          projectId: controls.projectId,
          skillId: lock.skillId,
          version: version!,
          pin,
          preview: !confirm,
          contentHash,
          targets,
        },
      });
      if (result._tag === "Success") {
        if (!confirm) {
          if (result.value.preview !== true) {
            setError("Update this machine to support safe installation previews.");
            setPreview(null);
            return;
          }
          const ready = targets.flatMap((target) => {
            const receipt = result.value.results.find(
              (entry) => entry.machineId === target.machineId,
            );
            return receipt?.ok && receipt.preview === true && receipt.expectedHash
              ? [{ ...target, expectedHash: receipt.expectedHash }]
              : [];
          });
          setPreview({ key, targets: ready, results: result.value.results });
        } else {
          const receipts = targets.map(
            (target) =>
              result.value.results.find((entry) => entry.machineId === target.machineId) ?? {
                machineId: target.machineId,
                ok: false,
                reason: "outcome_unknown",
                message: "Outcome unknown · check Available on before retrying.",
              },
          );
          setResults((previous) => [
            ...(previous ?? []).filter(
              (entry) => !targets.some((target) => target.machineId === entry.machineId),
            ),
            ...receipts,
          ]);
          refreshSkillAvailability(controls.environmentId, lock.skillId);
          setPreview(null);
        }
      } else {
        recordUnknown();
        setError(skillActionErrorText(squashAtomCommandFailure(result)));
        setPreview(null);
      }
    } catch {
      recordUnknown();
      setError("The machine did not confirm the request. Preview again before retrying.");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const labelOf = (machineId: string) =>
    machines.find((machine) => machine.machineId === machineId)?.label ?? machineId;
  return (
    <div className="space-y-3 text-xs" data-testid="skill-fleet-push">
      <p className="text-muted-foreground">
        {renderRich(tx("Install {span} {span2} on other machines."), {
          span: <span className="font-mono text-foreground">{lock.skillId}</span>,
          span2: <span className="font-mono text-foreground">{version ?? "—"}</span>,
        })}
      </p>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || fleet.failed}
        onClick={() =>
          setChecked(
            new Set(
              machines
                .filter((machine) => machine.reachable)
                .slice(0, 32)
                .map((machine) => machine.machineId),
            ),
          )
        }
      >
        Select all reachable
      </Button>
      {fleet.failed ? <p role="alert">Fleet unavailable. Reconnect before previewing.</p> : null}
      {machines.length > 32 ? <p>Preview up to 32 machines at a time.</p> : null}
      {fleet.loading && !fleet.snapshot ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <Spinner className="size-3" /> {tx("Reading the fleet…")}
        </p>
      ) : machines.length === 0 ? (
        <p className="text-muted-foreground">
          {tx("No other machines are in this machine's fleet.")}
        </p>
      ) : (
        <ul className="space-y-1.5" aria-label={tx("Machines")}>
          {machines.map((machine) => (
            <li key={machine.machineId}>
              <label
                className="flex items-center gap-2 data-disabled:opacity-60"
                data-disabled={machine.reachable ? undefined : ""}
              >
                <Checkbox
                  checked={checked.has(machine.machineId)}
                  disabled={!machine.reachable || busy || successes.has(machine.machineId)}
                  onCheckedChange={(next) => {
                    const updated = new Set(checked);
                    if (next) updated.add(machine.machineId);
                    else updated.delete(machine.machineId);
                    setChecked(updated);
                  }}
                />
                <span className="text-foreground">{machine.label}</span>
                {!machine.reachable ? (
                  <span className="text-muted-foreground">{tx("unreachable")}</span>
                ) : scope === "project" && !machine.projectId ? (
                  <span className="text-muted-foreground">{tx("project not there")}</span>
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
        aria-label={tx("Install for")}
      >
        <label className="flex items-center gap-1.5">
          {renderRich(tx("{radio} This project"), {
            radio: <Radio value="project" disabled={busy || Boolean(results?.length)} />,
          })}
        </label>
        <label className="flex items-center gap-1.5">
          {renderRich(tx("{radio} User"), {
            radio: <Radio value="user" disabled={busy || Boolean(results?.length)} />,
          })}
        </label>
      </RadioGroup>
      <fieldset disabled={busy || Boolean(results?.length)} className="space-y-2">
        <legend>Agents</legend>
        <div className="flex flex-wrap gap-3">
          {(["codex", "claude-code", "cursor"] as const).map((agent) => (
            <label key={agent} className="flex items-center gap-1.5">
              <Checkbox
                checked={agents.has(agent)}
                onCheckedChange={(next) => {
                  const updated = new Set(agents);
                  if (next) updated.add(agent);
                  else updated.delete(agent);
                  setAgents(updated);
                }}
              />
              {agent === "claude-code" ? "Claude Code" : agent === "codex" ? "Codex" : "Cursor"}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-muted-foreground">
        Pinned to {version}. Installed files are available to new sessions; running sessions are not
        restarted.
      </p>
      {currentPreview ? (
        <div role="status" className="space-y-2 rounded-lg border p-3">
          <p className="font-medium">Review installation</p>
          <p className="break-all font-mono">SHA-256: {contentHash}</p>
          <p>
            {currentPreview.targets.length} machines · {[...agents].join(", ")} · {scope} scope ·{" "}
            {version}
          </p>
          <ul>
            {currentPreview.results.map((entry) => (
              <li key={entry.machineId}>
                {labelOf(entry.machineId)}:{" "}
                {entry.ok && entry.expectedHash
                  ? "Ready to install"
                  : (entry.message ?? entry.reason ?? "Not eligible")}
              </li>
            ))}
          </ul>
          <Button
            size="xs"
            disabled={busy || !controls.canPush || !currentPreview.targets.length}
            onClick={() => void send(true)}
          >
            Confirm installation
          </Button>
        </div>
      ) : null}
      {results ? (
        <ul className="space-y-1" aria-label={tx("Results")} data-testid="skill-fleet-results">
          {results.map((result) => (
            <li key={result.machineId} className="flex items-start gap-1.5">
              {result.reason === "outcome_unknown" ? (
                <span aria-label="Unknown outcome">?</span>
              ) : result.ok ? (
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
                  ? `Installed ${result.installedVersion ?? version} · next session${result.pinnedVersion ? ` · pinned` : ""}`
                  : (result.message ?? result.reason ?? tx("failed"))}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {!verifiedHash ? (
        <p>Verified publication content hash required. Refresh the skill or publish it first.</p>
      ) : null}
      {results?.some((result) => result.reason === "outcome_unknown") ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => refreshSkillAvailability(controls.environmentId, lock.skillId!)}
        >
          Check Available on
        </Button>
      ) : null}
      {error ? <p className="text-destructive-foreground">{error}</p> : null}
      <div className="flex items-center justify-end gap-2">
        {!controls.canPush ? (
          <span className="text-muted-foreground">
            {tx("Needs permission to maintain machines.")}
          </span>
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
            disabled={
              !controls.canPush ||
              busy ||
              fleet.failed ||
              !exact ||
              !verifiedHash ||
              !agents.size ||
              !remaining.length
            }
            onClick={() => void send()}
          >
            {busy ? <Spinner className="size-3" /> : <SendIcon aria-hidden />}
            {results?.some((result) => result.reason === "outcome_unknown")
              ? "Preview unconfirmed targets"
              : results?.length
                ? "Preview failed targets only"
                : "Preview installation"}
          </Button>
        </SkillControlReason>
      </div>
    </div>
  );
}

function StudioLinkButton() {
  const tx = useTx();
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
        input: {
          projectId: controls.projectId,
          ...(controls.cwd ? { cwd: controls.cwd } : {}),
          ...(controls.threadId ? { threadId: controls.threadId } : {}),
          ...target!,
        },
      });
      if (result._tag === "Success") await openSkillLink(result.value.url);
      else {
        setError(skillActionErrorText(squashAtomCommandFailure(result)));
      }
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
          title={error ?? tx("Bump, publish and submit a new version in Skill Studio.")}
          onClick={() => void open()}
        >
          {busy ? <Spinner className="size-3" /> : null}
          {tx("Release in Skill Studio")}
          <ExternalLinkIcon aria-hidden />
        </Button>
      </SkillControlReason>
      {error ? <span className="text-2xs text-destructive-foreground">{error}</span> : null}
    </>
  );
}

export function ProjectSkillSheetFooter() {
  const tx = useTx();
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
              {tx("Push to machines…")}
            </PopoverTrigger>
            <PopoverPopup side="top" align="start" width="md">
              {controls.pushOpen ? <FleetPushPanel /> : null}
            </PopoverPopup>
          </Popover>
        ) : (
          <SkillControlReason reason="Only skills vskill installed from the registry can be pushed.">
            <Button size="xs" variant="outline" type="button" disabled>
              <SendIcon aria-hidden />
              {tx("Push to machines…")}
            </Button>
          </SkillControlReason>
        )}
        <StudioLinkButton />
      </div>
    </div>
  );
}

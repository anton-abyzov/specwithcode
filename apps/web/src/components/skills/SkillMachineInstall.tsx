/**
 * Install or update one skill on one fleet machine, from its "Available on"
 * card. It uses the same push as "Install on several…": a preview first, then
 * a confirmed install of exactly what the preview showed.
 */
import type { ProjectId, ProjectSkillRow } from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { isNewerVersion, skillActionErrorText } from "../settings/ProjectSkillActions.logic";
import type { SkillControls } from "../settings/ProjectSkillControls";
import { Button } from "../ui/button";
import { refreshSkillAvailability } from "./SkillAvailability";

export type SkillInstallScope = "user" | "project";

export interface MachineInstallPlan {
  readonly kind: "install" | "update" | "current";
  readonly version: string | null;
  readonly reason: string | null;
}

/** What one machine's card offers for the chosen scope. */
export function machineInstallPlan(input: {
  readonly installed: string | null;
  readonly installedScope: SkillInstallScope | null;
  readonly latest: string | null;
  readonly scope: SkillInstallScope;
  readonly projectId: ProjectId | null;
  readonly reachable: boolean;
  readonly canPush: boolean;
  /** Why this machine's copy cannot be judged yet, e.g. still checking or another skill. */
  readonly blocked?: string | null;
}): MachineInstallPlan {
  const sameScope = input.installedScope === input.scope;
  const kind =
    !input.installed || !sameScope
      ? "install"
      : isNewerVersion(input.latest, input.installed)
        ? "update"
        : "current";
  const reason = !input.canPush
    ? "Needs permission to maintain machines."
    : !input.reachable
      ? "This machine is offline."
      : input.blocked
        ? input.blocked
        : !input.latest || !/^\d+\.\d+\.\d+$/.test(input.latest)
          ? "No released registry version is known for this skill."
          : input.scope === "project" && !input.projectId
            ? "This project is not added on that machine. Add it there, or install for the user."
            : null;
  return { kind, version: kind === "current" ? input.installed : input.latest, reason };
}

export function scopeLabel(scope: SkillInstallScope | null | undefined): string {
  return scope === "user" ? "User, all projects" : scope === "project" ? "This project" : "";
}

export function SkillMachineInstall({
  controls,
  machineId,
  label,
  row,
  projectId,
  reachable,
  blocked = null,
  unread = false,
}: {
  controls: SkillControls;
  machineId: string;
  label: string;
  /** That machine's copy of this exact registry skill, or null when it has none or was not read. */
  row: ProjectSkillRow | null;
  projectId: ProjectId | null;
  reachable: boolean;
  blocked?: string | null;
  /** True when that machine's copies were not read, so an existing pin there is unknown. */
  unread?: boolean;
}) {
  const push = useAtomCommand(projectWorkspace.skillFleetPush, { reportFailure: false });
  const skillId = controls.row.lock?.skillId ?? null;
  const installedScope = row?.lock?.lockScope ?? null;
  // Follow the machine's copy, then this machine's scope, until the user picks.
  const [pickedScope, setScope] = useState<SkillInstallScope | null>(null);
  const scope: SkillInstallScope =
    pickedScope ??
    installedScope ??
    (controls.row.lock?.lockScope === "user" || !projectId ? "user" : "project");
  // A row reports one lock: the project one when a project copy exists. So the pin is known
  // for the scope the row reports, for a project scope next to a user-only copy, and when
  // a successful read found no copy. Otherwise the user chooses; nothing is assumed.
  const [pickedPin, setPin] = useState<boolean | null>(null);
  const pinKnown = !unread && (!row || installedScope === scope || installedScope === "user");
  const pinned = pinKnown && installedScope === scope ? (row?.lock?.pinnedVersion ?? null) : null;
  const pin = pickedPin ?? (pinKnown ? Boolean(pinned) : null);
  const [preview, setPreview] = useState<{ key: string; expectedHash: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // The same newest version the Version badge shows.
  const latest =
    controls.versions.data?.versions[0]?.version ??
    controls.versions.data?.outdated?.latest ??
    null;
  const plan = machineInstallPlan({
    installed: row?.lock?.version ?? null,
    installedScope,
    latest,
    scope,
    projectId,
    reachable,
    canPush: controls.canPush,
    blocked:
      blocked ??
      (pin === null
        ? "This machine's copy in that scope was not read, so any pin there is unknown. Choose whether to pin."
        : null),
  });
  const key = JSON.stringify([skillId, plan.version, scope, pin, projectId]);
  const current = preview?.key === key ? preview : null;
  const target =
    scope === "project" && projectId
      ? { machineId, scope: "project" as const, projectId }
      : { machineId, scope: "user" as const };

  async function send(confirm: boolean) {
    if (busy || !skillId || !plan.version || plan.reason) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await push({
        environmentId: controls.environmentId,
        input: {
          projectId: controls.projectId,
          skillId,
          version: plan.version,
          pin: pin === true,
          preview: !confirm,
          targets: [
            confirm && current ? { ...target, expectedHash: current.expectedHash } : target,
          ],
        },
      });
      if (result._tag !== "Success") {
        setError(skillActionErrorText(squashAtomCommandFailure(result)));
        setPreview(null);
        if (confirm) refreshSkillAvailability(controls.environmentId, skillId);
        return;
      }
      const receipt = result.value.results.find((entry) => entry.machineId === machineId);
      if (!receipt?.ok) {
        setError(receipt?.message ?? "The machine did not confirm the request.");
        setPreview(null);
        // An unknown outcome may still have installed; read the machine again.
        if (confirm) refreshSkillAvailability(controls.environmentId, skillId);
        return;
      }
      if (!confirm) {
        if (!receipt.expectedHash) {
          setError("Update that machine to support safe installation previews.");
          return;
        }
        setPreview({ key, expectedHash: receipt.expectedHash });
        return;
      }
      setPreview(null);
      setDone(
        `Installed v${receipt.installedVersion ?? plan.version} on ${label} for ${scopeLabel(scope).toLowerCase()}${pin ? ", pinned" : ""}.`,
      );
      refreshSkillAvailability(controls.environmentId, skillId);
    } catch {
      setError("The machine did not confirm the request. Preview again before retrying.");
      setPreview(null);
      if (confirm) refreshSkillAvailability(controls.environmentId, skillId);
    } finally {
      setBusy(false);
    }
  }

  const action =
    plan.kind === "update"
      ? `Update to v${plan.version} (latest)`
      : plan.kind === "install"
        ? `Install v${plan.version ?? "?"}`
        : `Reinstall v${plan.version ?? "?"}`;
  return (
    <fieldset
      className="space-y-2 border-t pt-2"
      disabled={busy}
      aria-label={`Install on ${label}`}
    >
      <legend className="sr-only">Install on {label}</legend>
      <div className="flex flex-wrap items-center gap-3" role="radiogroup" aria-label="Scope">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={scope === "user"}
            onChange={() => {
              setScope("user");
              setPin(null);
              setPreview(null);
              setDone(null);
            }}
          />
          User, all projects on {label}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={scope === "project"}
            disabled={!projectId}
            onChange={() => {
              setScope("project");
              setPin(null);
              setPreview(null);
              setDone(null);
            }}
          />
          This project only
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3" role="radiogroup" aria-label="Pin">
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={pin === true}
            onChange={() => {
              setPin(true);
              setPreview(null);
            }}
          />
          {pinned ? `Keep pinned (now pinned at ${pinned})` : "Pin this version"}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            checked={pin === false}
            onChange={() => {
              setPin(false);
              setPreview(null);
            }}
          />
          {pinned ? "Remove the pin" : "Don't pin, take later updates"}
        </label>
      </div>
      {plan.reason ? <p className="text-muted-foreground">{plan.reason}</p> : null}
      {current ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            Install {skillId}@{plan.version} for {scopeLabel(scope).toLowerCase()} on {label}
            {pin ? ", pinned" : pinned ? ", removing the pin" : ", not pinned"}
            {pinKnown ? "" : " (replaces any pin there)"}? vskill installs what the registry serves
            for this version.
          </span>
          <Button size="xs" onClick={() => void send(true)}>
            Confirm
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setPreview(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={Boolean(plan.reason) || !plan.version}
          onClick={() => void send(false)}
        >
          {busy ? "Checking…" : action}
        </Button>
      )}
      {error ? (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-muted-foreground">
          {done}
        </p>
      ) : null}
    </fieldset>
  );
}

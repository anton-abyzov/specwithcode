/** The detail sheet's Version section: installed and pinned versions, and the vskill actions. */
import { PinIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { skillUpdateTarget, skillVersionControl } from "./ProjectSkillActions.logic";
import { useSkillControls } from "./ProjectSkillControls";
import { SkillControlReason } from "./ProjectSkillReason";

export function ProjectSkillVersionSection() {
  const controls = useSkillControls();
  const [chosen, setChosen] = useState<string | null>(null);
  if (!controls) return null;
  const { row, versions, pending, canOperate } = controls;
  const lock = skillVersionControl(row);
  if (!lock.skillId) {
    return (
      <section aria-label="Version" className="space-y-1" data-testid="skill-version">
        <h3 className="font-medium text-foreground">Version</h3>
        <p className="text-muted-foreground">Local skill. No registry versions.</p>
      </section>
    );
  }
  const data = versions.data;
  const installed = data?.installedVersion ?? lock.installedVersion;
  const pinned = data?.pinnedVersion ?? lock.pinnedVersion;
  const list = data?.versions ?? [];
  const newest = list[0]?.version ?? data?.outdated?.latest ?? null;
  const latest = skillUpdateTarget(installed, newest);
  const updateAvailable = latest !== null;
  const selected = chosen ?? installed ?? list[0]?.version ?? null;
  const exact = selected !== null && /^\d+\.\d+\.\d+$/.test(selected);
  const busy = pending !== null;
  const permission = canOperate ? null : "Needs permission to change files and run vskill here.";
  const pinReason =
    permission ??
    (lock.canPin
      ? null
      : "This skill is in the user's lock; vskill pins only in a project folder's own lock.");
  const installReason =
    permission ?? (exact && selected === installed ? `${selected} is installed.` : null);
  return (
    <section aria-label="Version" className="space-y-2" data-testid="skill-version">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="font-medium text-foreground">Version</h3>
        <span className="font-mono text-foreground">{installed ?? "—"}</span>
        {pinned ? (
          <Badge size="sm" variant="outline" data-testid="skill-pinned">
            <PinIcon aria-hidden />
            pinned {pinned === installed ? "" : pinned}
          </Badge>
        ) : null}
        {updateAvailable && latest ? (
          <Badge size="sm" variant="info">
            ↑{latest}
          </Badge>
        ) : null}
        {versions.isPending ? <Spinner className="size-3" /> : null}
      </div>
      {versions.error && !data ? (
        <p className="text-xs text-muted-foreground">
          Versions could not be read: {versions.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={selected ?? ""}
          disabled={list.length === 0 || busy}
          onValueChange={(value) => setChosen(typeof value === "string" ? value : null)}
        >
          <SelectTrigger size="xs" className="w-40 min-w-0" aria-label={`Version of ${row.name}`}>
            <SelectValue>
              {selected ?? (versions.isPending ? "Loading…" : "No versions")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {list.map((version) => (
              <SelectItem key={version.version} value={version.version}>
                <span className="font-mono">{version.version}</span>
                {version.certTier ? (
                  <span className="ms-1.5 text-2xs text-muted-foreground">{version.certTier}</span>
                ) : null}
                {version.installed ? (
                  <span className="ms-1.5 text-2xs text-muted-foreground">installed</span>
                ) : null}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <SkillControlReason reason={installReason}>
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={!exact || busy || !canOperate || selected === installed}
            onClick={() => controls.propose({ kind: "install-version", version: selected! })}
          >
            Install
          </Button>
        </SkillControlReason>
        {pinned ? (
          <SkillControlReason reason={pinReason}>
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={busy || !canOperate || !lock.canPin}
              onClick={() => controls.propose({ kind: "unpin" })}
            >
              Unpin
            </Button>
          </SkillControlReason>
        ) : (
          <SkillControlReason reason={pinReason}>
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={!exact || busy || !canOperate || !lock.canPin}
              onClick={() => controls.propose({ kind: "pin", version: selected! })}
            >
              Pin
            </Button>
          </SkillControlReason>
        )}
        {updateAvailable && latest ? (
          <SkillControlReason reason={permission}>
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={busy || !canOperate}
              onClick={() => controls.propose({ kind: "update-latest" })}
            >
              Update to {latest}
            </Button>
          </SkillControlReason>
        ) : null}
      </div>
    </section>
  );
}

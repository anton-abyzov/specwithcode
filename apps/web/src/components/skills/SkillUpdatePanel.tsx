/**
 * Every skill this machine tracks to a source: the installed version and
 * source commit, the latest in that source, and Update. After a run the row
 * shows what the lock records and when each agent has the skill.
 */
import {
  formatSkillSourceVersion,
  type ProjectSkillSourceStatus,
  type ProjectSkillsUpdateResult,
  type ProjectSkillUpdateOutcome,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useTx } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { useMachineNickname } from "../../studio/machineNickname";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { SkillControlReason } from "../settings/ProjectSkillReason";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  REPO_REFUSAL_PHRASES,
  SKILL_CHANGE_PERMISSION,
  UPDATE_STATE_LABELS,
  UPDATE_STATE_VARIANTS,
  isSkillUpdatable,
  skillFolderInput,
  type SkillFolderScope,
} from "./SkillUpdate.logic";
import { useStudioFleet } from "../../studio/fleet";
import { SkillRollout, SkillRolloutAfter } from "./SkillRollout";
import { SkillUpdateOutcomeLine, useSkillUpdateRun } from "./SkillUpdateOutcome";

function Version({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value || "—"}</span>
    </span>
  );
}

export function SkillUpdatePanel({
  onChanged,
  ...scope
}: SkillFolderScope & {
  /** Called after an update changed this machine. */ onChanged?: () => void;
}) {
  const tx = useTx();
  const { environmentId } = scope;
  const machine = useMachineNickname(environmentId) || tx("this machine");
  const query = useEnvironmentQuery(
    projectWorkspace.skillSources({
      environmentId,
      input: { ...skillFolderInput(scope), operation: "status" },
    }),
  );
  const { canRun, run } = useSkillUpdateRun(scope, onChanged);
  /** The answer of the last run; newer than the query until the query is read again. */
  const [ran, setRan] = useState<ProjectSkillsUpdateResult | null>(null);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, ProjectSkillUpdateOutcome>>(
    new Map(),
  );
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Skills whose "Also add on" was opened from their row, without a run first. */
  const [rolling, setRolling] = useState<ReadonlySet<string>>(new Set());
  const fleet = useStudioFleet(environmentId);
  const otherMachines = (fleet.snapshot?.machines ?? []).some(
    (machine) => machine.environmentId !== environmentId,
  );

  const statuses: ReadonlyArray<ProjectSkillSourceStatus> =
    ran?.statuses ?? query.data?.statuses ?? [];
  const updatable = statuses.filter(isSkillUpdatable);
  const permission = canRun ? null : tx(SKILL_CHANGE_PERMISSION);
  const busy = pending !== null;

  const update = async (skills: ReadonlyArray<string> | null) => {
    setPending(skills === null ? "*" : (skills[0] ?? "*"));
    setError(null);
    const done = await run({ operation: "update", ...(skills === null ? {} : { skills }) });
    setPending(null);
    if (!done.ok) {
      setError(done.error);
      return;
    }
    setRan(done.value);
    setOutcomes((previous) => {
      const next = new Map(previous);
      for (const outcome of done.value.outcomes ?? []) next.set(outcome.skill, outcome);
      return next;
    });
    query.refresh();
  };

  return (
    <section
      aria-label={tx("Versions and updates")}
      className="space-y-2"
      data-testid="skill-updates"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-foreground">{tx("Versions and updates")}</h3>
        {query.isPending ? <Spinner className="size-3" /> : null}
        <span className="flex-1" />
        {updatable.length > 0 ? (
          <SkillControlReason reason={permission}>
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={!canRun || busy}
              onClick={() => void update(null)}
            >
              {pending === "*" ? <Spinner className="size-3" /> : null}
              {tx("Update all ({count})", { count: updatable.length })}
            </Button>
          </SkillControlReason>
        ) : null}
      </div>
      {(error ?? query.error) ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error ?? query.error}
        </p>
      ) : null}
      {statuses.length === 0 && !query.isPending && !query.error ? (
        <p className="text-xs text-muted-foreground">
          {tx("No skill on {machine} records a source yet.", { machine })}
        </p>
      ) : null}
      {statuses.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {statuses.map((status) => {
            const outcome = outcomes.get(status.skill);
            return (
              <li key={status.skill} data-skill={status.skill} className="space-y-1.5 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium text-foreground">{status.skill}</span>
                  <Badge size="sm" variant={UPDATE_STATE_VARIANTS[status.state]}>
                    {tx(UPDATE_STATE_LABELS[status.state])}
                  </Badge>
                  <span className="flex-1" />
                  {otherMachines &&
                  status.repo !== null &&
                  status.lockScope === "user" &&
                  !outcome &&
                  !rolling.has(status.skill) ? (
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      onClick={() => setRolling((previous) => new Set(previous).add(status.skill))}
                    >
                      {tx("Also add on…")}
                    </Button>
                  ) : null}
                  {isSkillUpdatable(status) ? (
                    <SkillControlReason reason={permission}>
                      <Button
                        size="xs"
                        variant="outline"
                        type="button"
                        disabled={!canRun || busy}
                        onClick={() => void update([status.skill])}
                      >
                        {pending === status.skill ? <Spinner className="size-3" /> : null}
                        {tx("Update")}
                      </Button>
                    </SkillControlReason>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
                  <Version
                    label={tx("Installed")}
                    value={formatSkillSourceVersion(status.installed)}
                  />
                  {status.latest ? (
                    <Version label={tx("Latest")} value={formatSkillSourceVersion(status.latest)} />
                  ) : null}
                  {status.repo ? (
                    <span className="truncate text-xs text-muted-foreground">{status.repo}</span>
                  ) : null}
                </div>
                {status.state === "needs-sign-in" && status.repo ? (
                  <p className="text-xs text-muted-foreground">
                    {tx(REPO_REFUSAL_PHRASES["needs-sign-in"], { machine, repo: status.repo })}
                  </p>
                ) : status.detail ? (
                  <p className="text-xs text-muted-foreground">{status.detail}</p>
                ) : null}
                {outcome ? <SkillUpdateOutcomeLine outcome={outcome} /> : null}
                {outcome ? (
                  <SkillRolloutAfter
                    environmentId={environmentId}
                    projectId={scope.projectId}
                    outcome={outcome}
                    statuses={statuses}
                  />
                ) : rolling.has(status.skill) ? (
                  <SkillRollout
                    environmentId={environmentId}
                    projectId={scope.projectId}
                    status={status}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

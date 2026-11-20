/**
 * What a skill install or update did, and when each agent has the skill.
 * The version and commit come from the lock the machine read back.
 */
import {
  formatSkillSourceVersion,
  type EnvironmentId,
  type ProjectSkillsUpdateInput,
  type ProjectSkillsUpdateResult,
  type ProjectSkillUpdateOutcome,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, AuthTerminalOperateScope } from "@specweave-studio/contracts";
import { useCallback } from "react";

import { useTx } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { skillActionErrorText } from "../settings/ProjectSkillActions.logic";
import { Badge } from "../ui/badge";
import {
  OUTCOME_PHRASES,
  READINESS_LABELS,
  READINESS_VARIANTS,
  outcomeAgents,
  skillFolderInput,
  type SkillFolderScope,
} from "./SkillUpdate.logic";

export type SkillRunResult =
  | { readonly ok: true; readonly value: ProjectSkillsUpdateResult }
  | { readonly ok: false; readonly error: string };

type SkillChange = Pick<ProjectSkillsUpdateInput, "skills" | "install"> & {
  readonly operation: "update" | "install";
};

/** The text of a failed command, whatever shape the failure has. */
export function skillCommandErrorText(result: unknown): string {
  try {
    return skillActionErrorText(squashAtomCommandFailure(result as never));
  } catch {
    return skillActionErrorText(null);
  }
}

/**
 * Runs an install or update on the machine. After a change it asks each agent
 * to scan this folder again, so the composer offers the skill without a restart.
 */
export function useSkillUpdateRun(scope: SkillFolderScope, onChanged?: () => void) {
  const { environmentId, cwd } = scope;
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const canTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const update = useAtomCommand(projectWorkspace.skillsUpdate, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const folder = JSON.stringify(skillFolderInput(scope));
  const run = useCallback(
    async (change: SkillChange): Promise<SkillRunResult> => {
      const result = await update({
        environmentId: environmentId as EnvironmentId,
        input: { ...(JSON.parse(folder) as ReturnType<typeof skillFolderInput>), ...change },
      });
      if (result._tag !== "Success") return { ok: false, error: skillCommandErrorText(result) };
      if (cwd) {
        for (const instanceId of outcomeAgents(result.value.outcomes ?? []))
          void refreshProviders({
            environmentId,
            input: { instanceId: instanceId as ProviderInstanceId, cwd, fresh: true },
          });
      }
      onChanged?.();
      return { ok: true, value: result.value };
    },
    [cwd, environmentId, folder, onChanged, refreshProviders, update],
  );
  return { canRun: canWrite && canTerminal, run };
}

export function SkillUpdateOutcomeLine({ outcome }: { outcome: ProjectSkillUpdateOutcome }) {
  const tx = useTx();
  const failed = outcome.outcome === "failed";
  return (
    <div className="space-y-1" data-testid="skill-update-outcome" data-outcome={outcome.outcome}>
      <p
        role={failed ? "alert" : "status"}
        className={failed ? "text-xs text-destructive-foreground" : "text-xs text-foreground"}
      >
        {tx(OUTCOME_PHRASES[outcome.outcome], {
          skill: outcome.skill,
          version: formatSkillSourceVersion(outcome.after),
        })}
        {outcome.message ? <span className="text-muted-foreground"> {outcome.message}</span> : null}
      </p>
      {outcome.readiness.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label={tx("When each agent has it")}>
          {outcome.readiness.map((agent) => (
            <li key={agent.instanceId}>
              <Badge size="sm" variant={READINESS_VARIANTS[agent.readiness]} title={agent.detail}>
                {agent.label}: {tx(READINESS_LABELS[agent.readiness])}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

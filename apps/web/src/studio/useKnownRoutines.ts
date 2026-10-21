import { routineCadenceLabel } from "@specweave-studio/shared/routineBrief";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { useMemo } from "react";

import { serverEnvironment } from "../state/server";
import { useEnvironmentQuery } from "../state/query";
import type { KnownRoutine } from "./routineRunMessage";

export interface KnownRoutineView extends KnownRoutine {
  readonly cadence: string;
}

const NO_ROUTINES: ReadonlyMap<string, KnownRoutineView> = new Map();

/**
 * The environment's routines as a fired routine's card reads them. Only the parts a
 * card shows count, so a run updating a routine's last-run time leaves this as it was.
 */
export function useKnownRoutines(
  environmentId: EnvironmentId,
  enabled: boolean,
): ReadonlyMap<string, KnownRoutineView> {
  const query = useEnvironmentQuery(
    enabled ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const key = JSON.stringify(
    (query.data?.tasks ?? []).map((task) => [
      task.id,
      task.title,
      task.prompt,
      task.check?.command ?? null,
      routineCadenceLabel(task.schedule),
    ]),
  );
  return useMemo(() => {
    const rows = JSON.parse(key) as Array<[string, string, string, string | null, string]>;
    if (rows.length === 0) return NO_ROUTINES;
    return new Map(
      rows.map(([id, title, prompt, command, cadence]) => [
        id,
        { title, prompt, cadence, ...(command === null ? {} : { check: { command } }) },
      ]),
    );
  }, [key]);
}

import type { EnvironmentId, ModelSelection } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  routineTemplateModel,
  type RoutineModelChoice,
  type RoutineTemplate,
} from "@specweave-studio/shared/routineTemplates";

import { serverEnvironment } from "../../state/server";

/**
 * The model a routine from `template` saves with on `environmentId` (1340 AC-09):
 * `loading` until both the provider list and the settings have arrived.
 */
export function useRoutineModel(
  environmentId: EnvironmentId,
  template: RoutineTemplate,
  coordinator: ModelSelection | null,
): RoutineModelChoice {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const loaded = config != null && settings != null;
  return routineTemplateModel(
    template,
    coordinator,
    loaded ? config.providers : undefined,
    settings?.modelTiers,
  );
}

import type { EnvironmentId, ModelSelection } from "@specweave-studio/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  routineTemplateModel,
  type RoutineTemplate,
} from "@specweave-studio/shared/routineTemplates";

import { serverEnvironment } from "../../state/server";

/** The model a routine from `template` saves with on `environmentId` (1340 AC-09). */
export function useRoutineModel(
  environmentId: EnvironmentId,
  template: RoutineTemplate,
  coordinator: ModelSelection | null,
): ModelSelection | null {
  const providers = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const modelTiers = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.modelTiers;
  return routineTemplateModel(template, coordinator, providers ?? [], modelTiers);
}

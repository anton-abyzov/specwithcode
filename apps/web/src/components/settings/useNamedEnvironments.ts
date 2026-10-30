import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { useMachineNicknames } from "../../studio/machineNickname";

/**
 * The environments with each machine's current name: the nickname the user
 * gave it ("m4"), else its host label. Settings scope pickers and inheritance
 * chains name machines like the rest of the app does.
 */
export function useNamedEnvironments() {
  const result = useEnvironments();
  const name = useMachineNicknames();
  const environments = useMemo(
    () =>
      result.environments.map((environment) => {
        const label = name(environment.environmentId, environment.label);
        return label === environment.label ? environment : { ...environment, label };
      }),
    [name, result.environments],
  );
  return { ...result, environments };
}

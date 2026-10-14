export * from "../../src/hooks/useSettings";
import { useEnvironmentSettings as useOriginalEnvironmentSettings } from "../../src/hooks/useSettings";
import { useEnvironmentSettings as useRecoveryEnvironmentSettings } from "./mocks";
export function useEnvironmentSettings(
  environmentId: Parameters<typeof useOriginalEnvironmentSettings>[0],
) {
  const original = useOriginalEnvironmentSettings(environmentId);
  return new URLSearchParams(location.search).has("recovery")
    ? useRecoveryEnvironmentSettings()
    : original;
}

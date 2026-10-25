import { useSyncExternalStore } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@specweave-studio/contracts";
let settings = { ...DEFAULT_UNIFIED_SETTINGS };
const listeners = new Set<() => void>();
export function useScopedSettings<T>(select: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => T): T {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => settings,
  );
  return select(settings);
}
export const useUpdateScopedSettings = () => (patch: Partial<typeof settings>) => {
  settings = { ...settings, ...patch };
  for (const listener of listeners) listener();
};
export const useClearScopedSettings = () => () => {};
export const useClearProjectOverrides = () => () => {};
export const usePrimarySettingsAvailable = () => true;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "Fixture offline";
export const usePrimaryEnvironmentId = () => "fixture-machine";
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set(["fixture-machine"]);
export const useOptionalSettingsScope = () => null;
export const useNavigate = () => () => {};
export const useLocation = () => ({ pathname: "/settings/general" });
export const useEnvironments = () => ({ environments: [] });
export const environmentSession = {};
export const useParams = () => ({});

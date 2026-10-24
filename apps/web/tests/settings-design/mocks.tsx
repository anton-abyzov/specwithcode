export const useNavigate = () => () => undefined;
export const useLocation = () => ({ hash: "", state: {} });
export const usePrimarySettingsAvailable = () => true;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "Fixture unavailable";
export const usePrimaryEnvironmentId = () => "fixture-m4";
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set(["fixture-m4"]);
export const useOptionalSettingsScope = () => null;
export const useClearProjectOverrides = () => () => undefined;
export const useClearScopedSettings = () => () => undefined;
export const SettingsScopeSentence = () => null;
export const SettingInheritance = () => null;
export const AcpSessionManagementSection = () => null;

export const useParams = () => ({});

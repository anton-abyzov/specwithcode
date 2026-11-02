import type { ReactNode } from "react";

// The fixture stands in for one connected machine with write access.
export const usePrimaryEnvironmentId = () => "m4";
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set(["m4"]);
export const useEnvironment = () => null;
export const useNavigate = () => () => undefined;
export const useLocation = () => ({ hash: "", pathname: "/settings" });
export const usePrimarySettingsAvailable = () => true;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "";
export const useSettings = () => ({});
export const useUpdateSettings = () => () => undefined;
export const useClearProjectOverrides = () => () => undefined;
export const useClearScopedSettings = () => () => undefined;
export const isProjectScopedSettingKey = () => false;
export const scopedSettingsAreMixed = () => false;
export const scopedSettingsSource = () => null;
export const listProjectOverrides = () => [];
export const isArchivedMember = () => false;
export const SettingInheritance = () => null;
export const SettingsScopeSentence = () => null;
export const WorkspacePageContainer = ({ children }: { readonly children: ReactNode }) => (
  <div>{children}</div>
);

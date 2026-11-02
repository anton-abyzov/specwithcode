import type { ReactNode } from "react";

// The fixture stands in for one connected machine with write access.
export const usePrimaryEnvironmentId = () => "m4";
export const useEnvironmentScope = () => true;
export const useEnvironmentsWithScope = () => new Set(["m4"]);
export const useEnvironment = () => null;
export const useNavigate = () => () => undefined;
export const Link = ({ children }: { readonly children: ReactNode }) => <a href="#">{children}</a>;
export const useMachineNickname = (_environmentId: string, label?: string) => label ?? "";
export const useMachineNicknames = () => (_id: string, label?: string) => label ?? "";
export const RenameMachineDialog = () => null;
export const HandoffModeSettings = () => null;
export const MachineWorkGrants = () => null;
export const usePrimaryFleet = () => null;
export const useMachineWorkGrants = () => null;
export const useStudioFleet = () => ({ snapshot: null });
export const useHostLimitBlocks = () => [];
export const useProjects = () => [];
export const useServerConfigs = () => new Map();
export const useEnvironments = () => ({ environments: [] });
export const readEnvironmentScope = () => true;
export const useClientSettings = () => false;
export const useUpdateClientSettings = () => () => undefined;
export const createServerPairingCredential = () => Promise.reject(new Error("fixture"));
export const readPrimaryEnvironmentTarget = () => null;
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

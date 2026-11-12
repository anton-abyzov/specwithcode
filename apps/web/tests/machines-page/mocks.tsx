import type { ReactNode } from "react";

export const Link = ({ children }: { children: ReactNode }) => (
  <a href="#connections">{children}</a>
);
export const useAtomValue = () => null;
export const desktopNetworkAccessStateAtom = null;
export const useProjects = () => [];
export const useServerConfigs = () => new Map();
export const useEnvironments = () => ({ environments: [] });
export const useEnvironmentScope = (id: string) => id !== "env-phone";
export const readEnvironmentScope = () => true;
export const useEnvironmentScopeAccess = (id: string) =>
  id === "env-phone" ? "denied" : "granted";
export const useMachineWorkGrants = () => ({ snapshot: null });
export const useStudioFleet = () => ({ snapshot: null });
export const addVisibleMachineToStudioFleet = async () => undefined;
export const useMachineNickname = (_id: string, label: string) => label;
export const useMachineNicknames = () => (_id: string, label: string) => label;
export const createServerPairingCredential = async () => undefined;
export const readPrimaryEnvironmentTarget = () => null;
export const isThisMachineTarget = () => false;
export const machineStatus = () => ({ text: "Connected" });
export const useHostLimitBlocks = () => [];
export const usePrimaryFleet = () => null;
export const MachineWorkGrants = () => null;
export const HandoffModeSettings = () => null;
export const RenameMachineDialog = () => null;
export const requestConfirmDialog = async () => true;
export const managedUpdates = { status: () => null, enroll: null, revoke: null, check: null };
export const useEnvironmentQuery = () => ({ data: null, error: null, failure: null, refresh() {} });
export const useAtomCommand = () => async () => ({ _tag: "Success" });
export const ServerUpdateProgress = () => null;
export const serverEnvironment = { configValueAtom: () => null, updateSettings: null };
export const toastManager = { add: () => undefined };
export const stackedThreadToast = (toast: unknown) => toast;

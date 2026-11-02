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

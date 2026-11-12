export const useMachineIdentity = () => ({
  color: "blue",
  name: "Build machine",
  icon: "linux",
  environmentId: "build",
});
export const machineColorProps = (identity: any) =>
  identity ? { "data-machine-color": identity.color } : {};
export const useMachineNickname = (_id: string, label: string) => label;
export const useNowMinute = () => 0;
export const nowFromMinute = () => 0;
export const useMachineLastSeenVersion = () => 0;
export const machineLastSeenAt = () => null;
export const useAtomCommand = () => () => {};
export const highestEpoch = () => 0;
export const projectLink = {};
export const requestAway = () => {};
export const requestMigrateProjectThreads = () => {};
export const toastManager = { add: () => {} };
export const VoiceConsentDialog = () => null;
export function VoiceSettings({ controlledOpen }: { controlledOpen?: boolean }) {
  return controlledOpen ? <div role="dialog">Voice settings</div> : null;
}

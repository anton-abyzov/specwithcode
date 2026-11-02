import type { ComponentProps } from "react";

export const Link = ({ to, ...props }: ComponentProps<"a"> & { to: string }) => (
  <a href={to} {...props} />
);
export const useAtomValue = () => [];
export const useClientSettings = () => false;
export const useUpdateClientSettings = () => () => undefined;
export const usePrimaryEnvironmentId = () => null;
export const useEnvironmentQuery = () => ({ data: null, error: null });
export const primaryServerProvidersAtom = null;
export const primaryServerConfigAtom = null;
export const useClientSettingsHydrated = () => true;
export const serverEnvironment = { scheduledTasksLive: () => null };

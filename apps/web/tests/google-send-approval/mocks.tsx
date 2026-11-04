import type { ReactNode } from "react";
const refresh = () => {};
const status = {
  clientConfigured: true,
  clientSource: "studio",
  clientId: null,
  connected: false,
  email: null,
  accounts: [],
  services: [],
  projects: [],
  signIn: null,
  lastError: null,
};
export const usePrimaryEnvironmentId = () => "fixture";
export const useEnvironmentScope = () => true;
export const useProjects = () => [];
export const useAideEnabled = () => false;
export const useServerConfigs = () =>
  new Map([["fixture", { environment: { capabilities: { googleAccount: true } } }]]);
export const useEnvironmentQuery = () => ({ data: status, refresh, isLoading: false });
export const serverEnvironment = new Proxy({}, { get: () => () => ({}) });
export const useAtomCommand = () => async () => {
  throw new Error("Account mutation forbidden in offline fixture");
};
export const SettingsPageContainer = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);
export const SettingsSection = ({ children, title }: { children: ReactNode; title: string }) => (
  <section className="rounded border p-2">
    <h2>{title}</h2>
    {children}
  </section>
);

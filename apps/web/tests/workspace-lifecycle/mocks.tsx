import { createContext, useContext, type ReactNode } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@specweave-studio/contracts";
export const FixtureContext = createContext({
  settings: DEFAULT_SERVER_SETTINGS,
  update: (_patch: ServerSettingsPatch) => {},
  multi: false,
});
export function useSettingsScope() {
  const { settings, multi } = useContext(FixtureContext);
  const environment = {
    environmentId: "fixture-machine",
    serverConfig: {
      environment: {
        defaultWorktreesDirectory: "/Users/example/.specwithcode/worktrees",
        capabilities: {
          worktreesDirectory: true,
          worktreeLocationMode: true,
          storageCleanup: true,
        },
      },
    },
  };
  return {
    scope: {
      kind: "checkout",
      members: [
        {
          environmentId: "fixture-machine",
          workspaceRoot: "/Users/example/projects/river",
          workspaceSettings: {
            ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
            environment: {
              additionalFolders: [],
              repositories: [
                {
                  id: "river",
                  url: "https://github.com/example/river.git",
                  localPath: "/Users/example/projects/river",
                },
              ],
            },
          },
        },
      ],
    },
    targets: [{ environmentId: "fixture-machine", settings }],
    connectedEnvironments: multi
      ? [environment, { ...environment, environmentId: "fixture-second" }]
      : [environment],
  };
}
export const useScopedSettings = () => useContext(FixtureContext).settings;
export const useUpdateScopedSettings = () => useContext(FixtureContext).update;
export const useClearScopedSettings = () => () => {};
export const useScopedSettingsMixed = () => false;
export function SettingsRow({
  title,
  description,
  control,
  resetAction,
}: {
  title: string;
  description: ReactNode;
  control: ReactNode;
  resetAction?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-border py-5 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-md">
        <div className="flex gap-2 font-medium">
          {title}
          {resetAction}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="sm:min-w-48">{control}</div>
    </section>
  );
}
export const SettingResetButton = ({ onClick }: { onClick: () => void }) => (
  <button className="text-xs text-muted-foreground underline" onClick={onClick}>
    Reset
  </button>
);
export const SettingsPageContainer = ({ children }: { children: ReactNode }) => children;
export const SettingsSection = ({ children }: { children: ReactNode }) => children;
export const SettingsScopeNotice = () => null;

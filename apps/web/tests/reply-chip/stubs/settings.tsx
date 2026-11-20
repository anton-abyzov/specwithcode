// The fixture's settings: `?style=detailed|mixed` the project's reply style.
import type { PropsWithChildren } from "react";

const params = new URLSearchParams(location.search);
const style = params.get("style") ?? "concise";
const client = { timelineDetail: "normal", threadTimelineDetail: {} };

export const useSettingsProjectGroups = () => [
  { projectKey: "fixture", memberProjects: [{ environmentId: "env", id: "project" }] },
];
export const SettingsScopeProvider = ({ children }: PropsWithChildren) => children;
export const useScopedSettings = (select: (settings: { responseStyle: string }) => unknown) =>
  select({ responseStyle: style === "mixed" ? "concise" : style });
export const useScopedSettingsMixed = () => style === "mixed";
export const useScopedSettingsWriteAllowed = () => true;
export const useUpdateScopedSettings = () => () => {};
export const useClientSettings = (select: (settings: typeof client) => unknown) => select(client);
export const getClientSettings = () => client;
export const persistClientSettingsPatch = async () => {};
export const useAtomValue = () => [];
export const primaryServerKeybindingsAtom = null;

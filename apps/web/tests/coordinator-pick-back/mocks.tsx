import { Atom } from "effect/reactivity";
import { DEFAULT_UNIFIED_SETTINGS, type ServerProvider } from "@specweave-studio/contracts";
import type * as React from "react";
import { useSyncExternalStore } from "react";

// Synthetic data only: the October 24 report. The coordinator's saved pick is Codex
// GPT-6.1-Sol with 4% of its weekly limit left, and Devin runs as its fallback.
export const scenario = new URLSearchParams(location.search).get("state") ?? "fallback";
const checkedAt = new Date(Date.now() - 2 * 60_000).toISOString();
const models = [
  { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", isDefault: true },
  { slug: "gpt-6-astra", name: "GPT-6-Astra" },
  { slug: "gpt-6-sol", name: "GPT-6-Sol" },
];
const provider = (
  id: string,
  driver: string,
  name: string,
  extra: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: id,
    driver,
    displayName: name,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", type: "subscription" },
    version: "fixture",
    checkedAt,
    models,
    slashCommands: [],
    skills: [],
    ...extra,
  }) as never;
export const providers = [
  provider("codex", "codex", "Codex", {
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 96,
          windowDurationMins: 7 * 24 * 60,
          resetsAt: new Date(Date.now() + (5 * 24 + 19) * 3_600_000).toISOString(),
        },
      ],
    },
  } as never),
  provider("devin_work", "acpRegistry", "Devin"),
];
export const settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    devin_work: {
      driver: "acpRegistry",
      enabled: true,
      displayName: "Devin",
      config: { agentId: "devin" },
    },
  },
};
export const primaryServerKeybindingsAtom = Atom.make({ bindings: [], warnings: [] });
const listeners = new Set<() => void>();
let revision = 0;
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};
const changed = () => {
  revision += 1;
  for (const listener of listeners) listener();
};
export const events = { switchBacks: 0, selections: [] as unknown[] };
export const useFixtureEvents = () => {
  useSyncExternalStore(subscribe, () => revision);
  return events;
};
export const recordSwitchBack = () => {
  events.switchBacks += 1;
  changed();
};
export const recordSelection = (value: unknown) => {
  events.selections.push(value);
  changed();
};
export const useEnvironment = () => ({
  serverConfig: { providers },
  label: "MacBook M4MAX",
  connection: { phase: "connected" },
});
export const useEnvironmentSettings = () => settings;
export const useClientSettings = (select: (value: typeof settings) => unknown) => select(settings);
export const useUpdateClientSettings = () => () => {};
export const useNavigate = () => () => {
  throw new Error("Fixture forbids navigation");
};
export const TraitsPicker = () => null;
export const TraitsMenuContent = () => null;
export const shouldRenderTraitsControls = () => false;
export const useParams = () => ({});
export const serverEnvironment = { refreshProviders: Symbol("fixture-refresh-providers") };
export const useEnvironmentScope = () => true;
export const readEnvironmentScope = useEnvironmentScope;
export const useAtomCommand = () => () => {
  throw new Error("Fixture forbids provider commands");
};
export const ModelBadge = () => <span>Saved model</span>;
export const ModelBadgeMark = () => null;
export const ChatGptSharingControl = () => null;
export const readPreparedConnection = () => {
  throw new Error("Fixture forbids remote connections");
};
export const environmentSession = {};
export const environmentServerConfigsAtom = Atom.make(new Map());
export const usePrimarySettings = () => settings;
export const Link = (props: { children?: React.ReactNode }) => <a>{props.children}</a>;

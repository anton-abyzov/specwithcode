import { Atom } from "effect/reactivity";
import { DEFAULT_UNIFIED_SETTINGS, type ServerProvider } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

export const scenario = new URLSearchParams(location.search).get("state") ?? "ready";
export const recoveryScenario = scenario.startsWith("recovery");
const provider = (id: string, driver: string, name: string, ready: boolean): ServerProvider => ({
  instanceId: id as never,
  driver: driver as never,
  displayName: name,
  enabled: true,
  ...(scenario === "unavailable" ? { availability: "unavailable" as const } : {}),
  installed: ready,
  status: ready ? "ready" : "error",
  auth: { status: ready ? "unknown" : "unauthenticated" },
  setup: { canAuthenticate: true, canInstall: false },
  version: "fixture",
  checkedAt: "2026-10-13T00:00:00.000Z",
  models: ready ? [{ slug: "default", name: "Default", isDefault: true }] : [],
  slashCommands: [],
  skills: [],
  ...(ready ? {} : { message: "Sign in to GitHub Copilot on this machine." }),
});
export let providers = recoveryScenario
  ? [
      {
        ...provider("codex-work", "codex", "Codex work", false),
        availability: "unavailable" as const,
      },
      provider("codex", "codex", "Codex", true),
      provider("gemini_work", "acpRegistry", "Gemini CLI", true),
    ]
  : scenario === "empty"
    ? []
    : [
        provider("codex", "codex", "Codex", scenario !== "unavailable"),
        provider("copilot_work", "acpRegistry", "GitHub Copilot", false),
        ...(scenario === "connected"
          ? [provider("gemini_work", "acpRegistry", "Gemini CLI", true)]
          : []),
      ];
if (scenario === "muse") {
  providers = [
    {
      ...provider("muse_work", "muse", "Muse Code", true),
      auth: { status: "authenticated", type: "subscription" },
      models: [
        { slug: "muse-wonder-1.0", name: "Muse Wonder", isDefault: true },
        { slug: "muse-wonder-full", name: "Muse Wonder Full" },
      ],
    },
  ];
}
export const settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerInstances: {
    muse_work: {
      driver: "muse",
      enabled: true,
      displayName: "Muse Code",
      config: { binaryPath: "muse" },
    },
    "codex-work": { driver: "codex", enabled: true, displayName: "Codex work", config: {} },
    copilot_work: {
      driver: "acpRegistry",
      enabled: true,
      displayName: "GitHub Copilot",
      config: { agentId: "github-copilot-cli" },
    },
    gemini_work: {
      driver: "acpRegistry",
      enabled: true,
      displayName: "Gemini CLI",
      config: { agentId: "gemini" },
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
const snapshot = () => revision;
const changed = () => {
  revision += 1;
  for (const listener of listeners) listener();
};
const events = { commands: [] as unknown[], selections: [] as unknown[] };
let finishRefresh: ((value: { _tag: "Success" | "Failure" }) => void) | null = null;
export const useFixtureEvents = () => {
  useSyncExternalStore(subscribe, snapshot);
  return events;
};
export const recordSelection = (value: unknown) => {
  events.selections.push(value);
  changed();
};
export const completeRefresh = () => {
  if (!finishRefresh) throw new Error("No fixture refresh is pending");
  const fail = scenario === "recovery-failure" && events.commands.length === 1;
  if (!fail)
    providers = providers.map((entry) =>
      entry.instanceId === "codex-work"
        ? provider("codex-work", "codex", "Codex work", true)
        : entry,
    );
  const finish = finishRefresh;
  finishRefresh = null;
  changed();
  finish({ _tag: fail ? "Failure" : "Success" });
};
export const useEnvironment = () => {
  useSyncExternalStore(subscribe, snapshot);
  return { serverConfig: { providers }, label: "Remote worker" };
};
export const useEnvironmentSettings = () => settings;
export const useClientSettings = (select: (value: typeof settings) => unknown) => select(settings);
export const useUpdateClientSettings = () => () => {};
export const useNavigate = () => (input: unknown) => {
  const output = document.querySelector("[data-testid=navigation]")!;
  output.textContent = JSON.stringify(input);
};
export const TraitsPicker = () => null;
export const TraitsMenuContent = () => null;
export const shouldRenderTraitsControls = () => false;
export const useParams = () => ({});
export const serverEnvironment = { refreshProviders: Symbol("fixture-refresh-providers") };
export const useEnvironmentScope = () => scenario !== "recovery-readonly";
export const readEnvironmentScope = useEnvironmentScope;
export const useAtomCommand = (command: unknown) => {
  if (command !== serverEnvironment.refreshProviders)
    throw new Error("Fixture forbids provider turns and non-refresh commands");
  return (input: unknown) => {
    if (finishRefresh) throw new Error("Duplicate fixture refresh");
    events.commands.push({ command: "refreshProviders", input });
    changed();
    return new Promise<{ _tag: "Success" | "Failure" }>((resolve) => {
      finishRefresh = resolve;
    });
  };
};
export const ModelBadge = () => <span>Saved model</span>;
export const ModelBadgeMark = () => null;
export const ChatGptSharingControl = () => null;

export const readPreparedConnection = () => {
  throw new Error("Fixture forbids remote connections");
};
export const environmentSession = {};
export const environmentServerConfigsAtom = Atom.make({});

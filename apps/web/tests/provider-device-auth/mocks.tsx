import { useSyncExternalStore, type ReactNode } from "react";
import type {
  ProviderAuthState,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";

// No transport, credentials, provider process, browser or clipboard API exists in this fixture.
export const calls: unknown[] = [];
let revision = 0;
let generation = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
export const useRevision = () => useSyncExternalStore(subscribe, () => revision);
export let connected = true;
export let readOnly = false;
export let copyFails = false;
export let browserFails = false;
export const states: Record<string, ProviderAuthState> = {};
export function idle(environmentId: string): ProviderAuthState {
  return {
    instanceId: "copilot-work" as never,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    interaction: null,
    methods: [{ id: "github", name: "GitHub", description: null, type: "terminal" }],
  };
}
for (const environment of ["m1", "m3"]) states[environment] = idle(environment);
export function wait(environmentId: string, kind: "terminal" | "deviceCode" = "terminal") {
  const code = environmentId === "m1" ? "MONE-1111" : "MTHR-3333";
  const deviceCode = { url: "https://github.com/login/device", userCode: code };
  states[environmentId] = {
    ...idle(environmentId),
    phase: "waiting",
    flowId: `flow-${environmentId}-${++generation}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    interaction:
      kind === "deviceCode"
        ? { type: "deviceCode", id: `interaction-${environmentId}`, ...deviceCode }
        : ({
            type: "terminal",
            id: `interaction-${environmentId}`,
            deviceCode,
            output: "Confirm credential storage when prompted.",
            outputOffset: 42,
          } as ProviderAuthState["interaction"]),
  };
  changed();
}
export function phase(
  environmentId: string,
  value: ProviderAuthState["phase"],
  message: string | null = null,
) {
  // Deliberately retain old interaction/URL: the UI must not offer a completed/expired code.
  states[environmentId] = { ...states[environmentId]!, phase: value, message };
  changed();
}
/** What each machine reports about the provider; nothing here signs anyone in. */
export const providerAuth: Record<string, ServerProvider["auth"]["status"]> = {};
export const fixtureProvider = (environmentId: string): ServerProvider => ({
  instanceId: "copilot-work" as ProviderInstanceId,
  driver: "acpRegistry" as never,
  displayName: "GitHub Copilot",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: providerAuth[environmentId] ?? "unknown" },
  setup: { canAuthenticate: true, canInstall: false },
  checkedAt: "2026-10-14T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});
export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];
/** Stands in for `@effect/atom-react` in the wizard step: the atom is the machine id. */
export const useAtomValue = (environmentId: string) => {
  useRevision();
  return [fixtureProvider(environmentId)];
};
export const serverEnvironment = {
  providersValueAtom: (environmentId: string) => environmentId,
  providerAuthState: (target: unknown) => target,
  startProviderAuth: "start",
  respondProviderAuth: "respond",
  completeProviderAuth: "complete",
  cancelProviderAuth: "cancel",
  logoutProviderAuth: "logout",
};
export const useEnvironmentQuery = (target: { environmentId: string }) => {
  useRevision();
  return { data: states[target.environmentId], error: null };
};
export const useAtomCommand =
  (command: string) =>
  async (target: {
    environmentId: string;
    input: { instanceId: string; flowId?: string; interactionId?: string; response?: unknown };
  }) => {
    if (target.input.instanceId !== "copilot-work" || !states[target.environmentId])
      throw new Error("Wrong destination instance");
    if (target.input.flowId && target.input.flowId !== states[target.environmentId]?.flowId)
      throw new Error("Wrong destination flow");
    calls.push({ command, ...target });
    if (command === "start") wait(target.environmentId);
    if (command === "cancel") phase(target.environmentId, "cancelled");
    return { _tag: "Success", value: undefined };
  };
export const isAtomCommandInterrupted = () => false;
export const squashAtomCommandFailure = () => new Error("Fixture command failed");
export const writeTextToClipboard = async (value: string, label: string) => {
  if (copyFails) throw new Error("Clipboard unavailable");
  calls.push({ command: "clipboard", client: "m4", value, label });
};
export const ensureLocalApi = () => ({
  shell: {
    openExternal: async (url: string) => {
      if (browserFails) throw new Error("Browser unavailable");
      calls.push({ command: "openExternal", client: "m4", url });
    },
  },
  dialogs: { confirm: async () => false },
});
// Settings scope infrastructure is outside this fixture; use its normal row geometry.
export function SettingsRow({
  title,
  description,
  status,
  control,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  status: ReactNode;
  control: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="@container/settings-row rounded-xl px-3 pt-3 pb-1 sm:px-4">
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <div className="text-xs text-muted-foreground">{description}</div>
          <div className="text-xs">{status}</div>
        </div>
        <div className="flex min-w-0 items-center gap-2">{control}</div>
      </div>
      {children}
    </div>
  );
}
/** The wizard step's group is layout only; the real one reads settings scope. */
export function SettingsGroup({ children }: { children: ReactNode }) {
  return <div className="grid gap-2">{children}</div>;
}
Object.assign(window, {
  __deviceAuthFixture: {
    calls,
    states,
    wait,
    phase,
    /** Sets what a machine reports about the provider's sign-in. */
    providerStatus: (environmentId: string, status: ServerProvider["auth"]["status"]) => {
      providerAuth[environmentId] = status;
      changed();
    },
    /** Replaces a machine's sign-in state with an idle one plus this patch. */
    reset: (environmentId: string, patch: Partial<ProviderAuthState> = {}) => {
      states[environmentId] = { ...idle(environmentId), ...patch };
      changed();
    },
    clearCalls: () => {
      calls.length = 0;
    },
    connection: (value: boolean) => {
      connected = value;
      changed();
    },
    readonly: (value: boolean) => {
      readOnly = value;
      changed();
    },
    failures: (clipboard: boolean, browser: boolean) => {
      copyFails = clipboard;
      browserFails = browser;
    },
  },
});

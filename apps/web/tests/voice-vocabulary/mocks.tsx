import { createContext, type ReactNode, useSyncExternalStore } from "react";
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";

const params = new URLSearchParams(location.search);
/** darwin or linux. */
export const mode = params.get("mode") ?? "linux";
export const theme = params.get("theme") === "light" ? "light" : "dark";

let settings = {
  voiceCallsAllowed: true,
  dictationLanguage: params.get("language") ?? "",
  dictationMode: "toggle" as const,
};
const listeners = new Set<() => void>();
export const isElectron = true;
export const primaryServerConfigAtom = {};
export const primaryServerKeybindingsAtom = {};
export const serverEnvironment = { updateSettings: {} };
export const useAtomValue = () => ({});
export const RegistryContext = createContext({});
export const useAtomCommand = () => async () => ({ _tag: "Success", value: {} });
export const usePrimaryEnvironmentId = () => "isolated-fixture";
export const useClientSettings = (select: (value: typeof settings) => unknown) =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(settings),
  );
export const useUpdateClientSettings = () => (patch: Partial<typeof settings>) => {
  settings = { ...settings, ...patch };
  document.body.dataset.language = settings.dictationLanguage || "system";
  for (const listener of listeners) listener();
};
export const usePrimarySettings = () => DEFAULT_SERVER_SETTINGS.voice;
export const playCallAudio = async () => {};
export const shortcutLabelForCommand = () => (mode === "linux" ? "Ctrl+Shift+D" : "⌘⇧D");
export const useTx = () => (text: string) => text;
export const Link = ({ children, className }: { children: ReactNode; className?: string }) => (
  <a className={className}>{children}</a>
);

/**
 * Stand-ins for the settings row chrome, which needs the whole settings route.
 * The control inside the row is the real one.
 */
export const searchableSetting = (id: string) => ({
  id,
  title: id === "dictation-language" ? "Dictation language" : "Dictation shortcut",
});
export function SettingsRow({
  title,
  description,
  control,
  resetAction,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  resetAction?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border py-4">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {title}
          {resetAction}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
export const SettingResetButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    type="button"
    className="text-xs underline"
    aria-label={`Reset ${label} to default`}
    onClick={onClick}
  >
    Reset
  </button>
);

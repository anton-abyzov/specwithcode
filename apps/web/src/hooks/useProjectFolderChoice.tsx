import { useCallback, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { NewProjectFolderPicker } from "../components/studio/NewProjectFolderPicker";

const REMEMBERED_KEY = "studio:new-project-parent:v1";

function readRemembered(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REMEMBERED_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeRemembered(choices: Record<string, string>): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(choices));
  } catch {
    // Storage can be full or disabled; the choice still holds for this session.
  }
}

/**
 * One chosen parent folder per machine, so switching machines and back keeps
 * each choice. With `remember`, the last folder a person chose on a machine is
 * offered again next time instead of starting over from the home folder.
 */
export function useProjectFolderChoice(
  environmentId: EnvironmentId | null,
  busy: boolean,
  options: {
    readonly remember?: boolean;
    readonly defaultPath?: string | null;
    readonly nativePicker?: {
      readonly label: string;
      readonly pick: (initialPath: string | null) => Promise<string | null>;
    } | null;
  } = {},
) {
  const remember = options.remember === true;
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    remember ? readRemembered() : {},
  );
  const reset = useCallback(() => setChoices({}), []);
  const path = environmentId === null ? null : (choices[environmentId] ?? null);
  const select = (target: EnvironmentId, chosen: string) => {
    if (remember) writeRemembered({ ...readRemembered(), [target]: chosen });
    setChoices((previous) => ({ ...previous, [target]: chosen }));
  };
  return {
    path,
    reset,
    picker:
      environmentId === null ? null : (
        <NewProjectFolderPicker
          key={environmentId}
          environmentId={environmentId}
          selectedPath={path}
          defaultPath={options.defaultPath ?? null}
          nativePickerLabel={options.nativePicker?.label ?? null}
          disabled={busy}
          onSelect={(chosen) => select(environmentId, chosen)}
          {...(options.nativePicker ? { onPickNatively: options.nativePicker.pick } : {})}
        />
      ),
  };
}

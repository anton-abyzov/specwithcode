import { useCallback, useRef, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import type { FolderPlace } from "../components/studio/FolderBrowser";
import type { KnownProject } from "../components/studio/folderBrowser.logic";
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
    /** The machine being browsed, named in the picker so its folders are never taken for this device's. */
    readonly machineLabel?: string | null;
    /** The project's name, so the picker can say exactly which folder is made. */
    readonly projectName?: string;
    readonly places?: readonly FolderPlace[];
    /** Projects already on the machine, marked in the folder list. */
    readonly projects?: readonly KnownProject[];
    readonly canCreateFolder?: boolean;
    readonly nativePicker?: {
      readonly label: string;
      readonly pick: (initialPath: string | null) => Promise<string | null>;
    } | null;
  } = {},
) {
  const remember = options.remember === true;
  // A folder counts as chosen once the picker has listed it, so a remembered
  // folder that has since gone is never created into blind.
  const [choices, setChoices] = useState<Record<string, string>>({});
  // Where each machine's picker opens: the folder last shown there, or the
  // one remembered from an earlier project.
  const lastShown = useRef<Record<string, string>>(remember ? readRemembered() : {});
  const [generation, setGeneration] = useState(0);
  const reset = useCallback(() => {
    setChoices({});
    setGeneration((value) => value + 1);
    lastShown.current = remember ? readRemembered() : {};
  }, [remember]);
  const path = environmentId === null ? null : (choices[environmentId] ?? null);
  // Null means the folder shown cannot be chosen right now (loading, or
  // unreadable). The remembered folder stays, to be offered again next time.
  const select = (target: EnvironmentId, chosen: string | null) => {
    if (chosen === null) {
      setChoices(({ [target]: _dropped, ...rest }) => rest);
      return;
    }
    lastShown.current = { ...lastShown.current, [target]: chosen };
    if (remember) writeRemembered({ ...readRemembered(), [target]: chosen });
    setChoices((previous) => ({ ...previous, [target]: chosen }));
  };
  return {
    path,
    reset,
    picker:
      environmentId === null ? null : (
        <NewProjectFolderPicker
          key={`${environmentId}:${generation}`}
          environmentId={environmentId}
          selectedPath={path ?? lastShown.current[environmentId] ?? null}
          defaultPath={options.defaultPath ?? null}
          machineLabel={options.machineLabel ?? null}
          nativePickerLabel={options.nativePicker?.label ?? null}
          places={options.places ?? []}
          projects={options.projects ?? []}
          canCreateFolder={options.canCreateFolder === true}
          {...(options.projectName === undefined ? {} : { projectName: options.projectName })}
          disabled={busy}
          onSelect={(chosen) => select(environmentId, chosen)}
          {...(options.nativePicker ? { onPickNatively: options.nativePicker.pick } : {})}
        />
      ),
  };
}

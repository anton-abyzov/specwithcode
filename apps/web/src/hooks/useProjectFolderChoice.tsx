import { useCallback, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import type { FolderPlace } from "../components/studio/FolderBrowser";
import { sameFolder, type KnownProject } from "../components/studio/folderBrowser.logic";
import { NewProjectFolderPicker } from "../components/studio/NewProjectFolderPicker";
import { withRecentFolder } from "../components/studio/pathField.logic";

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

const RECENT_KEY = "studio:recent-folders:v1";

function readAllRecent(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([machine, folders]) =>
        Array.isArray(folders)
          ? [[machine, folders.filter((folder): folder is string => typeof folder === "string")]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

function writeAllRecent(recent: Record<string, string[]>): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Storage can be full or disabled; recent folders are a convenience.
  }
}

/** Folders a person confirmed in an address bar on this machine, newest first. */
export function readRecentFolders(environmentId: EnvironmentId | null): string[] {
  return environmentId === null ? [] : (readAllRecent()[environmentId] ?? []);
}

/** Call when a folder is added or chosen for a project, not for every folder opened on the way. */
export function rememberRecentFolder(environmentId: EnvironmentId, path: string): void {
  // App storage and other hidden folders are not places to suggest.
  if (/[\\/]\.[^\\/]+([\\/]|$)/.test(path)) return;
  const all = readAllRecent();
  writeAllRecent({ ...all, [environmentId]: withRecentFolder(all[environmentId] ?? [], path) });
}

/** A recent folder the machine no longer has. */
export function forgetRecentFolder(environmentId: EnvironmentId, path: string): void {
  const all = readAllRecent();
  const kept = (all[environmentId] ?? []).filter((folder) => !sameFolder(folder, path));
  if (kept.length !== (all[environmentId] ?? []).length) {
    writeAllRecent({ ...all, [environmentId]: kept });
  }
}

const NO_PLACES: readonly FolderPlace[] = [];

/** Adds the folder used last time to the Recent places, unless it is listed already. */
export function withRememberedPlace(
  places: readonly FolderPlace[],
  remembered: string | undefined,
): readonly FolderPlace[] {
  if (
    remembered === undefined ||
    // App storage and other hidden folders are not places to suggest.
    /[\\/]\.[^\\/]+([\\/]|$)/.test(remembered) ||
    places.some((place) => sameFolder(place.path, remembered))
  ) {
    return places;
  }
  const label =
    remembered
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || remembered;
  const firstRecent = places.findIndex((place) => place.kind === "recent");
  const at = firstRecent < 0 ? places.length : firstRecent;
  return [...places.slice(0, at), { kind: "recent", label, path: remembered }, ...places.slice(at)];
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
  const [lastShown, setLastShown] = useState<Record<string, string>>(() =>
    remember ? readRemembered() : {},
  );
  // The folder chosen for an earlier project on each machine, kept as a place
  // to return to after browsing away from it.
  const [remembered, setRemembered] = useState<Record<string, string>>(() =>
    remember ? readRemembered() : {},
  );
  const [generation, setGeneration] = useState(0);
  const reset = useCallback(() => {
    setChoices({});
    setGeneration((value) => value + 1);
    setLastShown(remember ? readRemembered() : {});
    setRemembered(remember ? readRemembered() : {});
  }, [remember]);
  const path = environmentId === null ? null : (choices[environmentId] ?? null);
  // Null means the folder shown cannot be chosen right now (loading, or
  // unreadable). The remembered folder stays, to be offered again next time.
  const select = (target: EnvironmentId, chosen: string | null) => {
    if (chosen === null) {
      setChoices(({ [target]: _dropped, ...rest }) => rest);
      return;
    }
    setLastShown((previous) => ({ ...previous, [target]: chosen }));
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
          selectedPath={path ?? lastShown[environmentId] ?? null}
          defaultPath={options.defaultPath ?? null}
          machineLabel={options.machineLabel ?? null}
          nativePickerLabel={options.nativePicker?.label ?? null}
          places={withRememberedPlace(options.places ?? NO_PLACES, remembered[environmentId])}
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

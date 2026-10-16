import type { SettingsScopeSearch } from "./settingsScope";

/**
 * What a settings page writes to.
 * - `project`: the Project pages; a picked project edits its own settings.
 * - `global`: App and Agents pages; one value for every project, written to
 *   every connected machine. They have no picker.
 * - `machine`: pages that differ by machine (providers, source control,
 *   storage, accounts); a machine picker appears once there is more than one.
 */
export type SettingsPageScope = "project" | "global" | "machine";

export const SETTINGS_PROJECT_PATHS: ReadonlySet<string> = new Set([
  "/settings/projects",
  "/settings/skills",
]);

export const SETTINGS_GLOBAL_PATHS: ReadonlySet<string> = new Set([
  "/settings/general",
  "/settings/appearance",
  "/settings/keybindings",
  "/settings/snap-shot",
  "/settings/privacy",
  "/settings/archived",
  "/settings/agents",
  "/settings/scheduled-tasks",
  "/settings/mods",
]);

/** Provider setup always belongs to exactly one machine; it has no "all machines" choice. */
export const SETTINGS_SINGLE_MACHINE_PATHS: ReadonlySet<string> = new Set(["/settings/providers"]);

export function settingsPageScope(pathname: string): SettingsPageScope {
  if (SETTINGS_PROJECT_PATHS.has(pathname)) return "project";
  if (SETTINGS_GLOBAL_PATHS.has(pathname)) return "global";
  return "machine";
}

/**
 * The scope a page resolves. The URL keeps the remembered project so the
 * Project pages still open on it, but only those pages read it; global pages
 * ignore the machine too, so a change applies everywhere.
 */
export function effectiveSettingsSearch(
  pathname: string,
  search: SettingsScopeSearch,
): SettingsScopeSearch {
  switch (settingsPageScope(pathname)) {
    case "project":
      return search;
    case "global":
      return {};
    case "machine":
      return search.machine ? { machine: search.machine } : {};
  }
}

/** A page's scope change written back to the URL without dropping the remembered project. */
export function settingsSearchAfterScopeChange(
  pathname: string,
  current: SettingsScopeSearch,
  next: SettingsScopeSearch,
): SettingsScopeSearch {
  if (settingsPageScope(pathname) === "project") return next;
  return {
    ...(current.project ? { project: current.project } : {}),
    ...(next.machine ? { machine: next.machine } : {}),
  };
}

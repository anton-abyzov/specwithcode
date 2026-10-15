import type { EnvironmentId } from "@specweave-studio/contracts";
import { redirect } from "@tanstack/react-router";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import type { SettingsScopeSearch } from "./settingsScope";

/**
 * The logical project of the page the user was on before opening Settings.
 * Written while the app shows a non-settings page, read once when the settings
 * route is entered, so every entry point (menu, ⌘,, palette, in-page links)
 * opens Settings already scoped to that project.
 */
let originProjectKey: string | null = null;

export function rememberSettingsOriginProject(projectKey: string | null): void {
  originProjectKey = projectKey;
}

export function readSettingsOriginProject(): string | null {
  return originProjectKey;
}

/** The project page names its project; a thread or draft names one of its checkouts. */
export function resolveSettingsOriginProjectKey(input: {
  routeProjectKey: string | null;
  projectRef: { environmentId: EnvironmentId; projectId: string } | null;
  groups: readonly Pick<SidebarProjectSnapshot, "projectKey" | "memberProjects">[];
}): string | null {
  if (input.routeProjectKey !== null) return input.routeProjectKey;
  const ref = input.projectRef;
  if (ref === null) return null;
  return (
    input.groups.find((group) =>
      group.memberProjects.some(
        (member) => member.environmentId === ref.environmentId && member.id === ref.projectId,
      ),
    )?.projectKey ?? null
  );
}

/**
 * The scope Settings opens with. A link that names a project or environment
 * keeps it. Otherwise the origin project is selected; a `checkout` without a
 * project (carried over from the project page's own `?checkout=`) is dropped.
 * Returns null when the search is already right.
 */
export function settingsEntrySearch(
  search: SettingsScopeSearch,
  originProject: string | null,
): SettingsScopeSearch | null {
  if (search.project !== undefined || search.machine !== undefined) return null;
  if (originProject !== null) return { project: originProject };
  return search.checkout === undefined ? null : {};
}

/**
 * Settings route `beforeLoad` step: on entry, redirect to the same page with
 * the origin project selected; the bare `/settings` index lands on General.
 */
export function redirectSettingsEntry(input: {
  location: { pathname: string; hash: string; search: object };
  search: SettingsScopeSearch;
  cause: "preload" | "enter" | "stay";
}): void {
  const { location, search, cause } = input;
  const entry = cause === "enter" ? settingsEntrySearch(search, readSettingsOriginProject()) : null;
  if (entry === null) {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
    return;
  }
  throw redirect({
    to: location.pathname === "/settings" ? "/settings/general" : location.pathname,
    // Every axis is sent so the retain middleware treats this as an explicit target.
    search: {
      ...location.search,
      project: entry.project,
      machine: entry.machine,
      checkout: entry.checkout,
    },
    hash: location.hash,
    replace: true,
  });
}

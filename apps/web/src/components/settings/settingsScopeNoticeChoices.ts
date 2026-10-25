import { PERSONAL_ASSISTANT_LABEL } from "@specweave-studio/contracts";

import {
  isScratchMember,
  partitionProjectGroups,
  type ProjectListGroup,
  type ProjectListMember,
  type ScratchRootLookup,
} from "../../studio/projectListVisibility";
import type { SettingsScopeSearch } from "./settingsScope";

export interface ScopeNoticeMember extends ProjectListMember {
  readonly physicalProjectKey: string;
  readonly environmentLabel?: string | null | undefined;
}

export interface ScopeNoticeGroup<M extends ScopeNoticeMember> extends ProjectListGroup {
  readonly displayName: string;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceSettings?: { readonly kind?: string | undefined } | null | undefined;
  readonly memberProjects: ReadonlyArray<M>;
}

/** One row of the notice's list; `project` is what its favicon shows. */
export interface ScopeNoticeEntry<P> {
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
  readonly project: P;
  readonly search: SettingsScopeSearch;
}

export interface ScopeNoticeEntries<P> {
  readonly listed: ScopeNoticeEntry<P>[];
  /** Shown folded, apart from the main list. */
  readonly archived: ScopeNoticeEntry<P>[];
}

function partition<G extends ProjectListGroup>(
  groups: ReadonlyArray<G>,
  scratchRootFor: ScratchRootLookup,
  selectedProjectKey: string | undefined,
) {
  const { listed, automated, archived } = partitionProjectGroups(
    groups,
    scratchRootFor,
    selectedProjectKey ?? null,
  );
  // Automated projects follow the person's own, as in the other settings lists.
  return { listed: [...listed, ...automated], archived };
}

/**
 * The projects a scope notice offers. A machine's "No project" folder is not a project,
 * so it is never a row. Archived projects are kept apart, unless one is the selected
 * project, which stays in the main list.
 */
export function settingsScopeNoticeProjects<G extends ScopeNoticeGroup<ScopeNoticeMember>>(
  groups: ReadonlyArray<G>,
  scratchRootFor: ScratchRootLookup,
  selectedProjectKey: string | undefined,
): ScopeNoticeEntries<G> {
  const entry = (group: G): ScopeNoticeEntry<G> => {
    const checkouts = group.memberProjects.filter(
      (member) => !isScratchMember(member, scratchRootFor),
    ).length;
    return {
      key: group.projectKey,
      label: group.displayName,
      detail:
        group.workspaceSettings?.kind === "personal"
          ? PERSONAL_ASSISTANT_LABEL
          : checkouts > 1
            ? `${checkouts} checkouts · ${group.workspaceRoot ?? ""}`
            : (group.workspaceRoot ?? null),
      project: group,
      search: { project: group.projectKey },
    };
  };
  const { listed, archived } = partition(groups, scratchRootFor, selectedProjectKey);
  return { listed: listed.map(entry), archived: archived.map(entry) };
}

/**
 * The checkouts a scope notice offers, of the selected project when there is one. A
 * machine's "No project" folder is never a row, and checkouts of archived projects are
 * kept apart, as in {@link settingsScopeNoticeProjects}.
 */
export function settingsScopeNoticeCheckouts<M extends ScopeNoticeMember>(
  groups: ReadonlyArray<ScopeNoticeGroup<M>>,
  scratchRootFor: ScratchRootLookup,
  selectedProjectKey: string | undefined,
): ScopeNoticeEntries<M> {
  const entries = (list: ReadonlyArray<ScopeNoticeGroup<M>>): ScopeNoticeEntry<M>[] =>
    list
      .filter((group) => !selectedProjectKey || group.projectKey === selectedProjectKey)
      .flatMap((group) =>
        group.memberProjects
          .filter((member) => !isScratchMember(member, scratchRootFor))
          .map((member) => ({
            key: `${group.projectKey}:${member.physicalProjectKey}`,
            label: `${group.displayName} · ${member.environmentLabel ?? "Environment"}`,
            detail: member.workspaceRoot ?? null,
            project: member,
            search: {
              project: group.projectKey,
              machine: member.environmentId,
              checkout: member.physicalProjectKey,
            },
          })),
      );
  const { listed, archived } = partition(groups, scratchRootFor, selectedProjectKey);
  return { listed: entries(listed), archived: entries(archived) };
}

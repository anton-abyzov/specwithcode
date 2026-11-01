import { useMemo, useState, type ReactNode } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { usePrimaryEnvironmentId } from "../../../state/environments";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import {
  dismissLinkSuggestion,
  duplicateLinkSuggestions,
  isLinkSuggestionDismissed,
  linkDialogTarget,
  type DuplicateLinkSuggestion,
} from "../../../studio/duplicateProjectLink";
import { useMachineNicknames } from "../../../studio/machineNickname";
import {
  isOrdinaryProjectChoice,
  type ScratchRootLookup,
} from "../../../studio/projectListVisibility";
import { ProjectLinkDialog } from "../ProjectLinkDialog";
import type { ProjectLinkSuggestion } from "./SidebarProjectList";

/**
 * The sidebar's link offers: a row that is the same repository as another row on
 * another machine asks "Link them?", and the link dialog opens from it. The dialog
 * compares both folders and asks which coordinator stays before anything links.
 */
export function useProjectLinkSuggestions(
  groups: ReadonlyArray<SidebarProjectSnapshot>,
  scratchRootFor: ScratchRootLookup,
): {
  readonly suggestionFor: (group: SidebarProjectSnapshot) => ProjectLinkSuggestion | undefined;
  readonly dialog: ReactNode;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId() as EnvironmentId | null;
  const nickname = useMachineNicknames();
  // Bumped by "Not the same project", so the list reads the dismissal again.
  const [dismissals, setDismissals] = useState(0);
  const [open, setOpen] = useState<DuplicateLinkSuggestion | null>(null);
  const suggestions = useMemo(
    () =>
      duplicateLinkSuggestions(groups, {
        primaryEnvironmentId,
        eligible: (project) => isOrdinaryProjectChoice(project, scratchRootFor, "code"),
        // Read from storage again after each "Not the same project".
        dismissed: (candidate) => dismissals >= 0 && isLinkSuggestionDismissed(candidate),
      }),
    [groups, primaryEnvironmentId, scratchRootFor, dismissals],
  );
  const suggestionFor = (group: SidebarProjectSnapshot): ProjectLinkSuggestion | undefined => {
    const suggestion = suggestions.get(group.projectKey);
    if (!suggestion) return undefined;
    const machine = nickname(suggestion.anchor.environmentId);
    const repository = suggestion.repository ? ` (${suggestion.repository})` : "";
    return {
      label: `Same repository${repository} as ${suggestion.anchorTitle} on ${machine}`,
      action: `Link with ${suggestion.anchorTitle} on ${machine}…`,
      onLink: () => setOpen(suggestion),
      onDismiss: () => {
        dismissLinkSuggestion(suggestion.candidate);
        setDismissals((value) => value + 1);
      },
    };
  };
  const target = open ? linkDialogTarget(open) : null;
  const dialog = target ? (
    <ProjectLinkDialog
      open
      onOpenChange={(next) => !next && setOpen(null)}
      project={target.project}
      initialCandidate={target.candidate}
      onLinked={() => setOpen(null)}
    />
  ) : null;
  return { suggestionFor, dialog };
}

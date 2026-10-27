import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@specweave-studio/contracts";
import { isSidebarUtilityPage } from "../sidebar/mainAppLocation";
import type { DraftId } from "../../composerDraftStore";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { chooseCoordinatorView } from "../../studio/projectCoordinatorMachine";
import type { ProjectWorkspaceSearch } from "../../studio/projectPaneThreads";

export type SnapShotTarget =
  | DraftId
  | ScopedThreadRef
  | {
      readonly kind: "coordinator";
      readonly projectRef: ScopedProjectRef;
    };

export function isCoordinatorSnapShotTarget(
  target: SnapShotTarget,
): target is Extract<SnapShotTarget, { kind: "coordinator" }> {
  return typeof target !== "string" && "kind" in target;
}

/** Resolve the same checkout as the project workspace, including its saved machine choice. */
export function resolveProjectSnapShotTarget(input: {
  group: SidebarProjectSnapshot | undefined;
  search: ProjectWorkspaceSearch;
  lastViewed?: string | undefined;
  primaryEnvironmentId: string | null;
  unreachable?: ReadonlySet<string> | undefined;
}): SnapShotTarget | null {
  if (!input.group) return null;
  const { member, problem } = chooseCoordinatorView({
    members: input.group.memberProjects,
    checkoutKey: input.search.checkout,
    lastViewed: input.lastViewed,
    primaryEnvironmentId: input.primaryEnvironmentId,
    ...(input.unreachable ? { unreachable: input.unreachable } : {}),
  });
  if (input.search.thread) {
    const environmentId = input.search.threadEnvironment ?? member?.environmentId;
    if (
      !environmentId ||
      !input.group.memberProjects.some((p) => p.environmentId === environmentId)
    )
      return null;
    return scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(input.search.thread));
  }
  if (!member || problem) return null;
  return {
    kind: "coordinator",
    projectRef: { environmentId: member.environmentId, projectId: member.id },
  };
}

export function sameSnapShotTarget(left: SnapShotTarget | null, right: SnapShotTarget): boolean {
  if (left === null || typeof left === "string" || typeof right === "string") return left === right;
  if (isCoordinatorSnapShotTarget(left) || isCoordinatorSnapShotTarget(right)) {
    return (
      isCoordinatorSnapShotTarget(left) &&
      isCoordinatorSnapShotTarget(right) &&
      left.projectRef.environmentId === right.projectRef.environmentId &&
      left.projectRef.projectId === right.projectRef.projectId
    );
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

/** A completed capture may leave Settings, but never replace a newer navigation. */
export function snapShotReturnHref(
  requestedHref: string,
  currentHref: string,
  returnHref: string | null,
): string | null {
  return requestedHref === currentHref &&
    isSidebarUtilityPage(requestedHref.split(/[?#]/, 1)[0] ?? "")
    ? returnHref
    : null;
}

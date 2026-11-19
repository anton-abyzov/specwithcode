import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import { isAppScratchFolder } from "@specweave-studio/shared/projectOrigin";

/**
 * Whether a project page names a machine's "No project" folder. That folder only
 * holds chats, each in a folder of its own; it has no page and no Project settings,
 * so a saved link or history entry naming it leaves for Overview. Nothing is deleted.
 */
export function isChatsProjectRoute(input: {
  readonly group:
    | {
        readonly memberProjects: ReadonlyArray<{
          readonly environmentId: string;
          readonly workspaceRoot: string;
        }>;
      }
    | undefined;
  /** The machine's "No project" folder; null when it offers none, undefined before its config arrives. */
  readonly scratchRootFor: (environmentId: string) => string | null | undefined;
}): boolean {
  const members = input.group?.memberProjects ?? [];
  return (
    members.length > 0 &&
    members.every((member) => {
      const root = input.scratchRootFor(member.environmentId);
      // Before the machine's config arrives (or while it is offline) the app's own
      // folder layout still tells a "No project" folder apart, so the page never opens.
      return root === undefined
        ? isAppScratchFolder(member.workspaceRoot)
        : isScratchProject(member, root);
    })
  );
}

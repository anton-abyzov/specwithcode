import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";

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
  readonly scratchRootFor: (environmentId: string) => string | null | undefined;
}): boolean {
  const members = input.group?.memberProjects ?? [];
  return (
    members.length > 0 &&
    members.every((member) => isScratchProject(member, input.scratchRootFor(member.environmentId)))
  );
}

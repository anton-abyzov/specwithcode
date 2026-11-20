import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import { isAppScratchFolder } from "@specweave-studio/shared/projectOrigin";

/**
 * What a project page names: a real project, a machine's "No project" folder, or a
 * folder that may be one but cannot be told apart until its machine's config arrives.
 * The "No project" folder only holds chats, each in a folder of its own; it has no
 * page and no Project settings, so a saved link or history entry naming it leaves for
 * Overview. Nothing is deleted.
 */
export type ChatsProjectRoute = "project" | "chats" | "pending";

export function chatsProjectRoute(input: {
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
}): ChatsProjectRoute {
  const members = input.group?.memberProjects ?? [];
  if (members.length === 0) return "project";
  let pending = false;
  for (const member of members) {
    const root = input.scratchRootFor(member.environmentId);
    if (root !== undefined) {
      if (!isScratchProject(member, root)) return "project";
      continue;
    }
    // Without the config only the app's folder layout is known, and a real project
    // can sit at a path shaped like it (`<data>/projects/scratch`). Such a page waits
    // for the config rather than open or leave on a guess.
    if (!isAppScratchFolder(member.workspaceRoot)) return "project";
    pending = true;
  }
  return pending ? "pending" : "chats";
}

// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { projectCoordinatorIsFenced, type Project } from "@specweave-studio/contracts";

/**
 * Which projects a personal assistant may hand work to. The evidence is the
 * approval it already has: its own folder and the additional folders the user
 * approved for it, which every agent in it can already read and write. A
 * project whose folder lies inside one of those may receive its requests;
 * nothing here adds a folder, a grant or a credential.
 */
export type RouteRefusal =
  | "self"
  | "not_found"
  | "deleted"
  | "archived"
  | "paused"
  | "transferred"
  | "outside_folders";

type RoutingProject = Pick<Project, "id" | "title" | "workspaceRoot" | "deletedAt"> & {
  readonly workspaceSettings?: Project["workspaceSettings"] | undefined;
};

/** True when `path` is `root` or inside it. Both must already be real, absolute paths. */
export function isWithinFolder(root: string, path: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

/** The assistant's folders that count as access evidence: its own and its approved ones. */
export function assistantFolders(assistant: RoutingProject): ReadonlyArray<string> {
  return [
    assistant.workspaceRoot,
    ...(assistant.workspaceSettings?.environment.additionalFolders ?? []),
  ];
}

/** The approved folder that covers `targetRoot`, comparing real paths; null when none does. */
export function grantingFolder(
  folders: ReadonlyArray<{ readonly folder: string; readonly real: string }>,
  targetReal: string,
): string | null {
  // The narrowest folder is the most specific evidence.
  let best: { readonly folder: string; readonly real: string } | null = null;
  for (const entry of folders)
    if (isWithinFolder(entry.real, targetReal) && (!best || entry.real.length > best.real.length))
      best = entry;
  return best?.folder ?? null;
}

/** Why `target` cannot take a routed request, ignoring folders; null when its state allows it. */
export function routeStateRefusal(
  assistant: RoutingProject,
  target: RoutingProject | undefined,
): RouteRefusal | null {
  if (target === undefined) return "not_found";
  if (target.id === assistant.id) return "self";
  if (target.deletedAt !== null) return "deleted";
  const settings = target.workspaceSettings;
  if (projectCoordinatorIsFenced(settings)) return "transferred";
  if (settings?.archived) return "archived";
  if (settings?.paused) return "paused";
  return null;
}

/** The words alone, lowercased and space-separated, so punctuation and quote styles never matter. */
function comparable(text: string): string {
  return ` ${(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ")} `;
}

/**
 * True when `quote` is words the user actually wrote in one of `texts`: the
 * provenance of the quoted request. This does not classify intent: the assistant
 * must still distinguish a request for action from discussion or a report.
 */
export function userAskedIn(quote: string, texts: ReadonlyArray<string>): boolean {
  const wanted = comparable(quote);
  if (wanted.trim() === "") return false;
  return texts.some((text) => comparable(text).includes(wanted));
}

export const ROUTE_NOT_ASKED_MESSAGE =
  "The personal assistant's chat stays separate from project chats. Route only when the user's own words ask to start, change, stop or steer work in that project, and pass those words, copied exactly, as userAsked. Answer anything else here. When the user asks how a project is doing, read it with studio_thread_list and studio_thread_read and report here, without posting into the project.";

export function routeRefusalMessage(
  refusal: RouteRefusal,
  names: { readonly assistant: string; readonly target: string },
): string {
  switch (refusal) {
    case "self":
      return `${names.target} is this assistant's own project; start the work here with delegate_task.`;
    case "not_found":
    case "deleted":
      return "That project does not exist here. studio_route_targets lists the projects you can route to.";
    case "archived":
      return `${names.target} is archived. Only the user can restore it; tell them and do not start its work elsewhere.`;
    case "paused":
      return `${names.target} is paused. Only the user can resume it; tell them and do not start its work elsewhere.`;
    case "transferred":
      return `${names.target}'s coordinator moved to another machine; route the work there.`;
    case "outside_folders":
      return `${names.target}'s folder is outside ${names.assistant}'s approved folders, so ${names.assistant} cannot hand it work. The user can add that folder under ${names.assistant}'s project settings > Environment; do not ask for or add it yourself, and do not start its work in another project.`;
  }
}

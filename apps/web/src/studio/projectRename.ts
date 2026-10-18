/**
 * Renaming a project from the sidebar. A name is trimmed, never empty, and unique
 * among projects ignoring case: "SpecWeave" cannot sit next to "specweave". The
 * name is only what the app shows; the folder on disk keeps its name.
 */
import { PROJECT_NAME_MAX_LENGTH, projectNameKey } from "@specweave-studio/contracts";

export interface NamedProject {
  readonly projectKey: string;
  readonly name: string;
  readonly archived: boolean;
}

export type ProjectNameCheck =
  | { readonly kind: "valid"; readonly name: string }
  /** The name is the one the project already has; nothing to save. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly error: string };

export function checkProjectName(input: {
  readonly draft: string;
  readonly current: NamedProject;
  readonly others: ReadonlyArray<NamedProject>;
}): ProjectNameCheck {
  const name = input.draft.trim();
  if (name.length === 0) return { kind: "invalid", error: "Enter a name." };
  if (name.length > PROJECT_NAME_MAX_LENGTH)
    return {
      kind: "invalid",
      error: `Use at most ${PROJECT_NAME_MAX_LENGTH} characters.`,
    };
  if (name === input.current.name) return { kind: "unchanged" };
  const key = projectNameKey(name);
  const taken = input.others.find(
    (other) => other.projectKey !== input.current.projectKey && projectNameKey(other.name) === key,
  );
  if (taken)
    return {
      kind: "invalid",
      error: taken.archived
        ? `An archived project is already named “${taken.name}”.`
        : `Another project is already named “${taken.name}”.`,
    };
  return { kind: "valid", name };
}

interface RenameMember {
  readonly title: string;
  readonly workspaceSettings?:
    | {
        readonly logicalProject?: { readonly title: string } | null | undefined;
        readonly coordinatorBinding?: { readonly state: string } | null | undefined;
      }
    | null
    | undefined;
}

/**
 * The checkouts a rename writes to. A project that moves between machines keeps
 * its name with the machine running its coordinator, and every machine reads it
 * from there; a project grouped from checkouts of one repository is renamed on
 * every machine that has it, so each shows the new name.
 */
export function renameTargets<M extends RenameMember>(
  members: ReadonlyArray<M>,
  name: string,
): { readonly targets: ReadonlyArray<M> } | { readonly error: string } {
  const logical = members.some((member) => member.workspaceSettings?.logicalProject);
  if (logical) {
    const owners = members.filter(
      (member) => member.workspaceSettings?.coordinatorBinding?.state === "active",
    );
    if (owners.length === 0)
      return {
        error: "The machine running this project's coordinator is not connected. Try again later.",
      };
    return {
      targets: owners.filter((member) => member.workspaceSettings?.logicalProject?.title !== name),
    };
  }
  return { targets: members.filter((member) => member.title !== name) };
}

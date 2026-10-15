import { DEFAULT_PERSONAL_ASSISTANT_NAME } from "@specweave-studio/contracts";
import { newProjectFolderName } from "@specweave-studio/shared/path";

/** Keep the current execution machine authoritative; never silently move work off it. */
export function defaultProjectMachine<T extends string>(
  current: T | null,
  eligible: readonly T[],
): T | null {
  if (current !== null) return eligible.includes(current) ? current : null;
  return eligible.length === 1 ? eligible[0]! : null;
}
export type NewProjectKind = "code" | "personal";

/**
 * The name typed into New project, kept while the app runs so going back,
 * closing the dialog or opening Add existing project does not lose it.
 */
let draftName = "";
export const newProjectDraft = {
  name: (): string => draftName,
  keep: (name: string): void => {
    draftName = name;
  },
};

/**
 * A note about how a typed name becomes the folder name, or null when the
 * folder simply follows the name. It never blocks creating the project.
 */
export function newProjectNameNotice(typed: string): string | null {
  const name = typed.trim();
  if (name.length === 0) return null;
  const folder = newProjectFolderName(name);
  if (!/[a-z0-9]/i.test(name.normalize("NFKD"))) {
    return `The folder will be named "${folder}". Add Latin letters or numbers to choose the folder name.`;
  }
  const fullSlug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (fullSlug.length > folder.length)
    return `Long names are shortened; the folder will be named "${folder}".`;
  return null;
}

/**
 * The name a new project is created with. An assistant can be created without
 * typing one, because it has a default the owner can rename later.
 */
export function resolveNewProjectName(kind: NewProjectKind, typed: string): string {
  const name = typed.trim();
  return name.length === 0 && kind === "personal" ? DEFAULT_PERSONAL_ASSISTANT_NAME : name;
}

/**
 * The machine a new project starts on, shown preselected and still changeable
 * in the creation step. The machine being worked on wins. Otherwise the choice
 * follows the load-balancing preferences when balancing is on: a "Manual only"
 * machine is never chosen for the person, "Prefer" beats "Normal" beats "Less
 * often", and this computer breaks a tie. Null only when nothing is eligible
 * or every eligible machine is manual-only and there is more than one.
 */
export function suggestProjectMachine<T extends string>(input: {
  readonly current: T | null;
  readonly eligible: readonly T[];
  readonly primary: T | null;
  readonly loadBalancing: {
    readonly enabled: boolean;
    readonly weights: Readonly<Record<string, number>>;
  };
}): T | null {
  const { current, eligible, primary, loadBalancing } = input;
  if (current !== null && eligible.includes(current)) return current;
  const weight = (id: T) => (loadBalancing.enabled ? (loadBalancing.weights[id] ?? 50) : 50);
  const automatic = eligible.filter((id) => weight(id) > 0);
  if (automatic.length === 0) return eligible.length === 1 ? eligible[0]! : null;
  let best = automatic[0]!;
  for (const id of automatic) {
    const lead = weight(id) - weight(best);
    if (lead > 0 || (lead === 0 && id === primary && best !== primary)) best = id;
  }
  return best;
}

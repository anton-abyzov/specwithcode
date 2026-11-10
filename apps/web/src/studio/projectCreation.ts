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
 * The machine a new project starts on, shown preselected and one tap from any
 * other in the creation step. This device wins, even while a thread or project
 * on another machine is open: a new project is not part of that work. With
 * load balancing on, the choice follows its preferences instead: a "Manual
 * only" machine is never chosen for the person, "Prefer" beats "Normal" beats
 * "Less often", and this device breaks a tie. Without this device, the machine
 * being worked on, then the first eligible one. Null only when nothing is
 * eligible or every eligible machine is manual-only and there is more than one.
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
  if (!loadBalancing.enabled) {
    if (primary !== null && eligible.includes(primary)) return primary;
    if (current !== null && eligible.includes(current)) return current;
    return eligible[0] ?? null;
  }
  const weight = (id: T) => loadBalancing.weights[id] ?? 50;
  const automatic = eligible.filter((id) => weight(id) > 0);
  if (automatic.length === 0) return eligible.length === 1 ? eligible[0]! : null;
  let best = automatic[0]!;
  for (const id of automatic) {
    const lead = weight(id) - weight(best);
    if (lead > 0 || (lead === 0 && id === primary && best !== primary)) best = id;
  }
  return best;
}

/**
 * Why the machine in New project is the one selected, shown under the machine
 * choice so a preselected machine is never a surprise.
 */
export function projectMachineReason(input: {
  readonly selected: string;
  readonly selectedLabel: string;
  /** The machine New project opened on, before any pick in the dialog. */
  readonly suggested: string | null;
  readonly thisDevice: string | null;
  readonly loadBalancingEnabled: boolean;
}): string {
  const { selected, selectedLabel, suggested, thisDevice, loadBalancingEnabled } = input;
  if (selected !== suggested) {
    return selected === thisDevice
      ? "You picked this device."
      : `You picked ${selectedLabel}. The next new project starts on this device again.`;
  }
  if (loadBalancingEnabled) {
    return "Chosen by load balancing. Pick another machine to override it for this project.";
  }
  if (selected === thisDevice)
    return "New projects start on this device. Pick another machine to put this one there.";
  return thisDevice === null
    ? `This device is not available: it cannot hold projects. ${selectedLabel} is selected instead.`
    : `This device is not available: it is offline or cannot create projects right now. ${selectedLabel} is selected instead.`;
}

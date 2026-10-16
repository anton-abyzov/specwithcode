/** A machine the dialog can hand this project to, with what the app knows about it now. */
export interface HandoffMachine {
  readonly id: string;
  readonly label: string;
  readonly online: boolean;
  /** Why work cannot move there right now; null when it can. */
  readonly unavailable: string | null;
  /** The user allowed this project's coordinators to start workers there. */
  readonly workersAllowed: boolean;
  /** A saved folder of this project exists there. */
  readonly hasProjectFolder: boolean;
  /** When this browser last saw the machine connected, in epoch milliseconds. */
  readonly lastOnlineAt: number | null;
}

export interface HandoffMachinePreference {
  /** Chosen with "Remember this machine". */
  readonly remembered: string | null;
  /** The machine the last finished handoff of this project went to. */
  readonly lastUsed: string | null;
}

const EMPTY: HandoffMachinePreference = { remembered: null, lastUsed: null };

export const handoffMachinePreferenceKey = (environmentId: string, projectId: string) =>
  `studio:machine-handoff-target:v1:${JSON.stringify([environmentId, projectId])}`;

export const MACHINE_SEEN_STORAGE_KEY = "studio:machine-seen:v1";

const machineId = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;

export function parseHandoffMachinePreference(value: string | null): HandoffMachinePreference {
  if (!value) return EMPTY;
  try {
    const candidate: unknown = JSON.parse(value);
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
      return EMPTY;
    const { remembered, lastUsed } = candidate as Record<string, unknown>;
    return { remembered: machineId(remembered), lastUsed: machineId(lastUsed) };
  } catch {
    return EMPTY;
  }
}

export function readHandoffMachinePreference(key: string): HandoffMachinePreference {
  try {
    return parseHandoffMachinePreference(localStorage.getItem(key));
  } catch {
    return EMPTY;
  }
}

export function writeHandoffMachinePreference(
  key: string,
  update: Partial<HandoffMachinePreference>,
): HandoffMachinePreference {
  const next = { ...readHandoffMachinePreference(key), ...update };
  try {
    if (next.remembered === null && next.lastUsed === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* A lost preference only changes which machine is preselected next time. */
  }
  return next;
}

export function readMachinesSeen(): Readonly<Record<string, number>> {
  try {
    const candidate: unknown = JSON.parse(localStorage.getItem(MACHINE_SEEN_STORAGE_KEY) ?? "{}");
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return {};
    return Object.fromEntries(
      Object.entries(candidate).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** Remembers when each connected machine was last seen, so offline ones can be ordered. */
export function recordMachinesSeen(ids: readonly string[], now = Date.now()) {
  if (ids.length === 0) return;
  try {
    const seen = { ...readMachinesSeen() };
    for (const id of ids) seen[id] = now;
    localStorage.setItem(MACHINE_SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    /* Ordering falls back to what is connected now. */
  }
}

/**
 * The machine to preselect: the remembered one, else the last handoff target, else the only
 * other online machine allowed to run workers, else the most recently online one.
 */
export function pickHandoffMachine(
  machines: readonly HandoffMachine[],
  preference: HandoffMachinePreference,
): string | null {
  const ready = machines.filter((machine) => machine.unavailable === null);
  for (const id of [preference.remembered, preference.lastUsed])
    if (id && ready.some((machine) => machine.id === id)) return id;
  const workers = ready.filter((machine) => machine.workersAllowed);
  if (workers.length === 1) return workers[0]!.id;
  const recency = (machine: HandoffMachine) =>
    machine.online ? Number.POSITIVE_INFINITY : (machine.lastOnlineAt ?? Number.NEGATIVE_INFINITY);
  const ranked = [...machines].toSorted(
    (left, right) =>
      Number(left.unavailable !== null) - Number(right.unavailable !== null) ||
      recency(right) - recency(left) ||
      Number(right.hasProjectFolder) - Number(left.hasProjectFolder) ||
      Number(right.workersAllowed) - Number(left.workersAllowed) ||
      left.label.localeCompare(right.label),
  );
  return ranked[0]?.id ?? null;
}

/** What a machine option says after its name. */
export function handoffMachineStatus(machine: HandoffMachine): string {
  const parts = [
    machine.online ? "Online" : "Offline",
    machine.hasProjectFolder ? "Project folder saved" : "No project folder yet",
  ];
  if (machine.online && machine.unavailable) parts.push("Permission required");
  return parts.join(" · ");
}

/**
 * The same checkout path relative to the home folder, so a machine with a matching layout can
 * be checked for it. Windows paths are not mirrored.
 */
export function mirroredProjectFolder(workspaceRoot: string): string | null {
  const path = workspaceRoot.replace(/[/\\]+$/, "");
  if (!path.startsWith("/")) return null;
  const home = /^\/(?:Users|home)\/[^/]+(\/.+)$/.exec(path);
  return home ? `~${home[1]}` : path;
}

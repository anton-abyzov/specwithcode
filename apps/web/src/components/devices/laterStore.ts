/**
 * Later on the approving machine's pop-up, kept across restarts and reloads
 * (1416). Without it every restart of the app brought the pop-up back for a
 * device the owner had put off, while that device kept asking in the
 * background. Keys are the pop-up's own (`laterKey`: the device reference a
 * request carries, or its request id), per machine. Later only hides the
 * pop-up; the device stays listed as waiting under Settings > Machines.
 */

/** Where Later is kept between restarts; localStorage in the app. */
export interface LaterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LATER_STORAGE_KEY = "specwithcode:connect-device-later";
/** A device put off stays put off this long, then the pop-up may show it again. */
export const LATER_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Entries kept per machine; the oldest go first. */
export const LATER_MAX_PER_MACHINE = 100;

interface LaterEntry {
  readonly key: string;
  readonly at: number;
}
type LaterEntries = Readonly<Record<string, ReadonlyArray<LaterEntry>>>;

const isEntry = (value: unknown): value is LaterEntry =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as LaterEntry).key === "string" &&
  typeof (value as LaterEntry).at === "number" &&
  Number.isFinite((value as LaterEntry).at);

/** Reads what storage holds, dropping anything that is not a list of entries. */
function parseEntries(raw: string | null): LaterEntries | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const entries: Record<string, ReadonlyArray<LaterEntry>> = {};
    for (const [machine, list] of Object.entries(value)) {
      if (Array.isArray(list)) entries[machine] = list.filter(isEntry);
    }
    return entries;
  } catch {
    return {};
  }
}

/**
 * Later per machine. Storage keeps it across restarts; an in-memory copy
 * keeps it for this session when storage cannot be read or saved (private
 * mode, quota), which is how Later behaved before.
 */
export function makeLaterStore(storage: () => LaterStorage | null, now: () => number = Date.now) {
  let memory: LaterEntries = {};
  // Once a save fails, storage may hold an older list, so memory is the truth.
  let memoryOnly = false;
  const read = (): LaterEntries => {
    if (memoryOnly) return memory;
    try {
      return parseEntries(storage()?.getItem(LATER_STORAGE_KEY) ?? null) ?? memory;
    } catch {
      return memory;
    }
  };
  const write = (entries: LaterEntries) => {
    memory = entries;
    try {
      const target = storage();
      if (target === null) memoryOnly = true;
      else target.setItem(LATER_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      memoryOnly = true;
    }
  };
  const fresh = (list: ReadonlyArray<LaterEntry>, at: number) =>
    list.filter((entry) => at - entry.at < LATER_KEEP_MS);

  return {
    /** The devices put off on this machine, still within their time. */
    keys(machine: string): ReadonlySet<string> {
      return new Set(fresh(read()[machine] ?? [], now()).map((entry) => entry.key));
    },
    /** Puts these devices off on this machine from now. */
    add(machine: string, keys: ReadonlyArray<string>) {
      if (keys.length === 0) return;
      const at = now();
      const entries = read();
      const adding = new Set(keys);
      const kept = fresh(entries[machine] ?? [], at).filter((entry) => !adding.has(entry.key));
      const next = [...kept, ...[...adding].map((key) => ({ key, at }))].slice(
        -LATER_MAX_PER_MACHINE,
      );
      const others = Object.fromEntries(
        Object.entries(entries).flatMap(([other, list]) => {
          if (other === machine) return [];
          const still = fresh(list, at);
          return still.length === 0 ? [] : [[other, still] as const];
        }),
      );
      write({ ...others, [machine]: next });
    },
  };
}

export type LaterStore = ReturnType<typeof makeLaterStore>;

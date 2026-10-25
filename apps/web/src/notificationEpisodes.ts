import { randomUUID } from "./lib/utils";
const KEY = "specwithcode.notifications.episodes.v1";
const memory = new Map<
  string,
  { active: boolean; id: string | null; revision: number; at: number }
>();

/** A shared transition identity, never the shell revision itself. Serialized across clients. */
export async function observeNotificationEpisode(
  scope: string,
  active: boolean,
  revision: string,
  witnessedStart: boolean,
): Promise<string | null> {
  const run = () => {
    try {
      const entries: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
      if (Array.isArray(entries))
        for (const entry of entries) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            entry[1] &&
            typeof entry[1].active === "boolean" &&
            (typeof entry[1].id === "string" || entry[1].id === null) &&
            typeof entry[1].revision === "number" &&
            typeof entry[1].at === "number"
          )
            memory.set(entry[0], entry[1]);
        }
    } catch {
      /* session-only when storage is unavailable */
    }
    const previous = memory.get(scope);
    const timestamp = Date.parse(revision);
    if (!Number.isFinite(timestamp) || (previous && timestamp < previous.revision)) return null;
    const id = active
      ? previous?.active && previous.id
        ? previous.id
        : witnessedStart
          ? randomUUID()
          : null
      : null;
    if (
      previous &&
      previous.active === active &&
      previous.id === id &&
      previous.revision === timestamp
    )
      return id;
    memory.set(scope, { active, id, revision: timestamp, at: Date.now() });
    const entries = [...memory]
      .filter(([, value]) => Date.now() - value.at < 7 * 86400_000)
      .slice(-2000);
    memory.clear();
    for (const [key, value] of entries) memory.set(key, value);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      /* session only */
    }
    return id;
  };
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request("specwithcode:notification-episodes", run)
    : run();
}

export function __resetNotificationEpisodesForTests() {
  memory.clear();
}

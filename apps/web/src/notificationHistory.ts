const KEY = "specwithcode.notifications.events.v1";
const TTL = 7 * 24 * 60 * 60 * 1_000;
const LIMIT = 2_000;
const memory = new Map<string, number>();

function read(now: number): Map<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number") {
          memory.set(entry[0], entry[1]);
        }
      }
    }
  } catch {
    /* Storage can be unavailable. The current window still deduplicates. */
  }
  for (const [key, at] of memory) if (now - at > TTL) memory.delete(key);
  return memory;
}

/** Serializes same-origin tabs; Electron additionally elects one notification owner. */
export async function deliverNotificationOnce(
  key: string,
  deliver: () => Promise<boolean>,
): Promise<void> {
  const run = async () => {
    const history = read(Date.now());
    if (history.has(key)) return;
    // Reserve before awaiting native delivery, also for multiple calls in this renderer.
    history.set(key, Date.now());
    try {
      if (!(await deliver())) {
        history.delete(key);
        return;
      }
      const entries = [...history].sort((a, b) => a[1] - b[1]).slice(-LIMIT);
      memory.clear();
      for (const [id, at] of entries) memory.set(id, at);
      try {
        window.localStorage.setItem(KEY, JSON.stringify(entries));
      } catch {
        /* session only */
      }
    } catch {
      history.delete(key);
    }
  };
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request("specwithcode:notification-delivery", run);
  } else {
    await run();
  }
}

export function __resetNotificationHistoryForTests() {
  memory.clear();
}

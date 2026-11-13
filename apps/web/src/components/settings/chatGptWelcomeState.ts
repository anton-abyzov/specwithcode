/**
 * Local state for the "Your ChatGPT plan is connected" welcome.
 *
 * Both lists live in this app's own localStorage, which is never synced to
 * other machines. The welcome shows only for a sign-in this window started,
 * so a profile that appears on another machine (or arrives through a synced
 * or refreshed provider snapshot) never opens it here.
 */
const ACKNOWLEDGED_KEY = "specweave-studio:chatgpt-sharing-welcome:v1";
const PENDING_KEY = "specweave-studio:chatgpt-sharing-welcome:pending:v1";
/** A sign-in that has not finished within this window no longer counts. */
export const CHATGPT_WELCOME_PENDING_TTL_MS = 60 * 60 * 1000;

export interface PendingChatGptSignIn {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly startedAt: number;
  /**
   * The ChatGPT profile this instance had when the sign-in started (null when
   * it had none). Undefined until the welcome has seen the instance connected;
   * the welcome only opens for a profile that differs from it, so it waits for
   * the sign-in to finish instead of greeting the account already there.
   */
  readonly baselineKey?: string | null;
}

const listeners = new Set<() => void>();

function readJsonArray(key: string): unknown[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* In-memory state still covers this session. */
  }
}

export function readAcknowledgedChatGptProfiles(): string[] {
  return readJsonArray(ACKNOWLEDGED_KEY).filter((key): key is string => typeof key === "string");
}

export function readPendingChatGptSignIns(now = Date.now()): PendingChatGptSignIn[] {
  return readJsonArray(PENDING_KEY).filter(
    (entry): entry is PendingChatGptSignIn =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as PendingChatGptSignIn).environmentId === "string" &&
      typeof (entry as PendingChatGptSignIn).instanceId === "string" &&
      typeof (entry as PendingChatGptSignIn).startedAt === "number" &&
      ((entry as PendingChatGptSignIn).baselineKey === undefined ||
        (entry as PendingChatGptSignIn).baselineKey === null ||
        typeof (entry as PendingChatGptSignIn).baselineKey === "string") &&
      now - (entry as PendingChatGptSignIn).startedAt < CHATGPT_WELCOME_PENDING_TTL_MS,
  );
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Call when this window starts an interactive ChatGPT/Codex sign-in. */
export function noteChatGptSignInStarted(environmentId: string, instanceId: string): void {
  const others = readPendingChatGptSignIns().filter(
    (entry) => entry.environmentId !== environmentId || entry.instanceId !== instanceId,
  );
  write(PENDING_KEY, [...others, { environmentId, instanceId, startedAt: Date.now() }]);
  notify();
}

/** Call when this window cancels the sign-in it started. */
export function clearChatGptSignIn(environmentId: string, instanceId: string): void {
  write(
    PENDING_KEY,
    readPendingChatGptSignIns().filter(
      (entry) => entry.environmentId !== environmentId || entry.instanceId !== instanceId,
    ),
  );
  notify();
}

/**
 * Records the profile each pending sign-in started from. `current` maps an
 * `environmentId\u0000instanceId` pair to its connected ChatGPT profile key, or
 * null when it has none; pairs whose machine is not connected are absent.
 */
export function recordChatGptSignInBaselines(current: ReadonlyMap<string, string | null>): void {
  const pending = readPendingChatGptSignIns();
  let changed = false;
  const updated = pending.map((entry) => {
    const pair = chatGptSignInPair(entry.environmentId, entry.instanceId);
    if (entry.baselineKey !== undefined || !current.has(pair)) return entry;
    changed = true;
    return { ...entry, baselineKey: current.get(pair) ?? null };
  });
  if (!changed) return;
  write(PENDING_KEY, updated);
  notify();
}

export function chatGptSignInPair(environmentId: string, instanceId: string): string {
  return `${environmentId}\u0000${instanceId}`;
}

/** Records the welcome as seen for a profile and ends the sign-in that led to it. */
export function acknowledgeChatGptProfile(
  profileKey: string,
  environmentId: string,
  instanceId: string,
): void {
  const acknowledged = readAcknowledgedChatGptProfiles();
  if (!acknowledged.includes(profileKey)) write(ACKNOWLEDGED_KEY, [...acknowledged, profileKey]);
  clearChatGptSignIn(environmentId, instanceId);
}

export function subscribeChatGptWelcome(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PENDING_KEY || event.key === ACKNOWLEDGED_KEY) {
      listener();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

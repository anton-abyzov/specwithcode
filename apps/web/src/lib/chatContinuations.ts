/**
 * Links between a chat whose machine could not be reached and the chat that
 * continued it on another machine. The two threads live on different
 * machines and neither server knows about the other, so the link is kept on
 * this device, in local storage: the old chat offers "Open on M4" and the new
 * one names where it came from. A per-device note, never shared state.
 *
 * @module chatContinuations
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "specwithcode:chat-continuations";
/** Enough for months of use; the oldest links go first. */
const MAX_LINKS = 200;

export interface ChatRef {
  readonly environmentId: string;
  readonly threadId: string;
  /** The machine's name when the link was made. */
  readonly label: string;
}

export interface ChatContinuation {
  /** The chat this one was continued in. */
  readonly continuedIn?: ChatRef;
  /** The chat this one continues, with its title. */
  readonly continues?: ChatRef & { readonly title: string };
  /** The "Continued from" notice was closed. */
  readonly dismissed?: boolean;
  readonly at: number;
}

const keyOf = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;

const isRef = (value: unknown): value is ChatRef =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ChatRef).environmentId === "string" &&
  typeof (value as ChatRef).threadId === "string" &&
  typeof (value as ChatRef).label === "string";

function load(): Map<string, ChatContinuation> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const links = new Map<string, ChatContinuation>();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.at !== "number") continue;
      const continues =
        isRef(entry.continues) && typeof (entry.continues as { title?: unknown }).title === "string"
          ? (entry.continues as ChatContinuation["continues"])
          : undefined;
      links.set(key, {
        at: entry.at,
        ...(isRef(entry.continuedIn) ? { continuedIn: entry.continuedIn } : {}),
        ...(continues ? { continues } : {}),
        ...(entry.dismissed === true ? { dismissed: true } : {}),
      });
    }
    return links;
  } catch {
    return new Map();
  }
}

let links: Map<string, ChatContinuation> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function store(): Map<string, ChatContinuation> {
  links ??= load();
  return links;
}

function commit(next: Map<string, ChatContinuation>) {
  while (next.size > MAX_LINKS) {
    const oldest = [...next.entries()].reduce((a, b) => (a[1].at <= b[1].at ? a : b));
    next.delete(oldest[0]);
  }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
  } catch {
    // Storage can be full or blocked; the link still holds for this session.
  }
  version += 1;
  for (const listener of listeners) listener();
}

/** Links both chats: the old one points to the new one and back. */
export function recordChatContinuation(
  from: ChatRef & { readonly title: string },
  to: ChatRef,
  now = Date.now(),
) {
  const current = store();
  const fromKey = keyOf(from.environmentId, from.threadId);
  const toKey = keyOf(to.environmentId, to.threadId);
  current.set(fromKey, { ...current.get(fromKey), continuedIn: to, at: now });
  current.set(toKey, { ...current.get(toKey), continues: from, at: now });
  commit(current);
}

export function chatContinuation(environmentId: string, threadId: string): ChatContinuation | null {
  return store().get(keyOf(environmentId, threadId)) ?? null;
}

/** Closes the "Continued from" notice on the new chat. */
export function dismissContinuedFrom(environmentId: string, threadId: string) {
  const current = store();
  const key = keyOf(environmentId, threadId);
  const entry = current.get(key);
  if (!entry || entry.dismissed) return;
  current.set(key, { ...entry, dismissed: true });
  commit(current);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when a link changes; read links with chatContinuation. */
export function useChatContinuationsVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/** Test seam: forget every link and reload from storage on next read. */
export function resetChatContinuationsForTests() {
  links = null;
  version = 0;
}

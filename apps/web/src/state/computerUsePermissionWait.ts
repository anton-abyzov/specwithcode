import type { ComputerUsePermission } from "@specweave-studio/contracts";
import { useSyncExternalStore } from "react";

/**
 * Threads whose computer-use action is on hold in this desktop app until the
 * user allows a macOS permission. The thread shows a permission card above
 * its composer while its entry exists; the action resumes by itself once the
 * permission is granted, which removes the entry.
 */
interface PermissionWait {
  readonly token: symbol;
  readonly permission: ComputerUsePermission;
}

const waits = new Map<string, PermissionWait>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Marks a thread as waiting; returns the token that ends this wait. */
export function beginComputerUsePermissionWait(
  threadId: string,
  permission: ComputerUsePermission,
): symbol {
  const token = Symbol(threadId);
  waits.set(threadId, { token, permission });
  notify();
  return token;
}

/** Ends a wait unless a newer action in the same thread replaced it. */
export function endComputerUsePermissionWait(threadId: string, token: symbol): void {
  if (waits.get(threadId)?.token !== token) return;
  waits.delete(threadId);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The permission this thread's computer-use action is waiting for, if any. */
export function useComputerUsePermissionWait(
  threadId: string | null | undefined,
): ComputerUsePermission | null {
  return useSyncExternalStore(subscribe, () =>
    threadId ? (waits.get(threadId)?.permission ?? null) : null,
  );
}

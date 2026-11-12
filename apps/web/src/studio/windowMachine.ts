import { useEffect, useSyncExternalStore } from "react";

/**
 * The machine doing the work in the view on screen. A coordinator or thread
 * claims its execution machine while it is shown, and the window's top edge
 * wears that machine's color, so a coordinator moved to linux-mini reads blue
 * in a window that belongs to the M4. With no claim, the edge falls back to
 * the window's own machine.
 *
 * A thread outranks the project around it: React runs a child's effects before
 * its parent's, so mount order can't decide.
 */
export type WindowMachineClaimRank = "project" | "thread";
const RANK: Record<WindowMachineClaimRank, number> = { project: 1, thread: 2 };

export interface WindowMachineClaims {
  claim(environmentId: string, rank?: WindowMachineClaimRank): () => void;
  current(): string | null;
  subscribe(listener: () => void): () => void;
}

export function createWindowMachineClaims(): WindowMachineClaims {
  // Newest last; the highest rank wins, then the most recent claim.
  let claims: ReadonlyArray<{
    readonly token: symbol;
    readonly environmentId: string;
    readonly rank: number;
  }> = [];
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    claim(environmentId, rank = "thread") {
      const token = Symbol(environmentId);
      claims = [...claims, { token, environmentId, rank: RANK[rank] }];
      notify();
      return () => {
        claims = claims.filter((entry) => entry.token !== token);
        notify();
      };
    },
    current() {
      let best: (typeof claims)[number] | undefined;
      for (const entry of claims) if (!best || entry.rank >= best.rank) best = entry;
      return best?.environmentId ?? null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const windowMachineClaims = createWindowMachineClaims();

/** Marks `environmentId` as the machine this view works on, while it is mounted. */
export function useClaimWindowMachine(
  environmentId: string | null | undefined,
  rank: WindowMachineClaimRank = "thread",
): void {
  useEffect(
    () => (environmentId ? windowMachineClaims.claim(environmentId, rank) : undefined),
    [environmentId, rank],
  );
}

/** The claimed machine of the view in front, or null when no view claims one. */
export function useClaimedWindowMachine(): string | null {
  return useSyncExternalStore(
    windowMachineClaims.subscribe,
    windowMachineClaims.current,
    () => null,
  );
}

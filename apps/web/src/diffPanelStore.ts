import { scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { RunId, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/** Where an Open diff link came from, beyond the run and file it names. */
export interface TurnDiffLinkOptions {
  /** The thread whose turn this is; inherited and subagent rows name another thread. */
  readonly sourceThreadId?: ThreadId | undefined;
  /** Subagent attribution for the notice "Edited by subagent <title> in turn N". */
  readonly attributedTo?: { readonly title: string; readonly running?: boolean } | undefined;
}

export type TurnDiffAttribution = NonNullable<TurnDiffLinkOptions["attributedTo"]>;

/** "link" when an Open diff link chose the turn; "menu" when the panel's own turn menu did. */
export type TurnDiffSelectionOrigin = "link" | "menu";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | {
      kind: "turn";
      turnId: RunId;
      /** The path the link named, as the provider reported it (often absolute). */
      filePath: string | null;
      revealRequestId: number;
      /** A link's turn is never replaced by another turn, even when it has no diff. */
      origin: TurnDiffSelectionOrigin;
      attributedTo?: TurnDiffAttribution;
    };

// "branch" is the Changes view: everything this checkout changed since its base.
const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  /** `link` is passed by Open diff links, which makes the selection a link's. */
  selectTurn: (
    ref: ScopedThreadRef,
    turnId: RunId,
    filePath?: string,
    link?: TurnDiffLinkOptions,
  ) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<RunId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
  /** Thread key of a link that opens its diff after navigating to that thread; not persisted. */
  pendingLinkedOpenThreadKey: string | null;
  /** Marks the next diff opening on `ref` as the link's, so the thread switch keeps its turn. */
  markLinkedOpen: (ref: ScopedThreadRef) => void;
  /** True once when the diff opening on `ref` comes from a link marked before navigation. */
  takeLinkedOpen: (ref: ScopedThreadRef) => boolean;
}

type PersistedDiffPanelState = Pick<
  DiffPanelStoreState,
  "byThreadKey" | "branchBaseRefByThreadKey"
>;

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

/** Turn selections stored before links were told apart keep the panel's fallback behavior. */
function withSelectionOrigins(
  byThreadKey: Record<string, DiffPanelSelection>,
): Record<string, DiffPanelSelection> {
  let changed = false;
  const next: Record<string, DiffPanelSelection> = {};
  for (const [threadKey, selection] of Object.entries(byThreadKey)) {
    if (selection?.kind === "turn" && selection.origin !== "link" && selection.origin !== "menu") {
      changed = true;
      next[threadKey] = { ...selection, origin: "menu" };
    } else {
      next[threadKey] = selection;
    }
  }
  return changed ? next : byThreadKey;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath, link) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
                origin: link ? "link" : "menu",
                ...(link?.attributedTo ? { attributedTo: link.attributedTo } : {}),
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            previous.origin === "link" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
      pendingLinkedOpenThreadKey: null,
      markLinkedOpen: (ref) => set({ pendingLinkedOpenThreadKey: scopedThreadKey(ref) }),
      takeLinkedOpen: (ref) => {
        if (get().pendingLinkedOpenThreadKey !== scopedThreadKey(ref)) return false;
        set({ pendingLinkedOpenThreadKey: null });
        return true;
      },
    }),
    {
      name: "studio:diff-panel-state:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state): PersistedDiffPanelState => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<PersistedDiffPanelState>;
        return {
          ...current,
          ...stored,
          byThreadKey: withSelectionOrigins(stored.byThreadKey ?? current.byThreadKey),
        };
      },
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

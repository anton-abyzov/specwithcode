import {
  LINKED_MEMORY_HISTORY_LIMIT,
  type ProjectLinkSupersededNote,
} from "@specweave-studio/contracts";

import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import type { MemoryHistoryState } from "./linkedMemoryMerge.ts";

/**
 * Link review choices and the memory merge that follows.
 *
 * Linking leaves the joining copy's notes as they were, so a note both copies
 * hold with different text reaches the first two-way merge as two unrelated
 * edits, which the merge marks as a conflict. When the person chose the kept
 * copy's text (alone, or with the joining text saved under another name), the
 * kept copy records the joining version as an earlier version of its own note.
 * The merge then reads the kept text as the newer one and the joining copy
 * takes it.
 */

/**
 * The kept copy holds this note with text other than the joining version, and
 * it is still the text the person reviewed (when the review named it).
 */
export const isSuperseded = (keptContent: string, note: ProjectLinkSupersededNote) => {
  const kept = memoryContentHash(keptContent);
  return kept !== note.contentSha256 && (note.keptSha256 === undefined || note.keptSha256 === kept);
};

/** A set-aside joining version with the hash of the kept note's current text. */
export interface SupersededByKept extends ProjectLinkSupersededNote {
  readonly keptSha256: string;
}

/**
 * `state` with each joining version placed just before the kept note's current
 * version. The history keeps only its newest entries, so the joining version goes
 * next to the newest: at the front, a note edited often enough to fill its history
 * would drop it at once.
 */
export const withSuperseded = (
  state: MemoryHistoryState,
  superseded: ReadonlyArray<SupersededByKept>,
): MemoryHistoryState => ({
  ...state,
  files: {
    ...state.files,
    ...Object.fromEntries(
      superseded.map((note) => [
        note.name,
        {
          ...state.files[note.name],
          history: [
            ...(state.files[note.name]?.history ?? []).filter(
              (hash) => hash !== note.contentSha256 && hash !== note.keptSha256,
            ),
            note.contentSha256,
            note.keptSha256,
          ].slice(-LINKED_MEMORY_HISTORY_LIMIT),
        },
      ]),
    ),
  },
});

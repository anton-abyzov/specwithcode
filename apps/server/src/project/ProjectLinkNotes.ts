import type { ProjectLinkSupersededNote } from "@specweave-studio/contracts";

import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import { unionHistory, type MemoryHistoryState } from "./linkedMemoryMerge.ts";

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

/** The kept copy holds this note with text other than the joining version. */
export const isSuperseded = (keptContent: string, note: ProjectLinkSupersededNote) =>
  memoryContentHash(keptContent) !== note.contentSha256;

/** `state` with each joining version placed before the kept note's own versions. */
export const withSuperseded = (
  state: MemoryHistoryState,
  superseded: ReadonlyArray<ProjectLinkSupersededNote>,
): MemoryHistoryState => ({
  ...state,
  files: {
    ...state.files,
    ...Object.fromEntries(
      superseded.map((note) => [
        note.name,
        {
          ...state.files[note.name],
          history: unionHistory(state.files[note.name]?.history ?? [], [note.contentSha256]),
        },
      ]),
    ),
  },
});

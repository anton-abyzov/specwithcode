import { LINKED_MEMORY_HISTORY_LIMIT, type LinkedMemoryExport } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import { memoryContentHash } from "./LinkedMemoryHistory.ts";
import {
  emptyMemoryHistory,
  localFileView,
  machineSlug,
  planMemoryMerge,
  type LocalMemory,
  type LocalMemoryFile,
  type MemoryHistoryState,
} from "./linkedMemoryMerge.ts";
import type * as ProjectLink from "./ProjectLink.ts";
import { legacyPair, link, operationId } from "./ProjectLink.testkit.ts";

const UPDATED_AT = "2026-10-19T00:00:00.000Z";
type Notes = ReadonlyMap<string, { content: string; revision: number }>;

/** One copy's notes as `LinkedMemorySync` reads them for a merge. */
const filesOf = (notes: Notes, state: MemoryHistoryState) =>
  new Map<string, LocalMemoryFile>(
    [...notes].map(([name, note]) => {
      const sha = memoryContentHash(note.content);
      return [
        name,
        {
          ...note,
          sha,
          ...localFileView(state.files[name], { sha, updatedAt: UPDATED_AT }),
        },
      ];
    }),
  );
const local = (environmentId: string, notes: Notes, state: MemoryHistoryState): LocalMemory => ({
  environmentId,
  machineSlug: machineSlug(undefined, environmentId),
  files: filesOf(notes, state),
  tombstones: state.tombstones,
});
const exported = (
  environmentId: string,
  notes: Notes,
  state: MemoryHistoryState,
): LinkedMemoryExport => ({
  logicalProjectId: "logical:1",
  environmentId: environmentId as LinkedMemoryExport["environmentId"],
  files: [...filesOf(notes, state)].map(([name, file]) => ({
    name,
    content: file.content,
    contentSha256: file.sha,
    updatedAt: file.updatedAt,
    history: [...file.history],
  })),
  tombstones: [],
  truncated: false,
});

/** Links the pair, sending `commit` what the review chose. */
const linked = async (
  commit: Pick<Parameters<ProjectLink.ProjectLink["Service"]["commit"]>[0], "notes" | "superseded">,
  keptHistory?: Pick<MemoryHistoryState, "files">,
) => {
  const pair = legacyPair();
  if (keptHistory)
    pair.m4.memoryHistory.set(pair.kept.projectId, { ...emptyMemoryHistory, ...keptHistory });
  const kept = pair.m4.notes(pair.kept.projectId);
  const joining = pair.m3.notes(pair.joining.projectId);
  kept.set("decisions.md", { content: "M4 decision", revision: 2 });
  joining.set("decisions.md", { content: "M3 decision", revision: 1 });
  const { prepared } = await link(pair);
  const result = await pair.m4.run((service) =>
    service.commit({
      operationId,
      projectId: prepared.kept.projectId,
      joining: pair.joining,
      ...commit,
    }),
  );
  const keptState = pair.m4.memoryHistory.get(pair.kept.projectId) ?? emptyMemoryHistory;
  const joiningState = pair.m3.memoryHistory.get(pair.joining.projectId) ?? emptyMemoryHistory;
  return {
    pair,
    result,
    keptState,
    /** What the first merge does on each copy with the other's notes. */
    onKept: planMemoryMerge(
      local(pair.m4.environmentId, kept, keptState),
      exported(pair.m3.environmentId, joining, joiningState),
    ),
    onJoining: planMemoryMerge(
      local(pair.m3.environmentId, joining, joiningState),
      exported(pair.m4.environmentId, kept, keptState),
    ),
  };
};

const M3_HASH = memoryContentHash("M3 decision");
const M4_HASH = memoryContentHash("M4 decision");

describe("ProjectLink note choices and the first memory merge", () => {
  it("previews each note's hash and the routines the copy owns", async () => {
    const pair = legacyPair();
    pair.m3
      .notes(pair.joining.projectId)
      .set("decisions.md", { content: "M3 decision", revision: 1 });
    pair.m3.ownedRoutines.set(pair.joining.projectId, [{ id: "routine-1", title: "Nightly" }]);
    const preview = await pair.m3.run((service) =>
      service.preview({ projectId: pair.joining.projectId }),
    );
    expect(preview.notes).toMatchObject([{ name: "decisions.md", contentSha256: M3_HASH }]);
    expect(preview.routines).toEqual([{ id: "routine-1", title: "Nightly" }]);
    const empty = await pair.m4.run((service) =>
      service.preview({ projectId: pair.kept.projectId }),
    );
    expect(empty.routines).toEqual([]);
  });

  it("without the choice, the first merge marks the note as edited on both copies", async () => {
    const { onJoining, keptState } = await linked({ notes: [] });
    expect(keptState.files["decisions.md"]).toBeUndefined();
    const step = onJoining.steps.find((entry) => entry.name === "decisions.md");
    expect(step).toMatchObject({ kind: "write" });
    expect(step?.kind === "write" && step.conflictCopy).toBeTruthy();
  });

  it("keeping the kept copy's note makes the joining copy take it, with no conflict copy", async () => {
    const { result, keptState, onKept, onJoining } = await linked({
      notes: [],
      superseded: [{ name: "decisions.md", contentSha256: M3_HASH }],
    });
    expect(result.notesWritten).toBe(0);
    expect(keptState.files["decisions.md"]?.history).toEqual([M3_HASH, M4_HASH]);
    // The kept copy keeps its text; at most it remembers versions.
    expect(onKept.steps.filter((step) => step.kind !== "history")).toEqual([]);
    const step = onJoining.steps.find((entry) => entry.name === "decisions.md");
    expect(step).toMatchObject({ kind: "write", content: "M4 decision", sha: M4_HASH });
    expect(step?.kind === "write" ? step.conflictCopy : "none").toBeUndefined();
  });

  it("keeping both saves the joining text under its own name on both copies", async () => {
    const { result, onKept, onJoining } = await linked({
      notes: [
        { name: "decisions-macbook-pro-m3.md", content: "M3 decision", expectedRevision: null },
      ],
      superseded: [{ name: "decisions.md", contentSha256: M3_HASH }],
    });
    expect(result.notesWritten).toBe(1);
    expect(onKept.steps.filter((step) => step.kind !== "history")).toEqual([]);
    const writes = onJoining.steps.filter((step) => step.kind === "write");
    expect(writes.map((step) => [step.name, step.content, step.conflictCopy]).sort()).toEqual([
      ["decisions-macbook-pro-m3.md", "M3 decision", undefined],
      ["decisions.md", "M4 decision", undefined],
    ]);
  });

  it("keeps the choice for a note whose history is already full", async () => {
    const full = Array.from({ length: LINKED_MEMORY_HISTORY_LIMIT - 1 }, (_, index) =>
      memoryContentHash(`older ${index}`),
    );
    const { keptState, onKept, onJoining } = await linked(
      { notes: [], superseded: [{ name: "decisions.md", contentSha256: M3_HASH }] },
      { files: { "decisions.md": { history: [...full, M4_HASH], authoredAt: UPDATED_AT } } },
    );
    const history = keptState.files["decisions.md"]?.history ?? [];
    expect(history).toHaveLength(LINKED_MEMORY_HISTORY_LIMIT);
    expect(history.slice(-2)).toEqual([M3_HASH, M4_HASH]);
    expect(onKept.steps.filter((step) => step.kind !== "history")).toEqual([]);
    const step = onJoining.steps.find((entry) => entry.name === "decisions.md");
    expect(step).toMatchObject({ kind: "write", content: "M4 decision" });
    expect(step?.kind === "write" ? step.conflictCopy : "none").toBeUndefined();
  });

  it("ignores a choice for a note the kept copy lacks or holds with the same text", async () => {
    const { keptState } = await linked({
      notes: [],
      superseded: [
        { name: "absent.md", contentSha256: M3_HASH },
        { name: "decisions.md", contentSha256: M4_HASH },
      ],
    });
    expect(keptState.files).toEqual({});
  });

  it("ignores a choice made against kept text that has changed since the review", async () => {
    const stale = await linked({
      notes: [],
      superseded: [
        {
          name: "decisions.md",
          contentSha256: M3_HASH,
          keptSha256: memoryContentHash("M4 decision before an edit"),
        },
      ],
    });
    expect(stale.keptState.files).toEqual({});
    const step = stale.onJoining.steps.find((entry) => entry.name === "decisions.md");
    expect(step?.kind === "write" && step.conflictCopy).toBeTruthy();
    const current = await linked({
      notes: [],
      superseded: [{ name: "decisions.md", contentSha256: M3_HASH, keptSha256: M4_HASH }],
    });
    expect(current.keptState.files["decisions.md"]?.history).toEqual([M3_HASH, M4_HASH]);
  });
});

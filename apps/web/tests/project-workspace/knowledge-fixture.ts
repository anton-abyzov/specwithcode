/* `?knowledge`: the host reports a built knowledge index that threads still receive
   in full. `?knowledge=search`: the project's memory and hub artifacts have outgrown
   that, so threads search instead. `?knowledge=old`: the host's config arrives without
   the project knowledge capability, as from a host built before it. Status, search and
   rebuild are synthetic here; the real index is covered by
   apps/server/src/project/knowledge/*.test.ts. */
import { Atom } from "effect/reactivity";
import {
  DEFAULT_SERVER_SETTINGS,
  PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
  PROJECT_KNOWLEDGE_MAX_BYTES,
  PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
} from "@specweave-studio/contracts";

export const knowledgeMode = new URLSearchParams(window.location.search).get("knowledge");
export const knowledgeLoadedAt = Date.now();

/** The host config for `?knowledge`; null keeps the fixture's default host, whose config never arrives. */
export const knowledgeServerConfig =
  knowledgeMode === null
    ? null
    : {
        settings: DEFAULT_SERVER_SETTINGS,
        environment: { capabilities: knowledgeMode === "old" ? {} : { projectKnowledge: true } },
        providers: [],
      };

const searching = knowledgeMode === "search";

/** `indexing` is what Rebuild index answers with. */
export const knowledgeStatus = (state: "ready" | "indexing" = "ready") => ({
  projectId: "project",
  mode: searching ? "search" : "inline",
  state,
  documents: searching ? 14_212 : 214,
  characters: searching ? 54_800_000 : 1_480_000,
  inlineCharacters: searching ? 31_400 : 9_600,
  inlineLimit: PROJECT_KNOWLEDGE_INLINE_CHARACTER_LIMIT,
  inlineReturnLimit: PROJECT_KNOWLEDGE_INLINE_RETURN_CHARACTER_LIMIT,
  // Size on disk sets how full the index is: about 2% here, 82% in search mode.
  bytes: searching ? 55_100_000 : 1_520_000,
  capacityBytes: PROJECT_KNOWLEDGE_MAX_BYTES,
  capacityDocuments: PROJECT_KNOWLEDGE_MAX_DOCUMENTS,
  sources: [
    {
      kind: "memory",
      label: "Project memory",
      documents: 2,
      characters: searching ? 22_600 : 6_400,
    },
    {
      kind: "artifact",
      label: "Hub artifacts",
      documents: 3,
      characters: searching ? 8_800 : 3_200,
    },
    {
      kind: "library",
      label: "Increments",
      documents: searching ? 12_940 : 186,
      characters: searching ? 49_100_000 : 1_310_000,
    },
    {
      kind: "library",
      label: "Docs",
      documents: searching ? 1_267 : 23,
      characters: searching ? 5_668_600 : 160_400,
    },
  ],
  skipped: searching
    ? { tooLarge: 4, overCapacity: 0, unreadable: 1 }
    : { tooLarge: 1, overCapacity: 0, unreadable: 0 },
  indexedAt: new Date(knowledgeLoadedAt - 4 * 60_000).toISOString(),
  problem: null,
});

export const knowledgeSearchResult = (query: string) => {
  const results = query.toLowerCase().includes("nothing") ? [] : hits;
  return {
    projectId: "project",
    mode: searching ? "search" : "inline",
    state: "ready",
    truncated: results.length > 0,
    results,
  };
};

const hits = [
  {
    documentId: "file:.specweave/increments/0927-project-knowledge-retrieval/spec.md",
    title: "Project knowledge with automatic search mode",
    location: ".specweave/increments/0927-project-knowledge-retrieval/spec.md",
    kind: "library",
    heading: "Decisions > D-02 Storage",
    excerpt:
      "One SQLite file per project with an FTS5 index, kept under userdata/knowledge, so a damaged index is rebuilt without touching the project's own files.",
    offset: 4_120,
    modifiedAt: "2026-10-18T15:20:00.000Z",
    score: 7.4,
  },
  {
    documentId: "memory:MEMORY.md",
    title: "MEMORY.md",
    location: "MEMORY.md",
    kind: "memory",
    heading: "Decisions",
    excerpt:
      "Storage decision: the coordinator keeps its notes in project memory; threads read them in full while they fit.",
    offset: 0,
    modifiedAt: "2026-10-19T09:02:00.000Z",
    score: 5.1,
  },
  {
    documentId: "file:docs/operations/live-database.md",
    title: "Live database",
    location: "docs/operations/live-database.md",
    kind: "library",
    heading: "",
    excerpt:
      "Knowledge indexes live in userdata/knowledge/. Use Rebuild index in Memory settings instead of deleting the file.",
    offset: 2_310,
    modifiedAt: "2026-10-12T12:00:00.000Z",
    score: 3.2,
  },
];

const rebuildAllowed = Atom.make(true);
/** A command the fixture's `useAtomCommand` recognizes, with the permission atom the card reads. */
export const knowledgeReindex = Object.assign(() => ({ kind: "knowledgeReindex" }), {
  toString: () => "knowledgeReindex",
  permissionAtom: () => rebuildAllowed,
});

// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite holds the per-project knowledge index, as in nodeSqliteClient.
/**
 * One project's knowledge index: a SQLite file beside, never inside,
 * statev2.sqlite. It is derived data; a damaged or missing file is rebuilt.
 * The FTS5 table is contentless, so each document's text is stored once, in
 * `documents.content`, and passages are slices of it by offset. Writes come
 * in small transactions on the event loop, so FTS5's automatic merges are off
 * and the caller runs bounded merge steps after each one instead.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { ProjectKnowledgeSourceKind } from "@specweave-studio/contracts";

import type { KnowledgeChunk } from "./knowledgeChunker.ts";

export const KNOWLEDGE_SCHEMA_VERSION = 1;

/** A document whose chunks are being replaced; a refresh cut short re-indexes it. */
export const PENDING_REVISION = "pending";

export type KnowledgeDocumentFields = {
  readonly id: string;
  readonly kind: ProjectKnowledgeSourceKind;
  readonly label: string;
  readonly location: string;
  readonly title: string;
  readonly revision: string;
  readonly sha256: string;
  readonly characters: number;
  readonly modifiedAt: string;
};

export type KnowledgeDocumentRow = KnowledgeDocumentFields & { readonly chunks: number };

export type KnowledgeDocument = KnowledgeDocumentFields & { readonly content: string };

/** One step of a refresh; a batch of them is one transaction. */
export type KnowledgeWrite =
  | { readonly type: "document"; readonly document: KnowledgeDocument }
  | {
      readonly type: "chunks";
      readonly document: KnowledgeDocument;
      readonly chunks: readonly KnowledgeChunk[];
      /** Ordinal of the first chunk in the document. */
      readonly ordinal: number;
    }
  | {
      readonly type: "revision";
      readonly id: string;
      readonly revision: string;
      readonly modifiedAt: string;
    }
  /** Removes up to `limit` of a document's chunks, its FTS rows with them. */
  | { readonly type: "clearChunks"; readonly id: string; readonly limit: number }
  | { readonly type: "deleteDocument"; readonly id: string };

export type KnowledgeMatch = {
  readonly chunkId: number;
  readonly documentId: string;
  readonly heading: string;
  readonly start: number;
  readonly end: number;
  readonly score: number;
};

class KnowledgeIndexMismatch extends Error {
  constructor() {
    super("The knowledge index belongs to another project or schema.");
  }
}

/**
 * Only a damaged or foreign file is replaced. A full disk, an I/O error or a
 * busy file keeps the index, so a failing volume is not made to rebuild it.
 */
export function isDamagedIndexError(error: unknown): boolean {
  if (error instanceof KnowledgeIndexMismatch) return true;
  const code =
    typeof error === "object" && error !== null && "errcode" in error
      ? Number((error as { readonly errcode: unknown }).errcode) & 0xff
      : -1;
  // SQLITE_CORRUPT and SQLITE_NOTADB.
  return code === 11 || code === 26;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  location TEXT NOT NULL,
  title TEXT NOT NULL,
  revision TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  characters INTEGER NOT NULL,
  modified_at TEXT NOT NULL,
  content TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  heading TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title, heading, body,
  content='', contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2'
);
`;

/** camelCase and PascalCase identifiers also index their words, so `ProjectKnowledge` matches "knowledge". */
function identifierWords(text: string): string {
  const words = new Set<string>();
  for (const match of text.matchAll(/\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g))
    for (const word of match[0].split(/(?=[A-Z])/)) if (word.length > 1) words.add(word);
  return [...words].join(" ");
}

export type KnowledgeIndex = ReturnType<typeof openKnowledgeIndex>;

/** Opens or creates the index at `file`; throws KnowledgeIndexMismatch when it belongs elsewhere. */
export function openKnowledgeIndex(file: string, projectId: string) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const db = new NodeSqlite.DatabaseSync(file, { allowExtension: false });
  try {
    // auto_vacuum takes effect only before the first table exists, so it leads.
    db.exec(
      "PRAGMA auto_vacuum = INCREMENTAL; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = 8388608; PRAGMA synchronous = NORMAL;",
    );
    const version = Number(Object.values(db.prepare("PRAGMA user_version").get() ?? {})[0] ?? 0);
    if (version !== 0 && version !== KNOWLEDGE_SCHEMA_VERSION) throw new KnowledgeIndexMismatch();
    db.exec(SCHEMA);
    const owner = db.prepare("SELECT value FROM meta WHERE key = 'project_id'").get() as
      | { value: string }
      | undefined;
    if (owner && owner.value !== projectId) throw new KnowledgeIndexMismatch();
    if (!owner) {
      // Merges run as explicit bounded steps after each write batch instead.
      db.exec(
        "INSERT INTO chunks_fts(chunks_fts, rank) VALUES('automerge', 0); INSERT INTO chunks_fts(chunks_fts, rank) VALUES('deletemerge', 0);",
      );
      db.prepare("INSERT INTO meta (key, value) VALUES ('project_id', ?)").run(projectId);
      db.exec(`PRAGMA user_version = ${KNOWLEDGE_SCHEMA_VERSION}`);
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const statements = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    documents: db.prepare(
      'SELECT d.id, d.kind, d.label, d.location, d.title, d.revision, d.sha256, d.characters, d.modified_at AS "modifiedAt", (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunks FROM documents d',
    ),
    document: db.prepare(
      'SELECT id, kind, label, location, title, revision, sha256, characters, modified_at AS "modifiedAt", content FROM documents WHERE id = ?',
    ),
    curatedDocuments: db.prepare(
      `SELECT id, kind, label, location, title, revision, sha256, characters, modified_at AS "modifiedAt", content FROM documents WHERE kind <> 'library' ORDER BY kind, location`,
    ),
    artifactTitles: db.prepare(
      "SELECT title FROM documents WHERE kind = 'artifact' ORDER BY title COLLATE NOCASE",
    ),
    chunkIds: db.prepare("SELECT id FROM chunks WHERE document_id = ? ORDER BY id LIMIT ?"),
    deleteFts: db.prepare("DELETE FROM chunks_fts WHERE rowid = ?"),
    deleteChunk: db.prepare("DELETE FROM chunks WHERE id = ?"),
    deleteDocument: db.prepare("DELETE FROM documents WHERE id = ?"),
    upsertDocument: db.prepare(
      "INSERT INTO documents (id, kind, label, location, title, revision, sha256, characters, modified_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label, location = excluded.location, title = excluded.title, revision = excluded.revision, sha256 = excluded.sha256, characters = excluded.characters, modified_at = excluded.modified_at, content = excluded.content",
    ),
    updateRevision: db.prepare("UPDATE documents SET revision = ?, modified_at = ? WHERE id = ?"),
    insertChunk: db.prepare(
      "INSERT INTO chunks (document_id, ordinal, heading, start_offset, end_offset) VALUES (?, ?, ?, ?, ?)",
    ),
    insertFts: db.prepare(
      "INSERT INTO chunks_fts (rowid, title, heading, body) VALUES (?, ?, ?, ?)",
    ),
    // FTS5 ranks first and only the best candidates are joined (-1 takes every match). bm25 is
    // negative, so halving it ranks archived increments below current work. The per-document
    // cap applies before the limit, so one long document cannot crowd out the rest.
    search: db.prepare(
      `SELECT "chunkId", "documentId", heading, start, "end", score FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY "documentId" ORDER BY score, "chunkId") AS place FROM (
          SELECT c.id AS "chunkId", c.document_id AS "documentId", c.heading AS heading, c.start_offset AS start, c.end_offset AS "end",
            m.rank * (CASE WHEN d.location LIKE '%/\\_archive/%' ESCAPE '\\' THEN 0.5 ELSE 1.0 END) AS score
          FROM (SELECT rowid, bm25(chunks_fts, 4.0, 2.0, 1.0) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?) m
          JOIN chunks c ON c.id = m.rowid JOIN documents d ON d.id = c.document_id
          WHERE d.location LIKE ? ESCAPE '\\'
        )
      ) WHERE place <= ? ORDER BY score, "chunkId" LIMIT ?`,
    ),
    merge: db.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('merge', ?)"),
    totalChanges: db.prepare("SELECT total_changes() AS changes"),
    freePages: db.prepare("PRAGMA freelist_count"),
    totals: db.prepare(
      "SELECT kind, label, COUNT(*) AS documents, COALESCE(SUM(characters), 0) AS characters FROM documents GROUP BY kind, label ORDER BY kind, label",
    ),
  };

  const totalChanges = () =>
    Number((statements.totalChanges.get() as { changes: number } | undefined)?.changes ?? 0);

  const upsertDocument = (document: KnowledgeDocument) =>
    statements.upsertDocument.run(
      document.id,
      document.kind,
      document.label,
      document.location,
      document.title,
      document.revision,
      document.sha256,
      document.characters,
      document.modifiedAt,
      document.content,
    );

  return {
    file,
    close: () => {
      if (db.isOpen) db.close();
    },
    meta: (key: string): string | null =>
      (statements.getMeta.get(key) as { value: string } | undefined)?.value ?? null,
    setMeta: (entries: Record<string, string>) => {
      db.exec("BEGIN");
      try {
        for (const [key, value] of Object.entries(entries)) statements.setMeta.run(key, value);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    documents: () => statements.documents.all() as KnowledgeDocumentRow[],
    document: (id: string) => statements.document.get(id) as KnowledgeDocument | undefined,
    /** Memory files and hub artifacts with their text: what may go inline. */
    curatedDocuments: () => statements.curatedDocuments.all() as KnowledgeDocument[],
    artifactTitles: () =>
      (statements.artifactTitles.all() as Array<{ title: string }>).map((row) => row.title),
    totals: () =>
      statements.totals.all() as Array<{
        kind: ProjectKnowledgeSourceKind;
        label: string;
        documents: number;
        characters: number;
      }>,
    /** Applies writes in one transaction; callers keep each batch small. */
    write: (writes: readonly KnowledgeWrite[]) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const write of writes) {
          switch (write.type) {
            case "document":
              upsertDocument(write.document);
              break;
            case "revision":
              statements.updateRevision.run(write.revision, write.modifiedAt, write.id);
              break;
            case "clearChunks":
              // A chunk and its FTS row always leave together, and ids are never reused.
              for (const row of statements.chunkIds.all(write.id, write.limit) as Array<{
                id: number;
              }>) {
                statements.deleteFts.run(row.id);
                statements.deleteChunk.run(row.id);
              }
              break;
            case "deleteDocument":
              statements.deleteDocument.run(write.id);
              break;
            case "chunks": {
              const document = write.document;
              const title = `${document.title}\n${document.location}`;
              write.chunks.forEach((chunk, index) => {
                const inserted = statements.insertChunk.run(
                  document.id,
                  write.ordinal + index,
                  chunk.heading,
                  chunk.start,
                  chunk.end,
                );
                const body = document.content.slice(chunk.start, chunk.end);
                statements.insertFts.run(
                  Number(inserted.lastInsertRowid),
                  title,
                  chunk.heading,
                  `${body}\n${identifierWords(body)}`,
                );
              });
              break;
            }
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** One bounded FTS5 merge step; true while there may be more to merge. */
    merge: (pages: number): boolean => {
      const before = totalChanges();
      statements.merge.run(pages);
      return totalChanges() - before >= 2;
    },
    /** Returns up to `pages` free pages to the file system; true while more remain. */
    vacuum: (pages: number): boolean => {
      db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.trunc(pages))})`);
      return Number(Object.values(statements.freePages.get() ?? {})[0] ?? 0) > 0;
    },
    freePages: () => Number(Object.values(statements.freePages.get() ?? {})[0] ?? 0),
    /** Folds the write-ahead log back into the file and truncates it. */
    checkpoint: () => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    /**
     * The best passages, at most `perDocument` from any one document, best
     * first, chosen among the `candidates` best matches (-1 for all of them).
     */
    search: (
      match: string,
      within: string,
      options: {
        readonly candidates: number;
        readonly perDocument: number;
        readonly limit: number;
      },
    ) =>
      statements.search.all(
        match,
        options.candidates,
        within,
        options.perDocument,
        options.limit,
      ) as KnowledgeMatch[],
  };
}

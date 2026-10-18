/**
 * The draft journal in IndexedDB: one record per composer, holding the text
 * and the attachment bytes as Blobs. Writes use strict durability, so a write
 * that resolved is on disk even if the app is killed or updated right after.
 * localStorage cannot promise that: Chromium commits it lazily.
 */
import type { ComposerDraftKey } from "@specweave-studio/contracts";

import type { DurableDraftJournal, DurableDraftJournalEntry } from "./durableComposerDrafts";

const DATABASE = "studio-composer-drafts";
const STORE = "journal";

function request<T>(run: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode) {
  return (database: IDBDatabase) =>
    new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode, { durability: "strict" });
      const result = run(transaction.objectStore(STORE));
      // Resolve on commit, not on the request, so the write is durable.
      transaction.oncomplete = () => resolve(result.result);
      transaction.onerror = () => reject(transaction.error ?? result.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("Draft journal aborted"));
    });
}

export function createIndexedDbDraftJournal(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
): DurableDraftJournal | undefined {
  if (!factory) return undefined;
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DATABASE, 1);
      opening.onupgradeneeded = () => {
        if (!opening.result.objectStoreNames.contains(STORE)) {
          opening.result.createObjectStore(STORE, { keyPath: "key" });
        }
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => {
        opened = null;
        reject(opening.error);
      };
    }));
  return {
    write: async (entry) => {
      await request((store) => store.put(entry), "readwrite")(await open());
    },
    read: async (key: ComposerDraftKey) =>
      (await request(
        (store) => store.get(key) as IDBRequest<DurableDraftJournalEntry | undefined>,
        "readonly",
      )(await open())) ?? undefined,
    remove: async (key) => {
      await request((store) => store.delete(key), "readwrite")(await open());
    },
  };
}

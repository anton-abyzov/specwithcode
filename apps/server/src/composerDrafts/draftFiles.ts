// @effect-diagnostics nodeBuiltinImport:off - fsync of files and folders is not in Effect FileSystem.
/**
 * Unsent composer drafts on disk: `<dir>/<sha256(key)>/draft.json` plus one
 * `<attachmentId>.bin` per attachment. Every write lands in a temp file that is
 * fsynced and renamed, then the folder is fsynced, so a write that returned
 * survives the process being killed (kill -9, a crash, an update restart).
 */
import type { SnapShotSource } from "@specweave-studio/contracts";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface DraftAttachmentMeta {
  readonly id: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly source?: SnapShotSource;
}

export interface StoredDraft {
  readonly key: string;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftAttachmentMeta>;
  readonly editedAt: number;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface PutDraftInput {
  readonly key: string;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftAttachmentMeta & { readonly data?: Uint8Array }>;
  readonly editedAt: number;
}

const DRAFT_FILE = "draft.json";

// Writes to one draft run one at a time: each save prunes attachments the
// previous one may still be writing. Shared by every connection in the process.
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(folder) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.catch(() => undefined);
  locks.set(folder, settled);
  void settled.then(() => {
    if (locks.get(folder) === settled) locks.delete(folder);
  });
  return next;
}
/** Share the same lease as saves/removals when deciding whether a thread may archive. */
export function acquireDraftLease(dir: string, key: string): Promise<() => void> {
  return new Promise((acquired) => {
    void exclusive(draftFolder(dir, key), () => new Promise<void>((release) => acquired(release)));
  });
}

/** Unlike display reads, an unreadable or malformed draft fails closed. Call under its lease. */
export async function hasProtectedDraft(dir: string, key: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(path.join(draftFolder(dir, key), DRAFT_FILE), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        return (await fs.readdir(draftFolder(dir, key))).length > 0;
      } catch (folderCause) {
        if ((folderCause as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw folderCause;
      }
    }
    throw cause;
  }
  const draft = parseDraft(text);
  return draft === null || draft.key !== key || !draftIsEmpty(draft);
}

const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export const draftFolder = (dir: string, key: string) =>
  path.join(dir, createHash("sha256").update(key).digest("hex").slice(0, 40));

const attachmentPath = (folder: string, id: string) => {
  if (!ATTACHMENT_ID.test(id)) throw new Error(`Invalid draft attachment id: ${id}`);
  return path.join(folder, `${id}.bin`);
};

async function syncDirectory(folder: string): Promise<void> {
  const handle = await fs.open(folder, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    // Some filesystems refuse fsync on a directory; the rename already landed.
  } finally {
    await handle.close();
  }
}

async function writeDurably(target: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function parseDraft(text: string): StoredDraft | null {
  try {
    const value = JSON.parse(text) as Partial<StoredDraft>;
    if (
      typeof value.key !== "string" ||
      typeof value.prompt !== "string" ||
      !Array.isArray(value.attachments) ||
      typeof value.editedAt !== "number" ||
      typeof value.revision !== "number"
    ) {
      return null;
    }
    return {
      key: value.key,
      prompt: value.prompt,
      attachments: value.attachments.filter(
        (attachment): attachment is DraftAttachmentMeta =>
          typeof attachment?.id === "string" && ATTACHMENT_ID.test(attachment.id),
      ),
      editedAt: value.editedAt,
      revision: value.revision,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : value.editedAt,
    };
  } catch {
    return null;
  }
}

export async function readDraft(dir: string, key: string): Promise<StoredDraft | null> {
  const text = await fs
    .readFile(path.join(draftFolder(dir, key), DRAFT_FILE), "utf8")
    .catch(() => null);
  const draft = text === null ? null : parseDraft(text);
  return draft?.key === key ? draft : null;
}

/** The draft with every attachment's bytes; an attachment whose file is gone is dropped. */
export async function readDraftWithData(
  dir: string,
  key: string,
): Promise<(StoredDraft & { readonly data: ReadonlyMap<string, Uint8Array> }) | null> {
  const draft = await readDraft(dir, key);
  if (!draft) return null;
  const folder = draftFolder(dir, key);
  const data = new Map<string, Uint8Array>();
  for (const attachment of draft.attachments) {
    const bytes = await fs.readFile(attachmentPath(folder, attachment.id)).catch(() => null);
    if (bytes) data.set(attachment.id, bytes);
  }
  return {
    ...draft,
    attachments: draft.attachments.filter((attachment) => data.has(attachment.id)),
    data,
  };
}

export function draftIsEmpty(input: Pick<PutDraftInput, "prompt" | "attachments">): boolean {
  return input.prompt.trim().length === 0 && input.attachments.length === 0;
}

/**
 * Saves the draft. Attachments sent without bytes must already be on disk;
 * the ones that are not come back as missing and the draft keeps the rest.
 * An empty draft removes the folder.
 */
export function putDraft(
  dir: string,
  input: PutDraftInput,
  now: number,
): Promise<{ readonly revision: number; readonly missingAttachmentIds: ReadonlyArray<string> }> {
  const folder = draftFolder(dir, input.key);
  return exclusive(folder, async () => {
    if (draftIsEmpty(input)) {
      await fs.rm(folder, { recursive: true, force: true });
      return { revision: 0, missingAttachmentIds: [] };
    }
    return writeDraft(folder, input, now);
  });
}

async function writeDraft(
  folder: string,
  input: PutDraftInput,
  now: number,
): Promise<{ readonly revision: number; readonly missingAttachmentIds: ReadonlyArray<string> }> {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const previousText = await fs.readFile(path.join(folder, DRAFT_FILE), "utf8").catch(() => null);
  const previous = previousText === null ? null : parseDraft(previousText);
  const missingAttachmentIds: string[] = [];
  const kept: DraftAttachmentMeta[] = [];
  for (const attachment of input.attachments) {
    const target = attachmentPath(folder, attachment.id);
    if (attachment.data) {
      await writeDurably(target, attachment.data);
    } else if (!(await fs.stat(target).catch(() => null))) {
      missingAttachmentIds.push(attachment.id);
      continue;
    }
    kept.push({
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.source ? { source: attachment.source } : {}),
    });
  }
  const revision = (previous?.revision ?? 0) + 1;
  const draft: StoredDraft = {
    key: input.key,
    prompt: input.prompt,
    attachments: kept,
    editedAt: input.editedAt,
    revision,
    updatedAt: now,
  };
  await writeDurably(path.join(folder, DRAFT_FILE), `${JSON.stringify(draft)}\n`);
  await syncDirectory(folder);
  // Attachments removed from the draft are removed from disk only after the
  // draft that no longer names them is safely written.
  const keep = new Set(kept.map((attachment) => `${attachment.id}.bin`));
  for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
    if (name === DRAFT_FILE || keep.has(name)) continue;
    if (name.endsWith(".bin") || name.endsWith(".tmp")) {
      await fs.rm(path.join(folder, name), { force: true });
    }
  }
  return { revision, missingAttachmentIds };
}

export function removeDraft(dir: string, key: string): Promise<void> {
  const folder = draftFolder(dir, key);
  return exclusive(folder, () => fs.rm(folder, { recursive: true, force: true }));
}

export async function listDrafts(dir: string): Promise<ReadonlyArray<StoredDraft>> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const drafts: StoredDraft[] = [];
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name, DRAFT_FILE), "utf8").catch(() => null);
    const draft = text === null ? null : parseDraft(text);
    if (draft && draftFolder(dir, draft.key) === path.join(dir, name)) drafts.push(draft);
  }
  return drafts;
}

/**
 * Drafts across an update restart: the host stops before the window closes,
 * so every change must reach this window's journal at once, come back after
 * the relaunch, and reach the host once it answers again.
 */
import type {
  ComposerDraftKey,
  ComposerDraftPutInput,
  ComposerDraftRecord,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDurableDraftSync,
  type DurableDraftEdit,
  type DurableDraftJournal,
  type DurableDraftJournalEntry,
  type DurableDraftSnapshot,
} from "./durableComposerDrafts";

const KEY = "coordinator:p1" as ComposerDraftKey;
const TARGET = { environmentId: "env", key: KEY };

const image = (id: string, bytes = [1, 2, 3]) => ({
  id,
  type: "image" as const,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: bytes.length,
  file: new Blob([Uint8Array.from(bytes)], { type: "image/png" }),
});
const text = (prompt: string, attachments: ReturnType<typeof image>[] = []) =>
  ({ prompt, attachments }) satisfies DurableDraftSnapshot;

/** A host that can be stopped and started, like the service during an update. */
function makeHost() {
  const drafts = new Map<string, ComposerDraftRecord>();
  let up = true;
  return {
    drafts,
    stop: () => {
      up = false;
    },
    start: () => {
      up = true;
    },
    transport: {
      put: async (_environmentId: string, input: ComposerDraftPutInput) => {
        if (!up) throw new Error("socket closed");
        if (!input.prompt.trim() && input.attachments.length === 0) {
          drafts.delete(input.key);
          return { revision: 0, missingAttachmentIds: [] };
        }
        const previous = drafts.get(input.key);
        drafts.set(input.key, {
          key: input.key,
          prompt: input.prompt,
          editedAt: input.editedAt,
          revision: (previous?.revision ?? 0) + 1,
          attachments: input.attachments.map((attachment) => ({
            ...attachment,
            dataBase64:
              attachment.dataBase64 ??
              previous?.attachments.find((stored) => stored.id === attachment.id)?.dataBase64 ??
              "",
          })),
        });
        return { revision: 1, missingAttachmentIds: [] };
      },
      get: async (_environmentId: string, key: ComposerDraftKey) => {
        if (!up) throw new Error("socket closed");
        return drafts.get(key) ?? null;
      },
    },
  };
}

/** The journal outlives a window, as IndexedDB does. */
function makeJournal() {
  const entries = new Map<string, DurableDraftJournalEntry>();
  const journal: DurableDraftJournal = {
    write: async (entry) => void entries.set(entry.key, entry),
    read: async (key) => entries.get(key),
    remove: async (key) => void entries.delete(key),
  };
  return { entries, journal };
}

let clock = 1_000;
/** One app window; a relaunch is a new window over the same journal and host. */
function openWindow(
  host: ReturnType<typeof makeHost>,
  journal: DurableDraftJournal,
  edits = new Map<string, DurableDraftEdit>(),
) {
  return createDurableDraftSync({
    transport: host.transport,
    journal,
    edits: { read: (key) => edits.get(key), write: (key, edit) => void edits.set(key, edit) },
    debounceMs: 300,
    retryDelaysMs: [1_000],
    now: () => (clock += 10),
  });
}

/** The composer of the relaunched window, empty as after a crash. */
function composer() {
  let current: DurableDraftSnapshot = text("");
  return {
    local: () => current,
    apply: (snapshot: DurableDraftSnapshot) => {
      current = snapshot;
    },
    read: () => current,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("drafts across an update restart", () => {
  it("keeps every character typed while the host was stopping, through the relaunch", async () => {
    const host = makeHost();
    const { journal, entries } = makeJournal();
    const before = openWindow(host, journal);
    before.schedule(TARGET, text("Make sure"));
    await before.flush();
    expect(host.drafts.get(KEY)?.prompt).toBe("Make sure");

    // The update stops the host first; the user keeps typing, then the app dies.
    host.stop();
    for (const prompt of [
      "Make sure we",
      "Make sure we store",
      "Make sure we store every symbol ✓",
    ]) {
      before.schedule(TARGET, text(prompt, [image("shot", [7, 7, 7])]));
    }
    await before.journalSettled();
    // No debounce or flush ran: the journal alone has the last keystroke.
    expect(entries.get(KEY)?.snapshot.prompt).toBe("Make sure we store every symbol ✓");
    expect(entries.get(KEY)?.synced).toBe(false);

    // Relaunch: the host is still starting.
    const after = openWindow(host, journal);
    const restored = composer();
    expect(await after.restoreLocal({ target: TARGET, ...restored })).toBe("restored");
    expect(restored.read().prompt).toBe("Make sure we store every symbol ✓");
    expect([...new Uint8Array(await restored.read().attachments[0]!.file.arrayBuffer())]).toEqual([
      7, 7, 7,
    ]);

    // The host comes back and gets the draft it never saw.
    host.start();
    expect(await after.restore({ target: TARGET, ...restored })).toBe("kept");
    await after.flush();
    expect(host.drafts.get(KEY)?.prompt).toBe("Make sure we store every symbol ✓");
    await after.journalSettled();
    expect(entries.get(KEY)?.synced).toBe(true);
  });

  it("retries a save the host refused once it is back, without another edit", async () => {
    const host = makeHost();
    const { journal } = makeJournal();
    const sync = openWindow(host, journal);
    host.stop();
    sync.schedule(TARGET, text("typed during the restart"));
    await vi.advanceTimersByTimeAsync(300);
    expect(host.drafts.has(KEY)).toBe(false);
    host.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.drafts.get(KEY)?.prompt).toBe("typed during the restart");
  });

  it("a message sent during the update comes back if the app dies before the send is confirmed", async () => {
    const host = makeHost();
    const { journal } = makeJournal();
    const edits = new Map<string, DurableDraftEdit>();
    const before = openWindow(host, journal, edits);
    before.schedule(TARGET, text("Send me during the update"));
    await before.flush();

    // Send: the composer clears at once, the host goes down, the send never settles.
    before.hold(KEY);
    before.schedule(TARGET, text(""));
    host.stop();
    await before.journalSettled();

    const after = openWindow(host, journal, edits);
    const restored = composer();
    await after.restoreLocal({ target: TARGET, ...restored });
    host.start();
    await after.restore({ target: TARGET, ...restored });
    expect(restored.read().prompt).toBe("Send me during the update");
  });

  it("a confirmed send stays cleared after a relaunch", async () => {
    const host = makeHost();
    const { journal, entries } = makeJournal();
    const edits = new Map<string, DurableDraftEdit>();
    const before = openWindow(host, journal, edits);
    before.schedule(TARGET, text("delivered"));
    await before.flush();
    const release = before.hold(KEY);
    before.schedule(TARGET, text(""));
    release();
    await before.flush();
    await before.journalSettled();
    expect(host.drafts.has(KEY)).toBe(false);
    expect(entries.has(KEY)).toBe(false);

    const after = openWindow(host, journal, edits);
    const restored = composer();
    expect(await after.restoreLocal({ target: TARGET, ...restored })).toBe("none");
    expect(await after.restore({ target: TARGET, ...restored })).toBe("none");
    expect(restored.read().prompt).toBe("");
  });

  it("a newer edit from another window on the host wins over an older journal", async () => {
    const host = makeHost();
    const { journal } = makeJournal();
    const mac = openWindow(host, journal);
    host.stop();
    mac.schedule(TARGET, text("older text on the Mac"));
    await mac.journalSettled();
    host.start();
    host.drafts.set(KEY, {
      key: KEY,
      prompt: "newer text from the web",
      attachments: [],
      editedAt: clock + 1_000,
      revision: 5,
    });

    const relaunched = openWindow(host, journal);
    const restored = composer();
    await relaunched.restoreLocal({ target: TARGET, ...restored });
    expect(restored.read().prompt).toBe("older text on the Mac");
    await relaunched.restore({ target: TARGET, ...restored });
    expect(restored.read().prompt).toBe("newer text from the web");
    await relaunched.flush();
    expect(host.drafts.get(KEY)?.prompt).toBe("newer text from the web");
  });

  it("restores from the journal when a remote host stays offline", async () => {
    const host = makeHost();
    const { journal } = makeJournal();
    host.stop();
    const before = openWindow(host, journal);
    before.schedule(TARGET, text("for the MacBook Pro"));
    await before.journalSettled();

    const after = openWindow(host, journal);
    const restored = composer();
    expect(await after.restoreLocal({ target: TARGET, ...restored })).toBe("restored");
    expect(restored.read().prompt).toBe("for the MacBook Pro");
  });

  it("does not bring back text another window sent or cleared meanwhile", async () => {
    const host = makeHost();
    const { journal, entries } = makeJournal();
    const mac = openWindow(host, journal);
    mac.schedule(TARGET, text("sent from the web later"));
    await mac.flush();
    await mac.journalSettled();
    expect(entries.get(KEY)?.synced).toBe(true);
    // The web sent it, so the host dropped the draft.
    host.drafts.delete(KEY);

    const relaunched = openWindow(host, journal);
    const restored = composer();
    await relaunched.restoreLocal({ target: TARGET, ...restored });
    await relaunched.restore({ target: TARGET, ...restored });
    await relaunched.journalSettled();
    expect(restored.read().prompt).toBe("");
    expect(entries.has(KEY)).toBe(false);
  });
});

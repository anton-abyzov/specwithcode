import {
  ComposerDraftPutInput as DraftPutSchema,
  ComposerDraftRecord as DraftRecordSchema,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import type {
  ComposerDraftKey,
  ComposerDraftPutInput,
  ComposerDraftRecord,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDurableDraftSync,
  type DurableDraftEdit,
  type DurableDraftJournalEntry,
  type DurableDraftSnapshot,
} from "./durableComposerDrafts";

const snapshotSource = {
  kind: "snap-shot" as const,
  capturedAt: "2026-10-27T00:42:15.142Z",
  appName: "SpecWithCode",
  windowTitle: "Settings",
  accessibleText: "Snapshot settings",
  accessibility: {
    format: "element-tree" as const,
    coordinateSpace: "captured-image" as const,
    imageSize: { width: 4096, height: 2420 },
    truncated: false,
    root: {
      role: "button",
      name: "Done",
      bounds: { x: 2456, y: 1500, width: 118, height: 64 },
      children: [],
    },
  },
};

const KEY = "thread:t1" as ComposerDraftKey;
const TARGET = { environmentId: "env", key: KEY };

const image = (id: string, bytes = [1, 2, 3]) => ({
  id,
  type: "image" as const,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: bytes.length,
  file: new Blob([Uint8Array.from(bytes)], { type: "image/png" }),
});

/** An in-memory host that behaves like the server's draft files. */
function makeHost() {
  const drafts = new Map<string, ComposerDraftRecord>();
  const puts: ComposerDraftPutInput[] = [];
  let failNext = false;
  return {
    drafts,
    puts,
    failNext: () => {
      failNext = true;
    },
    transport: {
      put: async (_environmentId: string, input: ComposerDraftPutInput) => {
        if (failNext) {
          failNext = false;
          throw new Error("offline");
        }
        input = Schema.decodeSync(DraftPutSchema)(input);
        puts.push(input);
        const previous = drafts.get(input.key);
        if (!input.prompt.trim() && input.attachments.length === 0) {
          drafts.delete(input.key);
          return { revision: 0, missingAttachmentIds: [] };
        }
        const missing: string[] = [];
        const attachments = input.attachments.flatMap((attachment) => {
          const data =
            attachment.dataBase64 ??
            previous?.attachments.find((stored) => stored.id === attachment.id)?.dataBase64;
          if (data === undefined) {
            missing.push(attachment.id);
            return [];
          }
          return [{ ...attachment, dataBase64: data }];
        });
        const revision = (previous?.revision ?? 0) + 1;
        drafts.set(input.key, {
          key: input.key,
          prompt: input.prompt,
          attachments,
          editedAt: input.editedAt,
          revision,
        });
        return { revision, missingAttachmentIds: missing };
      },
      get: async (_environmentId: string, key: ComposerDraftKey) => {
        const draft = drafts.get(key);
        return draft ? Schema.decodeSync(DraftRecordSchema)(draft) : null;
      },
    },
  };
}

function makeSync(host: ReturnType<typeof makeHost>, log = new Map<string, DurableDraftEdit>()) {
  let clock = 1_000;
  const sync = createDurableDraftSync({
    transport: host.transport,
    edits: { read: (key) => log.get(key), write: (key, edit) => void log.set(key, edit) },
    debounceMs: 300,
    now: () => (clock += 10),
  });
  return { sync, log };
}

const text = (prompt: string, attachments: DurableDraftSnapshot["attachments"] = []) =>
  ({ prompt, attachments }) satisfies DurableDraftSnapshot;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("durable composer drafts", () => {
  it("restores complete snapshot context from the local journal before the host is available", async () => {
    const entries = new Map<string, DurableDraftJournalEntry>();
    const journal = {
      write: async (entry: DurableDraftJournalEntry) => {
        entries.set(entry.key, structuredClone(entry));
      },
      read: async (key: ComposerDraftKey) => entries.get(key),
      remove: async (key: ComposerDraftKey) => {
        entries.delete(key);
      },
    };
    const host = makeHost();
    const edits = { read: () => undefined, write: () => undefined };
    const before = createDurableDraftSync({ transport: host.transport, edits, journal });
    before.schedule(
      TARGET,
      text("Unsent user words", [{ ...image("shot"), source: snapshotSource }]),
    );
    await before.journalSettled();
    let restored: DurableDraftSnapshot | undefined;
    const after = createDurableDraftSync({ transport: host.transport, edits, journal });
    await after.restoreLocal({
      target: TARGET,
      local: () => text(""),
      apply: (snapshot) => {
        restored = snapshot;
      },
    });
    expect(restored?.prompt).toBe("Unsent user words");
    expect(restored?.attachments[0]?.source).toEqual(snapshotSource);
    expect([...new Uint8Array(await restored!.attachments[0]!.file.arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
    expect(host.puts).toHaveLength(0);
  });

  it("persists metadata-only changes and restores snapshot context with the original bytes", async () => {
    const host = makeHost();
    const { sync, log } = makeSync(host);
    const attachment = image("shot", [9, 8, 7]);
    sync.schedule(TARGET, text("User words", [attachment]));
    await sync.flush();
    sync.schedule(TARGET, text("User words", [{ ...attachment, source: snapshotSource }]));
    await sync.flush();
    expect(host.puts).toHaveLength(2);
    expect(host.puts[1]!.attachments[0]!.dataBase64).toBeUndefined();
    expect(host.drafts.get(KEY)?.attachments[0]?.source).toEqual(snapshotSource);
    let restored: DurableDraftSnapshot | undefined;
    await makeSync(host, log).sync.restore({
      target: TARGET,
      local: () => text(""),
      apply: (snapshot) => {
        restored = snapshot;
      },
    });
    expect(restored?.prompt).toBe("User words");
    expect(restored?.attachments[0]?.source).toEqual(snapshotSource);
    expect([...new Uint8Array(await restored!.attachments[0]!.file.arrayBuffer())]).toEqual([
      9, 8, 7,
    ]);
  });

  it("saves after the debounce and sends attachment bytes only once", async () => {
    const host = makeHost();
    const { sync } = makeSync(host);
    sync.schedule(TARGET, text("h", [image("a")]));
    sync.schedule(TARGET, text("he", [image("a")]));
    expect(host.puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(host.puts).toHaveLength(1);
    expect(host.puts[0]!.attachments[0]!.dataBase64).toBe(btoa("\u0001\u0002\u0003"));

    sync.schedule(TARGET, text("hello", [image("a")]));
    await sync.flush();
    expect(host.puts).toHaveLength(2);
    expect(host.puts[1]!.attachments[0]!.dataBase64).toBeUndefined();
    expect(host.drafts.get(KEY)?.prompt).toBe("hello");
  });

  it("flush saves at once, and a failed save is retried", async () => {
    const host = makeHost();
    const { sync } = makeSync(host);
    host.failNext();
    sync.schedule(TARGET, text("draft"));
    await sync.flush();
    expect(host.drafts.has(KEY)).toBe(false);
    await sync.flush();
    expect(host.drafts.get(KEY)?.prompt).toBe("draft");
  });

  it("keeps the host copy until a send releases its hold", async () => {
    const host = makeHost();
    const { sync } = makeSync(host);
    sync.schedule(TARGET, text("ship it"));
    await sync.flush();

    const release = sync.hold(KEY);
    sync.schedule(TARGET, text(""));
    await sync.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.drafts.get(KEY)?.prompt).toBe("ship it");

    release();
    await sync.flush();
    expect(host.drafts.has(KEY)).toBe(false);
  });

  it("a failed send restores the composer and the host keeps the text", async () => {
    const host = makeHost();
    const { sync } = makeSync(host);
    sync.schedule(TARGET, text("retry me"));
    await sync.flush();
    const release = sync.hold(KEY);
    sync.schedule(TARGET, text(""));
    sync.schedule(TARGET, text("retry me"));
    release();
    await sync.flush();
    expect(host.drafts.get(KEY)?.prompt).toBe("retry me");
  });

  it("restores text and images into an empty composer after a crash", async () => {
    const host = makeHost();
    const log = new Map<string, DurableDraftEdit>();
    const before = makeSync(host, log).sync;
    before.schedule(TARGET, text("typed before the crash", [image("shot", [9, 8, 7])]));
    await before.flush();

    // A new window: the composer lost everything, the edit log may be stale.
    const after = makeSync(host, log).sync;
    let applied: DurableDraftSnapshot | null = null;
    const result = await after.restore({
      target: TARGET,
      local: () => text(""),
      apply: (snapshot) => {
        applied = snapshot;
      },
    });
    expect(result).toBe("restored");
    expect(applied!.prompt).toBe("typed before the crash");
    const bytes = new Uint8Array(await applied!.attachments[0]!.file.arrayBuffer());
    expect([...bytes]).toEqual([9, 8, 7]);
  });

  it("restores into an empty composer even when the last local edit never reached the host", async () => {
    const host = makeHost();
    const log = new Map<string, DurableDraftEdit>();
    const before = makeSync(host, log).sync;
    before.schedule(TARGET, text("saved part"));
    await before.flush();
    // Killed between this edit and its save.
    before.schedule(TARGET, text("saved part and more"));

    const after = makeSync(host, log).sync;
    const apply = vi.fn();
    await after.restore({ target: TARGET, local: () => text(""), apply });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ prompt: "saved part" }));
  });

  it("keeps a composer that was emptied on purpose after the host saved", async () => {
    const host = makeHost();
    const log = new Map<string, DurableDraftEdit>();
    host.drafts.set(KEY, { key: KEY, prompt: "old", attachments: [], editedAt: 5, revision: 1 });
    log.set(KEY, { at: 50, empty: true });
    const { sync } = makeSync(host, log);
    const apply = vi.fn();
    expect(await sync.restore({ target: TARGET, local: () => text(""), apply })).toBe("kept");
    expect(apply).not.toHaveBeenCalled();
    await sync.flush();
    expect(host.drafts.has(KEY)).toBe(false);
  });

  it("the newer side wins between this window and another one", async () => {
    const host = makeHost();
    const log = new Map<string, DurableDraftEdit>();
    host.drafts.set(KEY, {
      key: KEY,
      prompt: "from web",
      attachments: [],
      editedAt: 500,
      revision: 3,
    });
    log.set(KEY, { at: 100, empty: false });
    const { sync } = makeSync(host, log);
    const apply = vi.fn();
    expect(await sync.restore({ target: TARGET, local: () => text("older mac text"), apply })).toBe(
      "restored",
    );
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ prompt: "from web" }));

    log.set(KEY, { at: 900, empty: false });
    const newer = vi.fn();
    expect(
      await sync.restore({ target: TARGET, local: () => text("newer mac text"), apply: newer }),
    ).toBe("kept");
    expect(newer).not.toHaveBeenCalled();
    await sync.flush();
    expect(host.drafts.get(KEY)?.prompt).toBe("newer mac text");
  });

  it("does not save a restored copy straight back", async () => {
    const host = makeHost();
    host.drafts.set(KEY, { key: KEY, prompt: "host", attachments: [], editedAt: 5, revision: 1 });
    const { sync } = makeSync(host);
    await sync.restore({
      target: TARGET,
      local: () => text(""),
      apply: (snapshot) => sync.schedule(TARGET, snapshot),
    });
    await sync.flush();
    expect(host.puts).toHaveLength(0);
  });

  it("resends bytes the host no longer holds", async () => {
    const host = makeHost();
    const { sync } = makeSync(host);
    sync.schedule(TARGET, text("x", [image("a")]));
    await sync.flush();
    host.drafts.set(KEY, { ...host.drafts.get(KEY)!, attachments: [] });
    sync.schedule(TARGET, text("xy", [image("a")]));
    await sync.flush();
    expect(host.puts.at(-1)!.attachments[0]!.dataBase64).toBeDefined();
    expect(host.drafts.get(KEY)?.attachments.map((attachment) => attachment.id)).toEqual(["a"]);
  });
});

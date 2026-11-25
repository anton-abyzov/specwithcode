import type { DocumentSessionEvent, DocumentSessionParticipant } from "@specweave-studio/contracts";
import {
  type SheetDocument,
  parseSheetDocument,
  setCells,
} from "@specweave-studio/shared/officeSheet";
import {
  applySheetUpdate,
  encodeSheetState,
  readSheetYDoc,
  sheetUpdateFromBase64,
  sheetUpdateToBase64,
  sheetYDocFrom,
} from "@specweave-studio/shared/sheetCollab";
import { describe, expect, it } from "vite-plus/test";

import { type LiveSheetSendResult, LiveSheetStore } from "./liveSheetStore";
import { presenceEntries } from "./presence";
import { liveSheetBinding } from "./useLiveSheet";

const MESSAGES = { viewOnly: "view only", refused: "refused", reloaded: "reloaded" };

function sheet(cells: Record<string, string | number>): SheetDocument {
  const parsed = parseSheetDocument(
    JSON.stringify({ v: 1, kind: "sheet", title: "Budget", tabs: [{ name: "Plan", cells }] }),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

/**
 * The home machine, as far as a window can tell: one merge document, every
 * change checked against the sender's access, then sent on to everyone.
 */
function home(start: SheetDocument) {
  let doc = sheetYDocFrom(start, "file");
  let epoch = "e1";
  const windows = new Map<
    string,
    { readonly store: LiveSheetStore; participant: DocumentSessionParticipant; sent: number }
  >();
  let refuseNext: LiveSheetSendResult | null = null;
  const everyone = () => [...windows.values()].map((entry) => entry.participant);
  const send = (event: DocumentSessionEvent) => {
    for (const entry of windows.values()) entry.store.receive(event);
  };
  const snapshot = (id: string) => {
    const entry = windows.get(id)!;
    entry.store.receive({
      type: "snapshot",
      participantId: id,
      epoch,
      access: entry.participant.access,
      update: sheetUpdateToBase64(encodeSheetState(doc)),
      participants: everyone(),
      activity: [],
    });
  };
  return {
    get doc() {
      return doc;
    },
    /** The server stopped and started again from the file, which never got the unsaved edits. */
    startOver(file: SheetDocument) {
      doc = sheetYDocFrom(file, "file");
      epoch = "e2";
    },
    restarts: [] as string[],
    refuse(result: LiveSheetSendResult) {
      refuseNext = result;
    },
    sent: (id: string) => windows.get(id)!.sent,
    join(id: string, access: "edit" | "view"): LiveSheetStore {
      const restarts = this.restarts;
      const store = new LiveSheetStore(
        {
          update: async (update) => {
            const entry = windows.get(id)!;
            entry.sent += 1;
            if (entry.participant.access !== "edit") return "view_only";
            if (refuseNext !== null) {
              const result = refuseNext;
              refuseNext = null;
              return result;
            }
            applySheetUpdate(doc, sheetUpdateFromBase64(update)!, id);
            send({ type: "update", update });
            return "merged";
          },
          presence: (place) => {
            const entry = windows.get(id)!;
            const { place: _old, ...rest } = entry.participant;
            entry.participant = place === null ? rest : { ...rest, place };
            send({ type: "presence", participants: everyone() });
          },
          restart: () => {
            restarts.push(id);
            snapshot(id);
          },
        },
        MESSAGES,
      );
      windows.set(id, {
        store,
        participant: { id, kind: "window", color: windows.size, access },
        sent: 0,
      });
      snapshot(id);
      send({ type: "presence", participants: everyone() });
      return store;
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const cells = (store: LiveSheetStore) => store.getState().document!.tabs[0]!.cells;
const edit = (store: LiveSheetStore, name: string, value: string | number) => {
  const address = { col: name.charCodeAt(0) - 65, row: Number(name.slice(1)) - 1 };
  return store.commit(setCells(store.getState().document!, 0, [[address, value]]));
};

describe("a live sheet in two windows", () => {
  it("shows each window the other's edits, with nothing to conflict on", async () => {
    const machine = home(sheet({ A1: "Item", B1: 1 }));
    const first = machine.join("w1", "edit");
    const second = machine.join("w2", "edit");

    expect(edit(first, "A2", "Rent")).toBe(true);
    expect(edit(second, "B2", 900)).toBe(true);
    await settle();

    for (const store of [first, second]) {
      expect(cells(store)).toMatchObject({ A1: "Item", B1: 1, A2: "Rent", B2: 900 });
      expect(store.getState().status).toBe("live");
      expect(store.getState().problem).toBeNull();
    }
    expect(readSheetYDoc(machine.doc).document.tabs[0]!.cells).toMatchObject({
      A2: "Rent",
      B2: 900,
    });
    expect(machine.restarts).toEqual([]);
  });

  it("settles two edits of one cell on one value in both windows", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    const second = machine.join("w2", "edit");

    edit(first, "A1", "From the first");
    edit(second, "A1", "From the second");
    await settle();

    const value = cells(first).A1;
    expect(["From the first", "From the second"]).toContain(value);
    expect(cells(second).A1).toBe(value);
    expect(readSheetYDoc(machine.doc).document.tabs[0]!.cells.A1).toBe(value);
  });

  it("undoes only this window's own edit", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    const second = machine.join("w2", "edit");

    edit(first, "A2", "Mine");
    await settle();
    edit(second, "B2", "Theirs");
    await settle();
    expect(first.getState().canUndo).toBe(true);
    first.undo();
    await settle();

    for (const store of [first, second]) {
      expect(cells(store).A2).toBeUndefined();
      expect(cells(store).B2).toBe("Theirs");
    }
    first.redo();
    await settle();
    expect(cells(second).A2).toBe("Mine");
  });

  it("shows each window where the other is", () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    const second = machine.join("w2", "edit");
    const tab = first.getState().tabIds[0]!;

    first.setPlace({ tab, cell: "B2", range: "B2:C3" });

    const state = second.getState();
    const presence = presenceEntries(state.participants, state.participantId, {
      self: "You",
      window: (n) => `Window ${n}`,
      agent: "Agent",
    });
    expect(presence.map((entry) => [entry.name, entry.self])).toEqual([
      ["Window 2", false],
      ["You", true],
    ]);
    const binding = liveSheetBinding(second, state, presence)!;
    expect(binding.others).toHaveLength(1);
    expect(binding.others[0]).toMatchObject({ id: "w1", tab, cell: "B2", range: "B2:C3" });

    first.setPlace(null);
    expect(
      second.getState().participants.find((entry) => entry.id === "w1")?.place,
    ).toBeUndefined();
  });
});

describe("a view-only window", () => {
  it("makes no edit and sends nothing", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const viewer = machine.join("w1", "view");

    expect(viewer.editable).toBe(false);
    expect(edit(viewer, "A1", "Changed")).toBe(false);
    viewer.undo();
    await settle();

    expect(machine.sent("w1")).toBe(0);
    expect(cells(viewer).A1).toBe("Item");
    expect(viewer.getState().problem).toBe(MESSAGES.viewOnly);
    const state = viewer.getState();
    expect(liveSheetBinding(viewer, state, [])!.editable).toBe(false);
  });

  it("still sees what the others write", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const viewer = machine.join("w1", "view");
    const editor = machine.join("w2", "edit");
    edit(editor, "A2", "Rent");
    await settle();
    expect(cells(viewer).A2).toBe("Rent");
  });
});

describe("a change the home machine does not take", () => {
  it("goes back to what everyone sees and says so", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    machine.refuse("refused");

    edit(first, "A1", "Not allowed");
    expect(cells(first).A1).toBe("Not allowed");
    await settle();

    expect(machine.restarts).toEqual(["w1"]);
    expect(cells(first).A1).toBe("Item");
    expect(first.getState().problem).toBe(MESSAGES.refused);
    expect(first.getState().canUndo).toBe(false);
  });

  it("sends an edit again when it was not delivered", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    const second = machine.join("w2", "edit");
    machine.refuse("failed");

    edit(first, "A2", "Kept");
    await settle();
    await settle();

    expect(machine.restarts).toEqual(["w1"]);
    expect(cells(first).A2).toBe("Kept");
    expect(cells(second).A2).toBe("Kept");
    expect(first.getState().problem).toBeNull();
  });

  it("makes an undelivered edit again when the home machine started over from the file", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    // The server goes away with the edit on its way, and comes back from a file someone else changed.
    machine.refuse("failed");
    machine.startOver(sheet({ A1: "Item", C1: "Written elsewhere" }));
    expect(edit(first, "A2", "Rent")).toBe(true);
    await settle();

    expect(machine.restarts).toEqual(["w1"]);
    // The new document has the edit, sent again as a change to it, beside what the file brought.
    expect(readSheetYDoc(machine.doc).document.tabs[0]!.cells).toEqual({
      A1: "Item",
      C1: "Written elsewhere",
      A2: "Rent",
    });
    expect(cells(first)).toEqual({ A1: "Item", C1: "Written elsewhere", A2: "Rent" });
    expect(first.getState().problem).toBeNull();
  });

  it("merges only what an edit changed when it was worked out from an earlier sheet", async () => {
    const machine = home(sheet({ A1: "Item", B2: 1 }));
    const first = machine.join("w1", "edit");
    const second = machine.join("w2", "edit");
    // The first window starts a drag: its edit will be built on the sheet as it is now.
    const atStart = first.getState().document!;
    expect(edit(second, "B2", 900)).toBe(true);
    await settle();
    expect(cells(first).B2).toBe(900);

    // The drag ends: the sheet it was built from, with one width changed.
    const next = { ...atStart, tabs: [{ ...atStart.tabs[0]!, widths: { A: 200 } }] };
    expect(first.commit(next, atStart)).toBe(true);
    await settle();

    for (const store of [first, second]) {
      expect(cells(store).B2).toBe(900);
      expect(store.getState().document!.tabs[0]!.widths).toEqual({ A: 200 });
    }
  });

  it("refuses a sheet that would be invalid before anything is sent", async () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    const broken = { ...first.getState().document!, tabs: [] } as unknown as SheetDocument;

    expect(first.commit(broken)).toBe(false);
    await settle();
    expect(machine.sent("w1")).toBe(0);
    expect(first.getState().problem).not.toBeNull();
  });
});

describe("a session that ends", () => {
  it("stops being editable", () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    first.receive({ type: "closed", reason: "The file was removed." });
    expect(first.getState().status).toBe("closed");
    expect(first.editable).toBe(false);
    expect(liveSheetBinding(first, first.getState(), [])).toBeNull();
  });
});

describe("a file that cannot be saved", () => {
  it("says so in every window until the file is written again", () => {
    const machine = home(sheet({ A1: "Item" }));
    const first = machine.join("w1", "edit");
    first.receive({ type: "save", saved: false, detail: "The sheet could not be saved." });
    expect(first.getState().unsaved).toBe("The sheet could not be saved.");
    expect(liveSheetBinding(first, first.getState(), [])!.problem).toBe(
      "The sheet could not be saved.",
    );
    // Editing goes on meanwhile.
    expect(edit(first, "A2", "Rent")).toBe(true);
    first.receive({ type: "save", saved: true });
    expect(first.getState().unsaved).toBeNull();
    expect(liveSheetBinding(first, first.getState(), [])!.problem).toBeNull();
  });
});

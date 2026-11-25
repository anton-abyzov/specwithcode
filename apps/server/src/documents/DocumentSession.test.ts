// @effect-diagnostics nodeBuiltinImport:off - The fixture sheet is written and read back with node:fs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type DocumentSessionAccess,
  type DocumentSessionEvent,
  ProjectId,
} from "@specweave-studio/contracts";
import {
  type SheetDocument,
  serializeSheetDocument,
  setCells,
  sheetContentRevision,
  validateSheetDocument,
} from "@specweave-studio/shared/officeSheet";
import {
  applySheetUpdate,
  createSheetYDoc,
  onSheetUpdate,
  readSheetYDoc,
  sheetUpdateFromBase64,
  sheetUpdateToBase64,
  writeSheetChange,
} from "@specweave-studio/shared/sheetCollab";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as DocumentSession from "./DocumentSession.ts";
import {
  SHEET_SIDECAR_DIR,
  SHEET_SIDECAR_MAX_LINES,
  loadSheet,
  parseSheetSidecar,
  sheetSidecarPath,
} from "./sheetYDoc.ts";

const layerFiles = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

// A private home and a scratch folder per test: nothing here touches a live store.
const layerTest = DocumentSession.layer.pipe(
  Layer.provideMerge(layerFiles),
  Layer.provideMerge(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "studio-document-session-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function sheet(input: unknown): SheetDocument {
  const checked = validateSheetDocument(input);
  if (!checked.ok) throw new Error(checked.error);
  return checked.document;
}

const BUDGET = sheet({
  title: "Budget",
  tabs: [
    {
      name: "Plan",
      cells: { A1: "Item", B1: "Cost", A2: "Rent", B2: 1200, A3: "Total", B3: "=SUM(B2:B2)" },
      formats: { "B2:B3": { kind: "currency", currency: "USD" } },
    },
  ],
});
const TEXT = serializeSheetDocument(BUDGET);
const RELATIVE = ".specweave/artifacts/budget.sheet.json";
const PROJECT = ProjectId.make("project-1480");

/** A project folder holding one saved sheet. */
const project = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "studio-document-session-" });
  NodeFS.mkdirSync(NodePath.join(cwd, ".specweave", "artifacts"), { recursive: true });
  const file = NodePath.join(cwd, RELATIVE);
  NodeFS.writeFileSync(file, TEXT);
  return {
    cwd,
    file,
    target: { cwd, relativePath: RELATIVE },
    read: () => NodeFS.readFileSync(file, "utf8"),
    cells: () => sheet(JSON.parse(NodeFS.readFileSync(file, "utf8"))).tabs[0]!.cells,
  };
});

type Snapshot = Extract<DocumentSessionEvent, { type: "snapshot" }>;

/** One window on the sheet: its own merge document, fed by the session's events. */
const openWindow = (
  target: { readonly cwd: string; readonly relativePath: string },
  sessionKey: string,
  access: DocumentSessionAccess = "edit",
) =>
  Effect.gen(function* () {
    const sessions = yield* DocumentSession.DocumentSession;
    const events = yield* Queue.unbounded<DocumentSessionEvent>();
    const fiber = yield* sessions.open({ ...target, sessionKey, access }).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const first = (yield* Queue.take(events)) as Snapshot;
    expect(first.type).toBe("snapshot");
    const doc = createSheetYDoc();
    applySheetUpdate(doc, sheetUpdateFromBase64(first.update)!, "remote");
    /** The next event, merged when it is a change. */
    const next = Queue.take(events).pipe(
      Effect.tap((event) =>
        Effect.sync(() => {
          if (event.type === "update") {
            applySheetUpdate(doc, sheetUpdateFromBase64(event.update)!, "remote");
          }
        }),
      ),
    );
    /** The next event of one kind, merging the changes on the way. */
    const nextOf = <T extends DocumentSessionEvent["type"]>(type: T) =>
      Effect.gen(function* () {
        for (;;) {
          const event = yield* next;
          if (event.type === type) return event as Extract<DocumentSessionEvent, { type: T }>;
        }
      });
    /** An edit made in this window, as the update it would send. */
    const edit = (change: (document: SheetDocument) => SheetDocument): string => {
      const updates: Uint8Array[] = [];
      const stop = onSheetUpdate(doc, (update) => updates.push(update));
      const before = readSheetYDoc(doc);
      writeSheetChange(doc, before, change(before.document), "local");
      stop();
      expect(updates).toHaveLength(1);
      return sheetUpdateToBase64(updates[0]!);
    };
    const send = (change: (document: SheetDocument) => SheetDocument) =>
      sessions.update({ ...target, sessionKey, update: edit(change) });
    return {
      first,
      doc,
      fiber,
      events,
      next,
      nextOf,
      edit,
      send,
      cells: () => readSheetYDoc(doc).document.tabs[0]!.cells,
    };
  });

/** What the sidecar beside `file` holds: its updates, and the revision its last line marks as saved. */
const logOf = (file: string) => {
  const text = NodeFS.readFileSync(sheetSidecarPath(file), "utf8");
  const entries = parseSheetSidecar(text)?.entries ?? [];
  const last = entries.at(-1);
  return {
    text,
    updates: entries.filter((entry) => "update" in entry).length,
    marked: last !== undefined && "saved" in last ? last.saved : null,
  };
};

const at = (name: string) => {
  const match = /^([A-Z])(\d+)$/.exec(name)!;
  return { col: match[1]!.charCodeAt(0) - 65, row: Number(match[2]) - 1 };
};
const put = (name: string, value: string | number) => (document: SheetDocument) =>
  setCells(document, 0, [[at(name), value]]);

it.layer(layerTest, { excludeTestServices: true })("DocumentSession", (it) => {
  describe("windows", () => {
    it.effect("opens with the whole sheet and writes nothing until something merges", () =>
      Effect.gen(function* () {
        const { target, cwd, read } = yield* project;
        const window = yield* openWindow(target, "window-aaaa");
        expect(window.first.access).toBe("edit");
        expect(window.first.participants).toHaveLength(1);
        expect(readSheetYDoc(window.doc).document).toEqual(BUDGET);
        const sessions = yield* DocumentSession.DocumentSession;
        yield* sessions.settleAll;
        expect(read()).toBe(TEXT);
        expect(
          NodeFS.existsSync(NodePath.join(cwd, ".specweave/artifacts", SHEET_SIDECAR_DIR)),
        ).toBe(false);
      }),
    );

    it.effect("shows one window's edit in the other and saves the merge of both", () =>
      Effect.gen(function* () {
        const { target, read, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const left = yield* openWindow(target, "window-left");
        const right = yield* openWindow(target, "window-right");
        expect(right.first.participants).toHaveLength(2);
        expect((yield* left.nextOf("presence")).participants).toHaveLength(2);

        // Both type before either has heard of the other's edit.
        const fromLeft = left.edit(put("A4", "Travel"));
        const fromRight = right.edit(put("B4", 300));
        expect(
          yield* sessions.update({ ...target, sessionKey: "window-left", update: fromLeft }),
        ).toEqual({
          merged: true,
        });
        expect(
          yield* sessions.update({ ...target, sessionKey: "window-right", update: fromRight }),
        ).toEqual({ merged: true });
        yield* left.nextOf("update");
        yield* left.nextOf("update");
        yield* right.nextOf("update");
        yield* right.nextOf("update");
        expect(left.cells()).toEqual(right.cells());
        expect(left.cells().A4).toBe("Travel");
        expect(left.cells().B4).toBe(300);

        yield* sessions.settleAll;
        const expected = setCells(BUDGET, 0, [
          [at("A4"), "Travel"],
          [at("B4"), 300],
        ]);
        expect(read()).toBe(serializeSheetDocument(expected));
        const log = logOf(file);
        expect(log.updates).toBeGreaterThan(0);
        // The log ends in a mark of the file as it now is: nothing is left to save.
        expect(log.marked).toBe(sheetContentRevision(read()));
      }),
    );

    it.effect("gives two edits of one cell one value, in every window and in the file", () =>
      Effect.gen(function* () {
        const { target, cells } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const left = yield* openWindow(target, "window-left");
        const right = yield* openWindow(target, "window-right");
        const fromLeft = left.edit(put("B2", 1500));
        const fromRight = right.edit(put("B2", 900));
        yield* sessions.update({ ...target, sessionKey: "window-left", update: fromLeft });
        yield* sessions.update({ ...target, sessionKey: "window-right", update: fromRight });
        const seen = [yield* left.nextOf("update"), yield* left.nextOf("update")];
        yield* right.nextOf("update");
        yield* right.nextOf("update");
        expect(left.cells().B2).toBe(right.cells().B2);
        expect([1500, 900]).toContain(left.cells().B2);
        yield* sessions.settleAll;
        expect(cells().B2).toBe(left.cells().B2);
        // Both edits are in the document's activity, each under its own window.
        const activity = seen.map((event) => event.activity!);
        // The second either changed the cell again or lost to the first; which is settled by the merge.
        const secondStands = left.cells().B2 === 900;
        expect(activity.map((entry) => entry.first)).toEqual([
          "Plan!B2",
          secondStands ? "Plan!B2" : undefined,
        ]);
        expect(activity.map((entry) => entry.superseded === true)).toEqual([false, !secondStands]);
        expect(new Set(activity.map((entry) => entry.by.id)).size).toBe(2);
      }),
    );

    it.effect("refuses a view-only window's change on the machine that holds the file", () =>
      Effect.gen(function* () {
        const { target, read } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const editor = yield* openWindow(target, "window-editor");
        const viewer = yield* openWindow(target, "window-viewer", "view");
        expect(viewer.first.access).toBe("view");
        yield* editor.nextOf("presence");

        const refused = yield* viewer.send(put("B2", 1)).pipe(Effect.flip);
        expect(refused).toMatchObject({ _tag: "DocumentSessionError", code: "view_only" });
        // Nothing merged: the editor's next event is its own edit, with the cell as it was.
        yield* editor.send(put("A4", "Kept"));
        const merged = yield* editor.nextOf("update");
        expect(merged.activity?.first).toBe("Plan!A4");
        expect(editor.cells().B2).toBe(1200);
        yield* sessions.settleAll;
        expect(read()).toBe(serializeSheetDocument(setCells(BUDGET, 0, [[at("A4"), "Kept"]])));

        // A window that never opened a session cannot write through someone else's.
        const stranger = yield* sessions
          .update({ ...target, sessionKey: "window-nobody", update: editor.edit(put("B2", 2)) })
          .pipe(Effect.flip);
        expect(stranger).toMatchObject({ code: "not_open" });
      }),
    );

    it.effect("does not merge a change that would leave the sheet invalid", () =>
      Effect.gen(function* () {
        const { target, read } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        const tooLong = yield* window.send(put("A4", "x".repeat(6_000))).pipe(Effect.flip);
        expect(tooLong).toMatchObject({ code: "refused" });
        const garbage = yield* sessions
          .update({ ...target, sessionKey: "window-aaaa", update: "AAECAwQF" })
          .pipe(Effect.flip);
        expect(garbage).toMatchObject({ code: "refused" });
        yield* sessions.settleAll;
        expect(read()).toBe(TEXT);
        // The session still holds the valid sheet for the next window.
        const later = yield* openWindow(target, "window-bbbb");
        expect(readSheetYDoc(later.doc).document).toEqual(BUDGET);
      }),
    );

    it.effect("shows where each window is, and that a window left", () =>
      Effect.gen(function* () {
        const { target } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const left = yield* openWindow(target, "window-left");
        const right = yield* openWindow(target, "window-right");
        yield* left.nextOf("presence");
        const tab = readSheetYDoc(left.doc).tabIds[0]!;
        yield* sessions.presence({
          ...target,
          sessionKey: "window-right",
          place: { tab, cell: "B2", range: "B2:C3" },
        });
        const shown = yield* left.nextOf("presence");
        const other = shown.participants.find((entry) => entry.id === right.first.participantId)!;
        expect(other).toMatchObject({ kind: "window", place: { tab, cell: "B2", range: "B2:C3" } });
        expect(other.color).not.toBe(
          shown.participants.find((entry) => entry.id === left.first.participantId)!.color,
        );
        yield* Fiber.interrupt(right.fiber);
        expect((yield* left.nextOf("presence")).participants).toHaveLength(1);
      }),
    );

    it.effect("saves when the last window leaves, and a later session continues the same log", () =>
      Effect.gen(function* () {
        const { target, cells, file } = yield* project;
        const first = yield* openWindow(target, "window-aaaa");
        yield* first.send(put("A4", "Left behind"));
        yield* Fiber.interrupt(first.fiber);
        expect(cells().A4).toBe("Left behind");
        expect(NodeFS.existsSync(sheetSidecarPath(file))).toBe(true);
        const second = yield* openWindow(target, "window-bbbb");
        expect(second.first.epoch).toBe(first.first.epoch);
        expect(second.cells().A4).toBe("Left behind");
        // The window that was closed still holds its state; it merges into the new session.
        expect(
          applySheetUpdate(
            second.doc,
            sheetUpdateFromBase64(first.edit(put("A5", "Late")))!,
            "remote",
          ),
        ).toBe(true);
      }),
    );
  });

  describe("agents and the file", () => {
    const agentWrite = (
      cwd: string,
      sheetInput: unknown,
      options: { merge?: boolean; expectedRevision?: string; name?: string } = {},
    ) =>
      Effect.gen(function* () {
        const sessions = yield* DocumentSession.DocumentSession;
        return yield* sessions.writeSheet({
          projectId: PROJECT,
          workspaceRoot: cwd,
          sheet: sheetInput,
          name: options.name ?? "budget",
          merge: options.merge ?? true,
          expectedRevision: options.expectedRevision,
          by: { id: "thread-7", label: "Budget review" },
        });
      });

    it.effect("keeps a chart a window added after the agent read the sheet", () =>
      Effect.gen(function* () {
        const { target, cwd, cells } = yield* project;
        const window = yield* openWindow(target, "window-aaaa");
        const chart = (id: string, title: string) => ({
          id,
          type: "bar" as const,
          title,
          labels: "A2:A3",
          values: "B2:B3",
        });
        yield* window.send((document) => ({
          ...document,
          tabs: [{ ...document.tabs[0]!, charts: [chart("chart-window", "By the window")] }],
        }));
        // The agent read the sheet before that chart and sends its own list of charts.
        const result = yield* agentWrite(
          cwd,
          {
            tabs: [
              { name: "Plan", cells: { B4: 300 }, charts: [chart("chart-agent", "By the agent")] },
            ],
          },
          { expectedRevision: sheetContentRevision(TEXT) },
        );
        const saved = Option.getOrThrow(result);
        expect(saved.document.tabs[0]!.charts?.map((entry) => entry.id)).toEqual([
          "chart-window",
          "chart-agent",
        ]);
        expect(cells().B4).toBe(300);
      }),
    );

    it.effect("finds no session through a link to a sheet open under another project", () =>
      Effect.gen(function* () {
        const { target, file, read } = yield* project;
        const fileSystem = yield* FileSystem.FileSystem;
        const window = yield* openWindow(target, "window-aaaa");
        const other = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "studio-document-other-",
        });
        NodeFS.mkdirSync(NodePath.join(other, ".specweave", "artifacts"), { recursive: true });
        NodeFS.symlinkSync(file, NodePath.join(other, RELATIVE));
        // The other project's agent names its own artifact, which is a link to the open sheet.
        const result = yield* agentWrite(other, { tabs: [{ name: "Plan", cells: { B2: 1 } }] });
        expect(Option.isNone(result)).toBe(true);
        expect(read()).toBe(TEXT);
        expect(window.cells().B2).toBe(1200);
      }),
    );

    it.effect("leaves the write to the file writer when no window has the sheet open", () =>
      Effect.gen(function* () {
        const { cwd, read } = yield* project;
        const result = yield* agentWrite(cwd, { tabs: [{ name: "Plan", cells: { B2: 1 } }] });
        expect(Option.isNone(result)).toBe(true);
        expect(read()).toBe(TEXT);
      }),
    );

    it.effect(
      "shows an agent on the tab it added, and gives a reader the open sheet when the file cannot be saved",
      () =>
        Effect.gen(function* () {
          const { target, cwd, file } = yield* project;
          const sessions = yield* DocumentSession.DocumentSession;
          const window = yield* openWindow(target, "window-aaaa");
          yield* agentWrite(
            cwd,
            { tabs: [{ name: "Forecast", cells: { B2: 40 } }] },
            { merge: true },
          );
          const shown = yield* window.nextOf("presence");
          yield* window.nextOf("update");
          const tabs = readSheetYDoc(window.doc);
          const forecast =
            tabs.tabIds[tabs.document.tabs.findIndex((tab) => tab.name === "Forecast")];
          expect(forecast).toBeDefined();
          expect(shown.participants.find((entry) => entry.kind === "agent")?.place).toEqual({
            tab: forecast,
            cell: "B2",
          });

          // A saved file reads as the sheet does: the reader uses the file.
          const name = { workspaceRoot: cwd, name: "budget" };
          expect(Option.isNone(yield* sessions.settle(name))).toBe(true);
          // A file that will not take the next change: the reader gets the sheet the windows see.
          NodeFS.writeFileSync(file, "{ half written");
          yield* window.send(put("A4", "Not in the file"));
          const open = Option.getOrThrow(yield* sessions.settle(name));
          expect(open.document.tabs[0]!.cells.A4).toBe("Not in the file");
          expect(open).toMatchObject({ name: "budget", absolutePath: file });
        }),
    );

    it.effect("merges an agent's write with a window's unsaved edit, and shows the agent", () =>
      Effect.gen(function* () {
        const { target, cwd, read, cells } = yield* project;
        const window = yield* openWindow(target, "window-aaaa");
        // The window's edit has merged but is not in the file yet.
        yield* window.send(put("A4", "Travel"));
        yield* window.nextOf("update");
        const stale = sheetContentRevision(TEXT);

        const result = yield* agentWrite(
          cwd,
          { tabs: [{ name: "Plan", cells: { B4: 300, B2: 1250 } }] },
          { expectedRevision: stale },
        );
        expect(Option.isSome(result)).toBe(true);
        const saved = Option.getOrThrow(result);
        // One file holds both, and the agent is told the revision of exactly that file.
        expect(cells()).toMatchObject({ A4: "Travel", B4: 300, B2: 1250 });
        expect(saved.revision).toBe(sheetContentRevision(read()));
        expect(saved.document.tabs[0]!.cells.A4).toBe("Travel");

        const shown = yield* window.nextOf("presence");
        const agent = shown.participants.find((entry) => entry.kind === "agent")!;
        expect(agent).toMatchObject({ label: "Budget review", place: { cell: "B4" } });
        const merged = yield* window.nextOf("update");
        expect(merged.activity).toMatchObject({
          by: { kind: "agent", label: "Budget review" },
          cells: 2,
        });
        expect(window.cells()).toMatchObject({ A4: "Travel", B4: 300, B2: 1250 });
      }),
    );

    it.effect(
      "resolves a window and an agent writing one cell to one value, both in the activity",
      () =>
        Effect.gen(function* () {
          const { target, cwd, cells } = yield* project;
          const window = yield* openWindow(target, "window-aaaa");
          const pending = window.edit(put("B2", 1500));
          yield* agentWrite(cwd, { tabs: [{ name: "Plan", cells: { B2: 900 } }] });
          const sessions = yield* DocumentSession.DocumentSession;
          yield* sessions.update({ ...target, sessionKey: "window-aaaa", update: pending });
          const first = yield* window.nextOf("update");
          const second = yield* window.nextOf("update");
          expect([first.activity?.by.kind, second.activity?.by.kind]).toEqual(["agent", "window"]);
          yield* sessions.settleAll;
          expect([1500, 900]).toContain(cells().B2);
          expect(window.cells().B2).toBe(cells().B2);
          // Whichever value stands, the window's edit is on record: as a change, or as one that lost.
          expect(second.activity?.superseded === true).toBe(cells().B2 === 900);
          expect(second.activity?.cells).toBe(cells().B2 === 900 ? 0 : 1);
          // A later window is told of both.
          const later = yield* openWindow(target, "window-bbbb");
          expect(later.first.activity.map((entry) => entry.by.kind)).toEqual(["agent", "window"]);
        }),
    );

    it.effect("keeps a whole-sheet replace over unread edits a conflict", () =>
      Effect.gen(function* () {
        const { target, cwd, cells } = yield* project;
        const window = yield* openWindow(target, "window-aaaa");
        yield* window.send(put("A4", "Unread"));
        const refused = yield* agentWrite(
          cwd,
          { title: "Budget", tabs: [{ name: "Plan", cells: { A1: "Replaced" } }] },
          { merge: false, expectedRevision: sheetContentRevision(TEXT) },
        ).pipe(Effect.flip);
        expect(refused.detail).toContain("Conflict:");
        expect(cells().A4).toBe("Unread");
        // With the current revision the replace goes through, as one change the window sees.
        const current = sheetContentRevision(
          NodeFS.readFileSync(NodePath.join(cwd, RELATIVE), "utf8"),
        );
        const replaced = yield* agentWrite(
          cwd,
          { title: "Budget", tabs: [{ name: "Plan", cells: { A1: "Replaced" } }] },
          { merge: false, expectedRevision: current },
        );
        expect(Option.isSome(replaced)).toBe(true);
        expect(cells()).toEqual({ A1: "Replaced" });
        const invalid = yield* agentWrite(cwd, {
          tabs: [{ name: "Plan", cells: { "not a cell": 1 } }],
        }).pipe(Effect.flip);
        expect(invalid.code).toBe("invalid");
      }),
    );

    it.effect("takes in a change made to the file from outside and keeps unsaved edits", () =>
      Effect.gen(function* () {
        const { target, file, cells } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        yield* window.send(put("A4", "Unsaved"));
        yield* window.nextOf("update");
        // Another tool rewrites the file meanwhile.
        NodeFS.writeFileSync(file, serializeSheetDocument(setCells(BUDGET, 0, [[at("B2"), 2000]])));
        yield* sessions.reconcile(target);
        const merged = yield* window.nextOf("update");
        expect(merged.activity?.by.kind).toBe("file");
        expect(window.cells()).toMatchObject({ B2: 2000, A4: "Unsaved" });
        expect(cells()).toMatchObject({ B2: 2000, A4: "Unsaved" });
      }),
    );

    it.effect("ends the session and removes the sidecar when the document is deleted", () =>
      Effect.gen(function* () {
        const { target, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        yield* window.send(put("A4", "Saved"));
        yield* sessions.settleAll;
        expect(NodeFS.existsSync(sheetSidecarPath(file))).toBe(true);
        NodeFS.unlinkSync(file);
        yield* sessions.reconcile(target);
        expect((yield* window.nextOf("closed")).reason).toContain("deleted");
        expect(NodeFS.existsSync(NodePath.dirname(sheetSidecarPath(file)))).toBe(false);
        const reopened = yield* sessions
          .open({ ...target, sessionKey: "window-bbbb", access: "edit" })
          .pipe(Stream.runCollect, Effect.flip);
        expect(reopened).toMatchObject({ code: "not_found" });
      }),
    );

    it.effect("opens only sheets inside the project folder", () =>
      Effect.gen(function* () {
        const { cwd, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const open = (relativePath: string) =>
          sessions
            .open({ cwd, relativePath, sessionKey: "window-aaaa", access: "edit" })
            .pipe(Stream.runCollect, Effect.flip);
        expect(yield* open("README.md")).toMatchObject({ code: "not_found" });
        expect(yield* open(file)).toMatchObject({ code: "not_found" });
        expect(yield* open("../outside.sheet.json")).toMatchObject({ code: "not_found" });
      }),
    );

    it.effect("tells the windows when the file cannot be saved, and saves once it can", () =>
      Effect.gen(function* () {
        const { target, file, cells } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        // Broken by hand: it cannot be merged with, so it is not written over.
        NodeFS.writeFileSync(file, "{ half written");
        expect(yield* window.send(put("A4", "Kept"))).toEqual({ merged: true });
        yield* sessions.settleAll;
        const failed = yield* window.nextOf("save");
        expect(failed.saved).toBe(false);
        expect(failed.detail).toContain("could not be saved");
        expect(NodeFS.readFileSync(file, "utf8")).toBe("{ half written");
        // A window that joins now is told as well.
        const later = yield* openWindow(target, "window-bbbb");
        expect(later.first.unsaved).toBe(failed.detail);
        expect(later.cells().A4).toBe("Kept");
        // Put right, the file takes the edit and the windows are told.
        NodeFS.writeFileSync(file, TEXT);
        yield* sessions.settleAll;
        expect((yield* window.nextOf("save")).saved).toBe(true);
        expect(cells().A4).toBe("Kept");
      }),
    );

    it.effect("keeps edits the file never got and saves them when the sheet is next opened", () =>
      Effect.gen(function* () {
        const { target, file, cells } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        NodeFS.writeFileSync(file, "{ half written");
        yield* window.send(put("A4", "Kept"));
        yield* sessions.settleAll;
        expect((yield* window.nextOf("save")).saved).toBe(false);
        // The last window closes with the file still unwritable.
        yield* Fiber.interrupt(window.fiber);
        // The log has the edit below a mark of the file as it last was.
        expect(logOf(file).marked).toBeNull();
        // The file is back as it was: nothing else changed it, so the kept edits stand.
        NodeFS.writeFileSync(file, TEXT);
        const again = yield* openWindow(target, "window-bbbb");
        expect(again.cells().A4).toBe("Kept");
        yield* sessions.settleAll;
        expect(cells().A4).toBe("Kept");
        expect(logOf(file).marked).toBe(sheetContentRevision(NodeFS.readFileSync(file, "utf8")));
      }),
    );

    it.effect("keeps both sides when the file was changed while edits waited to be saved", () =>
      Effect.gen(function* () {
        const { target, file, cells } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        NodeFS.writeFileSync(file, "{ half written");
        yield* window.send(put("A4", "Kept"));
        yield* window.send(put("B2", 1500));
        yield* sessions.settleAll;
        yield* Fiber.interrupt(window.fiber);
        // Another tool changes other cells, and one of the same ones, before the sheet is opened again.
        NodeFS.writeFileSync(
          file,
          serializeSheetDocument(
            setCells(BUDGET, 0, [
              [at("A5"), "Written elsewhere"],
              [at("B2"), 1300],
            ]),
          ),
        );
        const again = yield* openWindow(target, "window-bbbb");
        expect(again.cells().A5).toBe("Written elsewhere");
        expect(again.cells().A4).toBe("Kept");
        // The same cell changed on both sides: the file's value stands.
        expect(again.cells().B2).toBe(1300);
        yield* sessions.settleAll;
        expect(cells()).toMatchObject({ A4: "Kept", A5: "Written elsewhere", B2: 1300 });
      }),
    );

    it.effect(
      "has a change in the log before the window is answered, for a server that stops",
      () =>
        Effect.gen(function* () {
          const { target, file, read } = yield* project;
          const window = yield* openWindow(target, "window-aaaa");
          expect(yield* window.send(put("A4", "Typed"))).toEqual({ merged: true });
          // No save has run: the file is as it was, and the log already holds the edit below its mark.
          expect(read()).toBe(TEXT);
          const log = logOf(file);
          expect(log.updates).toBe(2);
          expect(log.marked).toBeNull();
          // What a server starting again makes of the two: the edit stands and is saved.
          const loaded = loadSheet(BUDGET, log.text, "new-epoch", sheetContentRevision(TEXT));
          expect(loaded.unsaved).toBe(true);
          expect(loaded.epoch).toBe(window.first.epoch);
          expect(readSheetYDoc(loaded.doc).document.tabs[0]!.cells.A4).toBe("Typed");
        }),
    );

    it.effect("saves kept edits only once a window that may edit opens the sheet", () =>
      Effect.gen(function* () {
        const { target, file, read, cells } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        NodeFS.writeFileSync(file, "{ half written");
        yield* window.send(put("A4", "Kept"));
        yield* sessions.settleAll;
        yield* Fiber.interrupt(window.fiber);
        NodeFS.writeFileSync(file, TEXT);
        const before = logOf(file).text;

        const viewer = yield* openWindow(target, "window-viewer", "view");
        expect(viewer.cells().A4).toBe("Kept");
        yield* sessions.settleAll;
        yield* Fiber.interrupt(viewer.fiber);
        // A window that may only view changed nothing: not the file, not the log.
        expect(read()).toBe(TEXT);
        expect(logOf(file).text).toBe(before);

        const editor = yield* openWindow(target, "window-editor");
        expect(editor.cells().A4).toBe("Kept");
        yield* sessions.settleAll;
        expect(cells().A4).toBe("Kept");
      }),
    );

    it.effect("leaves a file alone when a change that changes nothing arrives", () =>
      Effect.gen(function* () {
        const { target, cwd, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        // Another tool's layout of the same sheet: one line.
        const compact = JSON.stringify(BUDGET);
        NodeFS.writeFileSync(file, compact);
        const window = yield* openWindow(target, "window-aaaa");
        // An update with nothing in it.
        expect(
          yield* sessions.update({ ...target, sessionKey: "window-aaaa", update: "AAA=" }),
        ).toEqual({ merged: true });
        yield* sessions.settleAll;
        yield* Fiber.interrupt(window.fiber);
        expect(NodeFS.readFileSync(file, "utf8")).toBe(compact);
        expect(
          NodeFS.existsSync(NodePath.join(cwd, ".specweave/artifacts", SHEET_SIDECAR_DIR)),
        ).toBe(false);
      }),
    );

    it.effect("writes unsaved edits to a sheet that was renamed in its folder", () =>
      Effect.gen(function* () {
        const { target, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        yield* window.send(put("A4", "Before the rename"));
        const renamed = NodePath.join(NodePath.dirname(file), "plan.sheet.json");
        NodeFS.renameSync(file, renamed);
        yield* sessions.reconcile(target);
        expect((yield* window.nextOf("closed")).reason).toContain("moved");
        expect(sheet(JSON.parse(NodeFS.readFileSync(renamed, "utf8"))).tabs[0]!.cells.A4).toBe(
          "Before the rename",
        );
        expect(NodeFS.existsSync(sheetSidecarPath(file))).toBe(false);
      }),
    );

    it.effect("adds to a log whose last line was cut off without losing what it held", () =>
      Effect.gen(function* () {
        const { target, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        yield* window.send(put("A4", "First"));
        // The server stopped in the middle of a line.
        NodeFS.appendFileSync(sheetSidecarPath(file), '{"u":"AAEC');
        yield* window.send(put("A5", "Second"));
        const log = logOf(file);
        expect(log.updates).toBe(3);
        const loaded = loadSheet(BUDGET, log.text, "new-epoch", sheetContentRevision(TEXT));
        expect(readSheetYDoc(loaded.doc).document.tabs[0]!.cells).toMatchObject({
          A4: "First",
          A5: "Second",
        });
        yield* sessions.settleAll;
      }),
    );

    it.effect("writes the file before answering when the log cannot be written", () =>
      Effect.gen(function* () {
        const { target, file, cells } = yield* project;
        // Something that is not a folder where the sidecar folder would go.
        NodeFS.writeFileSync(
          NodePath.join(NodePath.dirname(file), SHEET_SIDECAR_DIR),
          "in the way",
        );
        const window = yield* openWindow(target, "window-aaaa");
        expect(yield* window.send(put("A4", "Straight to the file"))).toEqual({ merged: true });
        // No save was waited for: the answer came after the file had the edit.
        expect(cells().A4).toBe("Straight to the file");
      }),
    );

    it.effect(
      "keeps a log short, and the edits in it told apart, while the file cannot be saved",
      () =>
        Effect.gen(function* () {
          const { target, file, cells } = yield* project;
          const sessions = yield* DocumentSession.DocumentSession;
          const window = yield* openWindow(target, "window-aaaa");
          NodeFS.writeFileSync(file, "{ half written");
          for (let count = 0; count < SHEET_SIDECAR_MAX_LINES + 20; count += 1) {
            yield* window.send(put("A4", `Edit ${count}`));
          }
          const log = logOf(file);
          expect(log.updates).toBeLessThan(SHEET_SIDECAR_MAX_LINES);
          expect(log.marked).toBeNull();
          yield* Fiber.interrupt(window.fiber);
          // Opened again beside the file as it was: the last edit is still one to save.
          NodeFS.writeFileSync(file, TEXT);
          const again = yield* openWindow(target, "window-bbbb");
          expect(again.cells().A4).toBe(`Edit ${SHEET_SIDECAR_MAX_LINES + 19}`);
          yield* sessions.settleAll;
          expect(cells().A4).toBe(`Edit ${SHEET_SIDECAR_MAX_LINES + 19}`);
        }),
    );

    it.effect("leaves the log where it is when a window that may only view sees the sheet go", () =>
      Effect.gen(function* () {
        const { target, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const editor = yield* openWindow(target, "window-aaaa");
        yield* editor.send(put("A4", "Saved"));
        yield* sessions.settleAll;
        yield* Fiber.interrupt(editor.fiber);
        const viewer = yield* openWindow(target, "window-viewer", "view");
        NodeFS.renameSync(file, `${file}.moved`);
        yield* sessions.reconcile(target);
        yield* viewer.nextOf("closed");
        expect(NodeFS.existsSync(sheetSidecarPath(file))).toBe(true);
      }),
    );

    it.effect("moves the log with a renamed sheet that changed before the edits reached it", () =>
      Effect.gen(function* () {
        const { target, file, cwd } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        yield* window.send(put("A4", "Before the rename"));
        const renamed = NodePath.join(NodePath.dirname(file), "plan.sheet.json");
        NodeFS.renameSync(file, renamed);
        // Changed under its new name, in place, before the session looks.
        NodeFS.writeFileSync(
          renamed,
          serializeSheetDocument(put("A5", "Written elsewhere")(BUDGET)),
        );
        yield* sessions.reconcile(target);
        yield* window.nextOf("closed");
        expect(NodeFS.existsSync(sheetSidecarPath(file))).toBe(false);
        expect(NodeFS.existsSync(sheetSidecarPath(renamed))).toBe(true);
        // Opened under its new name: both the kept edit and the file's change are there, and saved.
        const again = yield* openWindow(
          { cwd, relativePath: ".specweave/artifacts/plan.sheet.json" },
          "window-bbbb",
        );
        expect(again.cells()).toMatchObject({ A4: "Before the rename", A5: "Written elsewhere" });
        yield* sessions.settleAll;
        expect(
          sheet(JSON.parse(NodeFS.readFileSync(renamed, "utf8"))).tabs[0]!.cells,
        ).toMatchObject({ A4: "Before the rename", A5: "Written elsewhere" });
      }),
    );

    it.effect("opens a sheet saved past the size other files are read to", () =>
      Effect.gen(function* () {
        const { target, file } = yield* project;
        const filler = "x".repeat(4_000);
        const large = setCells(
          BUDGET,
          0,
          Array.from({ length: 300 }, (_, row) => [{ col: 3, row }, `${row}${filler}`] as const),
        );
        const text = serializeSheetDocument(large);
        expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024);
        NodeFS.writeFileSync(file, text);
        const window = yield* openWindow(target, "window-aaaa");
        expect(Object.keys(window.cells())).toHaveLength(Object.keys(large.tabs[0]!.cells).length);
      }),
    );

    it.effect("writes nothing for a view-only window when the file changes outside", () =>
      Effect.gen(function* () {
        const { target, cwd, file } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const viewer = yield* openWindow(target, "window-viewer", "view");
        // Another tool's layout: one line, with one cell changed.
        const outside = JSON.stringify(put("A4", "From outside")(BUDGET));
        NodeFS.writeFileSync(file, outside);
        yield* sessions.reconcile(target);
        yield* viewer.nextOf("update");
        expect(viewer.cells().A4).toBe("From outside");
        yield* sessions.settleAll;
        yield* Fiber.interrupt(viewer.fiber);
        expect(NodeFS.readFileSync(file, "utf8")).toBe(outside);
        expect(
          NodeFS.existsSync(NodePath.join(cwd, ".specweave/artifacts", SHEET_SIDECAR_DIR)),
        ).toBe(false);
      }),
    );

    it.effect("removes the merge state of a sheet that was deleted while closed", () =>
      Effect.gen(function* () {
        const { target, cwd, file } = yield* project;
        const folder = NodePath.join(cwd, ".specweave/artifacts", SHEET_SIDECAR_DIR);
        NodeFS.mkdirSync(folder);
        NodeFS.writeFileSync(NodePath.join(folder, ".gitignore"), "*\n");
        const orphan = NodePath.join(folder, "gone.sheet.json.ylog");
        NodeFS.writeFileSync(orphan, '{"v":1,"epoch":"old"}\n');
        const window = yield* openWindow(target, "window-aaaa");
        expect(NodeFS.existsSync(orphan)).toBe(false);
        expect(NodeFS.existsSync(folder)).toBe(false);
        // This sheet's own state is written as before.
        yield* window.send(put("A4", "Saved"));
        yield* (yield* DocumentSession.DocumentSession).settleAll;
        expect(NodeFS.existsSync(sheetSidecarPath(file))).toBe(true);
      }),
    );

    it.effect("asks for a change again when it arrives before the one it follows", () =>
      Effect.gen(function* () {
        const { target, cells } = yield* project;
        const sessions = yield* DocumentSession.DocumentSession;
        const window = yield* openWindow(target, "window-aaaa");
        const first = window.edit(put("A4", "First"));
        const second = window.edit(put("A4", "Second"));
        const early = yield* sessions
          .update({ ...target, sessionKey: "window-aaaa", update: second })
          .pipe(Effect.flip);
        expect(early).toMatchObject({ code: "failed" });
        yield* sessions.update({ ...target, sessionKey: "window-aaaa", update: first });
        yield* sessions.update({ ...target, sessionKey: "window-aaaa", update: second });
        yield* sessions.settleAll;
        expect(cells().A4).toBe("Second");
      }),
    );
  });
});

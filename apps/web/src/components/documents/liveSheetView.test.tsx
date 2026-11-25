import { parseSheetDocument, setCells } from "@specweave-studio/shared/officeSheet";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { type SheetLiveBinding, SheetView } from "../office/SheetView";

const parsed = parseSheetDocument(
  JSON.stringify({
    v: 1,
    kind: "sheet",
    title: "Budget",
    tabs: [
      { name: "Plan", cells: { A1: "Item", B1: 1 } },
      { name: "Notes", cells: { A1: "Second" } },
    ],
  }),
);
if (!parsed.ok) throw new Error(parsed.error);
const DOCUMENT = parsed.document;

function binding(patch: Partial<SheetLiveBinding> = {}): SheetLiveBinding & { places: unknown[] } {
  const places: unknown[] = [];
  return {
    document: DOCUMENT,
    tabIds: ["t1", "t2"],
    editable: true,
    commit: () => true,
    undo: () => undefined,
    redo: () => undefined,
    canUndo: false,
    canRedo: false,
    problem: null,
    clearProblem: () => undefined,
    setPlace: (place) => {
      places.push(place);
    },
    others: [],
    places,
    ...patch,
  };
}

let renderer: ReactTestRenderer | null = null;
function render(live: SheetLiveBinding): ReactTestRenderer {
  act(() => {
    // The text is deliberately not the live sheet: live, the session is what shows.
    renderer = create(<SheetView text="not a sheet" mode="light" live={live} />);
  });
  return renderer!;
}
const cell = (root: ReactTestInstance, name: string) => root.findByProps({ "data-cell": name });
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("a sheet edited live", () => {
  it("shows the session's sheet and merges an edit instead of saving a revision", async () => {
    const commits: unknown[] = [];
    const live = binding({
      commit: (next) => {
        commits.push(next);
        return true;
      },
    });
    const inst = render(live);
    expect(textOf(cell(inst.root, "A1"))).toBe("Item");

    act(() => cell(inst.root, "A1").props.onMouseDown({ shiftKey: false }));
    await act(async () => {
      inst.root.findByProps({ "data-sheet-insert-chart": true }).props.onClick();
    });
    await act(async () => {
      inst.root.findByType("form").props.onSubmit({ preventDefault: () => {} });
    });
    expect(commits).toHaveLength(1);
  });

  it("never shows the Conflict banner when the sheet changes under an edit", () => {
    const inst = render(binding());
    act(() => cell(inst.root, "A1").props.onMouseDown({ shiftKey: false }));
    const changed = setCells(DOCUMENT, 0, [[{ col: 1, row: 0 }, 42]]);
    act(() => {
      inst.update(
        <SheetView text="not a sheet" mode="light" live={binding({ document: changed })} />,
      );
    });
    expect(textOf(cell(inst.root, "B1"))).toBe("42");
    expect(inst.root.findAllByProps({ "data-sheet-conflict": true })).toHaveLength(0);
  });

  it("flags the cell someone else is on, and tints their selection", () => {
    const inst = render(
      binding({
        others: [
          { id: "w2", name: "Window 2", color: 1, tab: "t1", cell: "B2", range: "B2:C3" },
          { id: "a1", name: "Planner", color: 2, tab: "t2", cell: "A1" },
        ],
      }),
    );
    expect(cell(inst.root, "B2").props["data-presence"]).toBe("focus");
    expect(cell(inst.root, "B2").props["data-presence-color"]).toBe(1);
    expect(cell(inst.root, "C3").props["data-presence"]).toBe("range");
    expect(inst.root.findAllByProps({ "data-presence-flag": "Window 2" })).toHaveLength(1);
    // Someone on another tab is not drawn on this one.
    expect(inst.root.findAllByProps({ "data-presence-flag": "Planner" })).toHaveLength(0);
    expect(cell(inst.root, "A1").props["data-presence"]).toBeUndefined();
  });

  it("tells the others where this window is", () => {
    const live = binding();
    const inst = render(live);
    act(() => cell(inst.root, "A1").props.onMouseDown({ shiftKey: false }));
    act(() => cell(inst.root, "B2").props.onMouseDown({ shiftKey: true }));
    expect(live.places.at(-1)).toEqual({ tab: "t1", cell: "B2", range: "A1:B2" });
  });

  it("offers a view-only window no way to edit", () => {
    const commits: unknown[] = [];
    const inst = render(
      binding({
        editable: false,
        commit: (next) => {
          commits.push(next);
          return false;
        },
      }),
    );
    expect(inst.root.findAllByProps({ "data-sheet-insert-chart": true })).toHaveLength(0);
    act(() => cell(inst.root, "A1").props.onMouseDown({ shiftKey: false }));
    act(() => cell(inst.root, "A1").props.onDoubleClick());
    expect(inst.root.findAllByProps({ "data-sheet-editor": true })).toHaveLength(0);
    expect(commits).toHaveLength(0);
  });

  it("shows why an edit was not taken", () => {
    const inst = render(binding({ problem: "This window can only view the sheet." }));
    expect(textOf(inst.root.findByProps({ role: "alert" }))).toBe(
      "This window can only view the sheet.",
    );
  });
});

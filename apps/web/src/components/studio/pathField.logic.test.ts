import { describe, expect, it } from "vite-plus/test";
import {
  addFolderKey,
  cleanPastedPath,
  completeTypedPath,
  folderChoiceState,
  pathKindProblem,
  typedDirectory,
  typedLeaf,
  withRecentFolder,
} from "./pathField.logic";

const mac = { windows: false, ignoresCase: true };
const linux = { windows: false, ignoresCase: false };
const win = { windows: true, ignoresCase: true };

describe("cleanPastedPath", () => {
  it("takes what people copy on macOS and Linux", () => {
    expect(cleanPastedPath('"/Users/you/My Project"\n', mac)).toBe("/Users/you/My Project");
    expect(cleanPastedPath("'/Users/you/app'", mac)).toBe("/Users/you/app");
    expect(cleanPastedPath("/Users/you/My\\ Project\\ \\(old\\)", mac)).toBe(
      "/Users/you/My Project (old)",
    );
    expect(cleanPastedPath("file:///Users/you/My%20Project", mac)).toBe("/Users/you/My Project");
    expect(cleanPastedPath("  ~/code/app  \r\n", linux)).toBe("~/code/app");
    expect(cleanPastedPath("\n/srv/app\n/srv/other\n", linux)).toBe("/srv/app");
  });

  it("keeps backslashes as separators for a Windows machine", () => {
    expect(cleanPastedPath('"C:\\Users\\you\\My Project"', win)).toBe("C:\\Users\\you\\My Project");
    expect(cleanPastedPath("file:///C:/Users/you/app", win)).toBe("C:\\Users\\you\\app");
    expect(cleanPastedPath("file://nas/share/app", win)).toBe("\\\\nas\\share\\app");
    expect(cleanPastedPath("\\\\nas\\share\\app", win)).toBe("\\\\nas\\share\\app");
  });
});

describe("pathKindProblem", () => {
  it("refuses a path of the wrong kind for the machine, with the reason", () => {
    expect(pathKindProblem("C:\\Projects\\app", mac, "MacBook")).toContain(
      "MacBook is not a Windows machine",
    );
    expect(pathKindProblem("\\\\nas\\share", linux, null)).toContain("This machine");
    expect(pathKindProblem("/home/you/app", win, "Office PC")).toContain(
      "Office PC is a Windows machine",
    );
  });

  it("lets the right kind through", () => {
    expect(pathKindProblem("~/app", win, null)).toBeNull();
    expect(pathKindProblem("C:\\app", win, null)).toBeNull();
    expect(pathKindProblem("//nas/share", win, null)).toBeNull();
    expect(pathKindProblem("/home/you", linux, null)).toBeNull();
    expect(pathKindProblem("./app", mac, null)).toBeNull();
  });
});

describe("typed path parts", () => {
  it("splits at the last separator of the machine", () => {
    expect(typedLeaf("/a/b/cod", false)).toBe("cod");
    expect(typedDirectory("/a/b/cod", false)).toBe("/a/b/");
    expect(typedLeaf("C:\\a\\cod", true)).toBe("cod");
    expect(typedDirectory("C:\\a\\cod", true)).toBe("C:\\a\\");
    // A backslash is part of a name on macOS and Linux.
    expect(typedLeaf("/a/we\\ird", false)).toBe("we\\ird");
  });
});

describe("completeTypedPath", () => {
  const names = ["Desktop", "Documents", "Downloads", ".config", "projects"];

  it("adds the rest of the first matching name as a selection", () => {
    expect(completeTypedPath({ typed: "~/Doc", previous: "~/Do", names, machine: mac })).toEqual({
      value: "~/Documents",
      selectionStart: 5,
    });
  });

  it("keeps the person's letters and ignores case only where the machine does", () => {
    expect(completeTypedPath({ typed: "~/pro", previous: "~/pr", names, machine: mac })).toEqual({
      value: "~/projects",
      selectionStart: 5,
    });
    expect(completeTypedPath({ typed: "~/Pro", previous: "~/Pr", names, machine: mac })).toEqual({
      value: "~/Projects",
      selectionStart: 5,
    });
    expect(
      completeTypedPath({ typed: "~/Pro", previous: "~/Pr", names, machine: linux }),
    ).toBeNull();
  });

  it("leaves a deletion, an edit in the middle, a full name and no match alone", () => {
    expect(completeTypedPath({ typed: "~/Do", previous: "~/Doc", names, machine: mac })).toBeNull();
    expect(completeTypedPath({ typed: "~/xDo", previous: "~/Do", names, machine: mac })).toBeNull();
    expect(
      completeTypedPath({ typed: "~/Desktop", previous: "~/Deskto", names, machine: mac }),
    ).toBeNull();
    expect(completeTypedPath({ typed: "~/zz", previous: "~/z", names, machine: mac })).toBeNull();
    expect(completeTypedPath({ typed: "~/", previous: "~", names, machine: mac })).toBeNull();
  });

  it("completes a hidden folder only after its dot", () => {
    expect(completeTypedPath({ typed: "~/c", previous: "~/", names, machine: mac })).toBeNull();
    expect(completeTypedPath({ typed: "~/.c", previous: "~/.", names, machine: mac })).toEqual({
      value: "~/.config",
      selectionStart: 4,
    });
  });
});

describe("addFolderKey", () => {
  const rows = [{ fullPath: "/Users/you/a" }, { fullPath: "/Users/you/b" }];
  const base = {
    modified: false,
    value: "/Users/you/",
    selectionStart: 11,
    selectionEnd: 11,
    highlighted: null,
    rows,
    openable: null,
    machine: mac,
  };

  it("Enter always confirms, whatever is highlighted and with any modifier", () => {
    expect(addFolderKey({ ...base, key: "Enter" })).toEqual({ kind: "submit" });
    expect(addFolderKey({ ...base, key: "Enter", highlighted: 1 })).toEqual({ kind: "submit" });
    expect(addFolderKey({ ...base, key: "Enter", modified: true })).toEqual({ kind: "submit" });
  });

  it("arrows walk the list and stop at its ends", () => {
    expect(addFolderKey({ ...base, key: "ArrowDown" })).toEqual({ kind: "highlight", index: 0 });
    expect(addFolderKey({ ...base, key: "ArrowUp" })).toEqual({ kind: "highlight", index: 1 });
    expect(addFolderKey({ ...base, key: "ArrowDown", highlighted: 1 })).toEqual({
      kind: "highlight",
      index: 1,
    });
    expect(addFolderKey({ ...base, key: "ArrowUp", highlighted: 0 })).toEqual({
      kind: "highlight",
      index: 0,
    });
    expect(addFolderKey({ ...base, key: "ArrowDown", rows: [] })).toBeNull();
  });

  it("Tab, or Right at the end, opens the folder the bar names", () => {
    const named = { ...base, value: "/Users/you/a", selectionStart: 12, selectionEnd: 12 };
    expect(addFolderKey({ ...named, key: "Tab", openable: "/Users/you/a" })).toEqual({
      kind: "open",
      path: "/Users/you/a",
    });
    expect(addFolderKey({ ...named, key: "ArrowRight", openable: "/Users/you/a" })).toEqual({
      kind: "open",
      path: "/Users/you/a",
    });
    // Right in the middle of the text moves the caret; Tab with nothing to open moves focus.
    expect(
      addFolderKey({
        ...named,
        key: "ArrowRight",
        selectionStart: 3,
        selectionEnd: 3,
        openable: "/x",
      }),
    ).toBeNull();
    expect(addFolderKey({ ...named, key: "Tab" })).toBeNull();
    // Right over a completion accepts it first.
    expect(
      addFolderKey({ ...named, key: "ArrowRight", selectionStart: 11, openable: "/Users/you/a" }),
    ).toBeNull();
  });

  it("Backspace on a separator and Left from a highlighted row go up", () => {
    expect(addFolderKey({ ...base, key: "Backspace" })).toEqual({
      kind: "parent",
      path: "/Users",
    });
    expect(
      addFolderKey({ ...base, key: "ArrowLeft", value: "/Users/you/a", highlighted: 0 }),
    ).toEqual({ kind: "parent", path: "/Users" });
    expect(addFolderKey({ ...base, key: "ArrowLeft" })).toBeNull();
    expect(
      addFolderKey({ ...base, key: "Backspace", value: "~/", selectionStart: 2, selectionEnd: 2 }),
    ).toBeNull();
    expect(
      addFolderKey({ ...base, key: "Backspace", value: "/", selectionStart: 1, selectionEnd: 1 }),
    ).toBeNull();
    expect(
      addFolderKey({
        ...base,
        key: "Backspace",
        value: "/Users/yo",
        selectionStart: 9,
        selectionEnd: 9,
      }),
    ).toBeNull();
    // A network share is a root: Backspace edits its text instead of leaving it.
    const share = "\\\\wsl$\\Ubuntu\\";
    expect(
      addFolderKey({
        ...base,
        key: "Backspace",
        value: share,
        selectionStart: share.length,
        selectionEnd: share.length,
        machine: { windows: true },
      }),
    ).toBeNull();
    const inside = `${share}home\\`;
    expect(
      addFolderKey({
        ...base,
        key: "Backspace",
        value: inside,
        selectionStart: inside.length,
        selectionEnd: inside.length,
        machine: { windows: true },
      }),
    ).toEqual({ kind: "parent", path: "\\\\wsl$\\Ubuntu" });
  });
});

describe("recent folders", () => {
  it("puts the newest first, once, and keeps five", () => {
    const stored = ["/a", "/b", "/c", "/d", "/e"];
    expect(withRecentFolder(stored, "/c/")).toEqual(["/c/", "/a", "/b", "/d", "/e"]);
    expect(withRecentFolder(stored, "/f")).toEqual(["/f", "/a", "/b", "/c", "/d"]);
    expect(withRecentFolder(stored, "  ")).toEqual(stored);
  });
});

describe("folderChoiceState", () => {
  const base = {
    path: "/Users/you/notes",
    machineLabel: "Work Mac",
    problem: null,
    pending: false,
    found: "exists" as const,
    git: false,
    childCount: 3,
    projects: [{ workspaceRoot: "/Users/you/site", title: "Site" }],
    allowed: true,
    notAllowedReason: null,
    error: null,
  };

  it("names the action after the folder", () => {
    expect(folderChoiceState(base)).toMatchObject({ action: "add", label: "Add notes" });
    expect(folderChoiceState({ ...base, git: true }).status).toContain("Git repository");
  });

  it("says that a folder with no subfolders is itself the project", () => {
    expect(folderChoiceState({ ...base, childCount: 0 }).status).toBe(
      "No folders inside. notes itself becomes the project on Work Mac.",
    );
  });

  it("creates a folder that is not there", () => {
    expect(folderChoiceState({ ...base, found: "missing" })).toMatchObject({
      action: "create",
      label: "Create and add",
    });
  });

  it("opens a folder that is already a project", () => {
    expect(folderChoiceState({ ...base, path: "/Users/you/site/" })).toMatchObject({
      action: "open",
      label: "Open project",
      status: "site is already the project Site on Work Mac. Enter opens it.",
    });
  });

  it("has nothing to confirm for an empty bar, a wrong path, an unreadable folder or no permission", () => {
    expect(folderChoiceState({ ...base, path: " " }).action).toBe("none");
    expect(folderChoiceState({ ...base, problem: "Wrong kind." })).toMatchObject({
      action: "none",
      status: "Wrong kind.",
      tone: "problem",
    });
    expect(folderChoiceState({ ...base, found: "unreadable" }).action).toBe("none");
    expect(folderChoiceState({ ...base, allowed: false }).status).toBe(
      "This connection cannot add projects.",
    );
    // A listing that failed or was refused says nothing about the folder: Enter still adds it.
    expect(
      folderChoiceState({ ...base, found: "unknown", error: "No filesystem permission" }),
    ).toMatchObject({
      action: "add",
      label: "Add notes",
      status: "No filesystem permission. Enter still adds notes on Work Mac.",
      tone: "plain",
    });
  });

  it("can be confirmed while the machine is still answering", () => {
    expect(folderChoiceState({ ...base, pending: true, found: "unknown" })).toMatchObject({
      action: "add",
      status: "Checking notes on Work Mac…",
    });
  });
});

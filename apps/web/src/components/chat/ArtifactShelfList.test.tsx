import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));
// The real tooltip portals into a document; here it shows where it is.
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: { open?: boolean; children: unknown }) =>
    props.open ? <div data-tooltip-open="true">{props.children as never}</div> : null,
  TooltipPopup: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));

import { shelfEntries, type ShelfFileCheck, type ShelfInput } from "~/artifactShelf";
import type { NativeArtifactReference } from "~/nativeArtifacts";
import { nativeArtifact, type ThreadArtifact } from "~/threadArtifacts";

import { ArtifactShelfList } from "./ArtifactShelfList";

// Synthetic only: no real page, account or machine.
const NOW = new Date(2026, 9, 24, 15, 0).getTime();
const ROOT = "/Users/example/specweave-umb";
const DEEP = `${ROOT}/.specweave/increments/1041-fix-design-workspace/reports/findings.md`;
const PAGE_URL = "https://claude.ai/artifact/ExampleArtifact0001";

function file(path: string, messageId = "m"): ThreadArtifact {
  const basename = path.split("/").at(-1)!;
  return {
    key: `file:${path}`,
    kind: basename.endsWith(".md") ? "markdown" : "file",
    name: basename,
    messageId,
    meta: { filePath: path, basename, workspaceRelativePath: null } as never,
  };
}

function native(overrides: Partial<NativeArtifactReference> = {}): ThreadArtifact {
  return nativeArtifact({
    key: `claudeAgent:${PAGE_URL}`,
    provider: "claudeAgent",
    title: "Probe page",
    version: "1700000002-bbbb",
    seq: 2,
    localPath: "/Users/example/work/probe.html",
    url: PAGE_URL,
    artifactId: null,
    audience: "owner",
    itemId: "publish",
    publishedAt: NOW,
    source: "structured",
    ...overrides,
  });
}

function entries(artifacts: ThreadArtifact[], overrides: Partial<ShelfInput> = {}) {
  return shelfEntries({
    artifacts,
    mentionedAt: () => new Date(2026, 9, 24, 9, 5).getTime(),
    source: () => ({ label: "Wrote the findings" }),
    pullRequests: new Map(),
    fileChecks: new Map(),
    root: ROOT,
    pinned: new Set(),
    hidden: new Set(),
    now: NOW,
    ...overrides,
  });
}

const focused: string[] = [];
let renderer: ReactTestRenderer | undefined;
const handlers = { onOpen: vi.fn(), onPin: vi.fn(), onHide: vi.fn() };

async function render(list: ReturnType<typeof entries>, notice: string | null = null) {
  await act(async () => {
    renderer = create(
      <ArtifactShelfList
        entries={list}
        now={NOW}
        notice={notice}
        iconFor={() => () => <svg />}
        {...handlers}
      />,
      {
        // Buttons record focus by what they are.
        createNodeMock: (element) => {
          const props = element.props as Record<string, unknown>;
          return {
            focus: () =>
              focused.push(
                String(
                  props["aria-label"] ??
                    props["data-artifact-section-toggle"] ??
                    props["data-thread-artifact"],
                ),
              ),
          };
        },
      },
    );
  });
}

function row(name: string): ReactTestInstance {
  return renderer!.root.find((node) => node.type === "li" && textOf(node).includes(name));
}

function textOf(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  if (node.props["aria-hidden"] === true && node.type === "span") return "";
  return node.children.map(textOf).join("");
}

/** What the eye reads, separators included. */
function shownText(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(shownText).join("");
}

function actionOf(node: ReactTestInstance, action: string) {
  return node.find(
    (child) => child.type === "button" && child.props["data-artifact-action"] === action,
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  focused.length = 0;
  for (const handler of Object.values(handlers)) handler.mockReset();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("ArtifactShelfList rows", () => {
  it("names the kind, keeps the last folder whole, and says where and when it came from", async () => {
    await render(
      entries([file(DEEP)], {
        fileChecks: new Map([[DEEP, { state: "present" }]]),
      }),
    );
    const found = row("findings.md");
    expect(found.findByProps({ "data-artifact-kind": "true" }).children).toEqual(["Document"]);
    const folder = found.findByProps({
      "data-artifact-folder": `${ROOT}/.specweave/increments/1041-fix-design-workspace/reports`,
    });
    // Head and tail as separate spans: only the head is cut, and the text stays whole.
    expect(folder.children.map(textOf)).toEqual([
      "specweave-umb/.specweave/increments/1041-fix-design-workspace/",
      "reports",
    ]);
    expect(shownText(found.findByProps({ "data-artifact-meta": "true" }))).toBe(
      "specweave-umb/.specweave/increments/1041-fix-design-workspace/reports",
    );
    expect(shownText(found.findByProps({ "data-artifact-origin": "true" }))).toBe(
      "Wrote the findings·9:05 AM",
    );
    expect(found.findByType("time").props.dateTime).toBe(new Date(2026, 9, 24, 9, 5).toISOString());
  });

  it("shows the full path on focus at once, describes it, and copies it exactly", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const odd = `${ROOT}/notes/  spaced name .md`;
    await render(entries([file(odd)]));
    const open = row("spaced name").find(
      (node) => node.type === "button" && node.props["data-thread-artifact"] === "markdown",
    );
    expect(renderer!.root.findAllByProps({ "data-tooltip-open": "true" })).toHaveLength(0);
    await act(async () => open.props.onFocus());
    expect(renderer!.root.findByProps({ "data-artifact-full-path": "true" }).children).toEqual([
      odd,
    ]);
    const described = renderer!.root.findByProps({ id: open.props["aria-describedby"] });
    expect(described.children).toEqual([odd]);
    await act(async () => actionOf(row("spaced name"), "copy").props.onClick());
    expect(writeText).toHaveBeenCalledWith(odd);
  });

  it("keeps pin, hide and copy in reach without hover, at least 24 px, and the pin visible once pinned", async () => {
    await render(
      entries([file("/tmp/a/one.md"), file("/tmp/a/two.md")], {
        pinned: new Set(["file:/tmp/a/one.md"]),
      }),
    );
    for (const name of ["one.md", "two.md"]) {
      for (const action of ["pin", "hide", "copy"]) {
        const button = actionOf(row(name), action);
        expect(button.props.className, `${name} ${action}`).toContain("size-6");
        expect(button.props.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
      }
    }
    const pinned = actionOf(row("one.md"), "pin");
    expect(pinned.props["aria-pressed"]).toBe(true);
    expect(pinned.props["aria-label"]).toBe("Pin one.md");
    // Shown however the pointer moves: no opacity rule on a pinned pin.
    expect(pinned.props.className).not.toContain("opacity-0");
    const unpinned = actionOf(row("two.md"), "pin");
    expect(unpinned.props["aria-pressed"]).toBe(false);
    expect(unpinned.props.className).toContain("group-focus-within/shelf-row:opacity-100");
    expect(unpinned.props.className).toContain("pointer-coarse:opacity-100");
  });

  it("labels every state, and says why a machine cannot be asked", async () => {
    const checks: Record<string, ShelfFileCheck> = {
      "/tmp/a/missing.md": { state: "missing" },
      "/tmp/a/offline.md": { state: "unreachable", reason: "Example Mac is offline" },
      "/tmp/a/checking.md": { state: "unknown", checking: true },
      "/tmp/a/unchecked.md": { state: "unknown" },
      "/Users/example/work/probe.html": { state: "missing" },
    };
    await render(
      entries(
        [
          file("/tmp/a/missing.md"),
          file("/tmp/a/offline.md"),
          file("/tmp/a/checking.md"),
          file("/tmp/a/unchecked.md"),
          native(),
        ],
        {
          fileChecks: new Map(Object.entries(checks)),
          pinned: new Set(["file:/tmp/a/missing.md"]),
        },
      ),
      "Example Mac is offline. Its files can't be checked until it is back.",
    );
    const tag = (name: string) =>
      row(name)
        .findAllByProps({ "data-artifact-tag": "true" })
        .map((node) => node.children.join(""));
    expect(tag("missing.md")).toEqual(["Missing"]);
    expect(tag("offline.md")).toEqual(["Unreachable"]);
    expect(tag("checking.md")).toEqual(["Checking"]);
    expect(tag("unchecked.md")).toEqual(["Not checked"]);
    expect(tag("Probe page")).toEqual(["Remote only"]);
    expect(row("offline.md").findByProps({ "data-artifact-reason": "true" }).children).toEqual([
      "Example Mac is offline",
    ]);
    expect(row("offline.md").props["data-artifact-state"]).toBe("unreachable");
    expect(renderer!.root.findByProps({ "data-artifact-shelf-notice": "true" }).children).toEqual([
      "Example Mac is offline. Its files can't be checked until it is back.",
    ]);
  });

  it("labels a published page as a private claude.ai link and opens it; one without a link does not open", async () => {
    await render(
      entries([
        native(),
        native({
          key: "claudeAgent:path:/tmp/other.html",
          url: null,
          title: "Elsewhere",
          localPath: "/tmp/other.html",
        }),
      ]),
    );
    const page = row("Probe page");
    expect(page.findByProps({ "data-artifact-note": "true" }).children).toEqual([
      "Private claude.ai link. Opens only for the account that published it.",
    ]);
    expect(page.findByProps({ "data-artifact-version": "true" }).children).toEqual(["Version 2"]);
    const open = page.find(
      (node) => node.type === "button" && node.props["data-thread-artifact"] === "native",
    );
    await act(async () => open.props.onClick());
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    const elsewhere = row("Elsewhere").find(
      (node) => node.type === "button" && node.props["data-thread-artifact"] === "native",
    );
    expect(elsewhere.props["aria-disabled"]).toBe(true);
    expect(elsewhere.props.onClick).toBeUndefined();
    expect(textOf(row("Elsewhere").findByProps({ "data-artifact-note": "true" }))).toBe("");
  });

  it("moves focus to the next row after a hide, and to the Hidden toggle after the last", async () => {
    const list = entries([file("/tmp/a/one.md"), file("/tmp/a/two.md")]);
    await render(list);
    await act(async () => actionOf(row("one.md"), "hide").props.onClick());
    expect(handlers.onHide).toHaveBeenCalledWith(
      expect.objectContaining({ label: "one.md" }),
      true,
    );
    expect(focused).toEqual(["markdown"]);
    focused.length = 0;
    // The list as the parent hands it back: one hidden, one left.
    await act(async () =>
      renderer!.update(
        <ArtifactShelfList
          entries={entries([file("/tmp/a/one.md"), file("/tmp/a/two.md")], {
            hidden: new Set(["file:/tmp/a/one.md"]),
          })}
          now={NOW}
          iconFor={() => () => <svg />}
          {...handlers}
        />,
      ),
    );
    await act(async () => actionOf(row("two.md"), "hide").props.onClick());
    expect(focused).toEqual(["hidden"]);
  });
});

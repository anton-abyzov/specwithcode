import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const overlay = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock("~/viewerOverlayStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/viewerOverlayStore")>()),
  // The overlay's header is the host's; the viewer's actions portal into it.
  useViewerOverlay: (options: Record<string, unknown> & { open: boolean }) => {
    overlay.last = options;
    return options.open ? { content: {} as HTMLElement, actions: {} as HTMLElement } : null;
  },
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (node: unknown) => node,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: (props: { open: boolean; children: unknown }) =>
    props.open ? <div data-dialog="open">{props.children as never}</div> : null,
  DialogPopup: (props: Record<string, unknown>) => <div {...props} />,
  DialogDockedPopup: (props: Record<string, unknown>) => <div {...props} />,
  DialogTitle: (props: { children: unknown }) => <h2>{props.children as never}</h2>,
  DialogDescription: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));

vi.mock("../ui/menu", () => ({
  Menu: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuTrigger: () => null,
  MenuPopup: (props: { children: unknown }) => <div>{props.children as never}</div>,
  MenuItem: (props: { children: unknown; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children as never}
    </button>
  ),
}));

vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_environmentId: string, _cwd: string, path: string) => ({
    data: { contents: `contents of ${path}` },
    error: null,
    isPending: false,
    isNotFile: false,
    readError: null,
    refresh: () => {},
  }),
}));
vi.mock("../files/AttachmentFilePreview", () => ({
  ReadOnlySourcePreview: (props: { name: string; text: string }) => (
    <pre data-source={props.name}>{props.text}</pre>
  ),
}));
const openFileInPanel = vi.fn();
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: openFileInPanel }) },
}));

import { use } from "react";
import { ReportArtifactCard, type ReportSaveState } from "./ReportArtifact";
import { InViewerOverlay } from "~/viewerOverlayStore";

const REPORT = [
  "# Review cycle 2",
  "",
  "No critical or high findings remain after the fixes.",
  "",
  ...Array.from({ length: 14 }, (_, i) => `- Finding ${i + 1}`),
].join("\n");

const save = (overrides: Partial<ReportSaveState> = {}): ReportSaveState => ({
  increment: "0973-budget",
  savedPath: null,
  folder: ".specweave/increments/0973-budget/reports",
  canSave: true,
  saving: false,
  error: null,
  onSave: vi.fn(),
  ...overrides,
});

describe("ReportArtifactCard", () => {
  it("shows the title, size, increment and opening lines, not the whole report", () => {
    const html = renderToStaticMarkup(
      <ReportArtifactCard text={REPORT} fallbackTitle="Thread" save={save()}>
        <p>full body</p>
      </ReportArtifactCard>,
    );
    expect(html).toContain("Review cycle 2");
    expect(html).toContain('data-report-increment="0973-budget"');
    expect(html).toContain("No critical or high findings remain after the fixes.");
    expect(html).toContain("Save to increment");
    expect(html).not.toContain("full body");
  });

  it("offers Save to reports with no increment, and no save once saved or without write access", () => {
    const loose = renderToStaticMarkup(
      <ReportArtifactCard
        text={REPORT}
        fallbackTitle="Thread"
        save={save({ increment: null, folder: ".specweave/reports/threads" })}
      >
        <p />
      </ReportArtifactCard>,
    );
    expect(loose).toContain("Save to reports");
    expect(loose).not.toContain("data-report-increment");

    const saved = renderToStaticMarkup(
      <ReportArtifactCard
        text={REPORT}
        fallbackTitle="Thread"
        save={save({ savedPath: ".specweave/increments/0973-budget/reports/r.md" })}
      >
        <p />
      </ReportArtifactCard>,
    );
    expect(saved).toContain("Saved");
    expect(saved).not.toContain("Save to increment");

    const readOnly = renderToStaticMarkup(
      <ReportArtifactCard text={REPORT} fallbackTitle="Thread" save={save({ canSave: false })}>
        <p />
      </ReportArtifactCard>,
    );
    expect(readOnly).not.toContain("Save to increment");
  });

  it("opens the whole report in a reader and saves from the card", () => {
    const state = save();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ReportArtifactCard text={REPORT} fallbackTitle="Thread" save={state}>
          <p>full body</p>
        </ReportArtifactCard>,
      );
    });
    const text = (node: { children: ReadonlyArray<unknown> }): string =>
      node.children
        .map((child) => (typeof child === "string" ? child : text(child as never)))
        .join("");
    const button = (label: string) =>
      renderer.root.findAll((node) => node.type === "button" && text(node).includes(label))[0]!;
    act(() => button("Save to increment").props.onClick());
    expect(state.onSave).toHaveBeenCalledOnce();

    expect(JSON.stringify(renderer.toJSON())).not.toContain("full body");
    act(() => button("Open report").props.onClick());
    const reader = renderer.root.findAll(
      (node) => node.type === "div" && node.props["data-report-reader"] === "true",
    );
    expect(reader).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain("full body");
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Save to increment (.specweave/increments/0973-budget/reports/)",
    );
    expect(
      renderer.root.findAll((node) => node.props["data-report-outline"] === "true"),
    ).toHaveLength(0);
  });

  it("can hand the report to the conversation from the reader", () => {
    const onShowInline = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ReportArtifactCard
          text={REPORT}
          fallbackTitle="Thread"
          save={null}
          onShowInline={onShowInline}
        >
          <p>full body</p>
        </ReportArtifactCard>,
      );
    });
    const text = (node: { children: ReadonlyArray<unknown> }): string =>
      node.children
        .map((child) => (typeof child === "string" ? child : text(child as never)))
        .join("");
    const button = (label: string) =>
      renderer.root.findAll((node) => node.type === "button" && text(node).includes(label))[0];
    act(() => button("Open report")!.props.onClick());
    act(() => button("Show in chat")!.props.onClick());
    expect(onShowInline).toHaveBeenCalledOnce();
    // The reader closes as the report opens in chat.
    expect(renderer.root.findAll((node) => node.props["data-report-reader"] === "true")).toEqual(
      [],
    );
  });
  it("reads a labeled report as a document: properties, serif title, lead and sections", () => {
    const labeled = [
      "**Outcome:** Thread rows now show the harness first. Native threads read Claude Code.",
      "",
      "**Evidence:** commit `d7c074f0b` on `feat/x`. Screenshots at `a.png`. Tests: 262/262 pass.",
      "",
      "**Blockers:** none.",
    ].join("\n");
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ReportArtifactCard
          text={labeled}
          fallbackTitle="Show harness on thread rows"
          save={save()}
          renderMarkdown={(part) => <p data-part>{part}</p>}
        >
          <p>full body</p>
        </ReportArtifactCard>,
      );
    });
    const open = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"]?.startsWith("Open report"),
    )[0]!;
    act(() => open.props.onClick());
    const json = JSON.stringify(renderer.toJSON());
    expect(json).not.toContain("full body");
    expect(json).toContain("Show harness on thread rows");
    expect(json).toContain(
      "Thread rows now show the harness first. Native threads read Claude Code.",
    );
    expect(json).toContain("Blockers");
    expect(json).toContain('"None"');
    const section = renderer.root.findAll(
      (node) => node.type === "section" && node.props["data-report-section"] === "Evidence",
    );
    expect(section).toHaveLength(1);
    expect(JSON.stringify(section[0]!.findAll((node) => node.type === "p")[0]!.children)).toContain(
      "- Commit `d7c074f0b` on `feat/x`.\\n- Screenshots at `a.png`.",
    );
  });
  it("marks what it shows as inside the overlay, so links in it open there", () => {
    let inside: boolean | null = null;
    function Probe() {
      inside = use(InViewerOverlay);
      return null;
    }
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ReportArtifactCard
          text={"**Outcome:** done.\n\n**Evidence:** see the findings. They are long. Read all."}
          fallbackTitle="Findings"
          save={null}
          renderMarkdown={() => <Probe />}
        >
          <p />
        </ReportArtifactCard>,
      );
    });
    const open = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-label"]?.startsWith("Open report"),
    )[0]!;
    act(() => open.props.onClick());
    expect(inside).toBe(true);
    // The header is the report's own: links no longer swap it for a file.
    expect(overlay.last).toMatchObject({ title: "Findings", kind: "Report", badge: "MD" });
    expect(overlay.last).not.toHaveProperty("trail");
  });
});

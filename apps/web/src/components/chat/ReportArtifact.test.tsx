import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/dialog", () => ({
  Dialog: (props: { open: boolean; children: unknown }) =>
    props.open ? <div data-dialog="open">{props.children as never}</div> : null,
  DialogPopup: (props: Record<string, unknown>) => <div {...props} />,
  DialogTitle: (props: { children: unknown }) => <h2>{props.children as never}</h2>,
  DialogDescription: (props: { children: unknown }) => <div>{props.children as never}</div>,
}));

import { ReportArtifactCard, type ReportSaveState } from "./ReportArtifact";

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
      "Not saved yet. Saving puts it in .specweave/increments/0973-budget/reports/",
    );
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
});

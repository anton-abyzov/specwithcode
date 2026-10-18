import { useEffect } from "react";
import { act, create } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CollapsibleReport, reportBodyOverflows } from "./CollapsibleReport";

const LONG = Array.from({ length: 100 }, (_, i) => `Finding ${i + 1}.`).join("\n");

describe("CollapsibleReport", () => {
  it("folds a long report behind Show full report", () => {
    const html = renderToStaticMarkup(
      <CollapsibleReport text={LONG}>
        <p>body</p>
      </CollapsibleReport>,
    );
    expect(html).toContain('data-report-collapsed="true"');
    expect(html).toContain("max-h-60");
    expect(html).toContain("Show full report");
  });

  it("shows a short report in full with no toggle", () => {
    const html = renderToStaticMarkup(
      <CollapsibleReport text="Done.">
        <p>body</p>
      </CollapsibleReport>,
    );
    expect(html).toContain('data-report-collapsed="false"');
    expect(html).not.toContain("Show full report");
  });

  it("does not fold while the report streams", () => {
    const html = renderToStaticMarkup(
      <CollapsibleReport text={LONG} streaming>
        <p>body</p>
      </CollapsibleReport>,
    );
    expect(html).toContain('data-report-collapsed="false"');
    expect(html).not.toContain("Show full report");
  });

  it("expands and folds again", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <CollapsibleReport text={LONG}>
          <p>body</p>
        </CollapsibleReport>,
      );
    });
    const toggle = () =>
      renderer.root.findAll(
        (node) => node.type === "button" && node.props["aria-expanded"] !== undefined,
      )[0]!;
    const body = () =>
      renderer.root.findAll((node) => node.props["data-report-collapsed"] !== undefined)[0]!;

    const root = () =>
      renderer.root.findAll((node) => node.props["data-report-collapsible"] !== undefined)[0]!;
    const footer = () =>
      renderer.root.findAll((node) => node.props["data-collapsible-footer"] === "true")[0]!;

    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(root().props["data-report-expanded"]).toBe("false");
    act(() => toggle().props.onClick());
    expect(body().props["data-report-collapsed"]).toBe("false");
    expect(JSON.stringify(renderer.toJSON())).toContain("Show less");
    // Open, a rule bounds the block and "Show less" stays reachable at the bottom of the view.
    expect(root().props["data-report-expanded"]).toBe("true");
    expect(root().props.className).toContain("before:bg-border");
    expect(footer().props.className).toContain("sticky");
    expect(toggle().props["data-collapsible-toggle"]).toBe("collapse");
    act(() => toggle().props.onClick());
    expect(body().props["data-report-collapsed"]).toBe("true");
    expect(root().props.className).toBeUndefined();
    expect(footer().props.className).not.toContain("sticky");
  });

  it("uses its own label and skips the rule where a bubble bounds it", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <CollapsibleReport text={LONG} expandLabel="Show full message" boundary={false}>
          <p>body</p>
        </CollapsibleReport>,
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Show full message");
    const button = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-expanded"] !== undefined,
    )[0]!;
    act(() => button.props.onClick());
    const root = renderer.root.findAll(
      (node) => node.props["data-report-collapsible"] !== undefined,
    )[0]!;
    expect(root.props["data-report-expanded"]).toBe("true");
    expect(root.props.className ?? "").not.toContain("before:bg-border");
  });

  it("renders the body as is when folding is off", () => {
    const html = renderToStaticMarkup(
      <CollapsibleReport text={LONG} enabled={false}>
        <p>body</p>
      </CollapsibleReport>,
    );
    expect(html).not.toContain("data-report-collapsed");
    expect(html).not.toContain("max-h-60");
    expect(html).not.toContain("Show full report");
  });

  it("keeps the body mounted when folding turns on or off", () => {
    const mounted = vi.fn();
    function Body() {
      useEffect(() => mounted(), []);
      return <p>body</p>;
    }
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <CollapsibleReport text={LONG} enabled={false}>
          <Body />
        </CollapsibleReport>,
      );
    });
    act(() =>
      renderer.update(
        <CollapsibleReport text={LONG} enabled>
          <Body />
        </CollapsibleReport>,
      ),
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("Show full report");
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("drops the fade and the toggle when the rendered report already fits", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <CollapsibleReport text={LONG}>
          <p>body</p>
        </CollapsibleReport>,
        { createNodeMock: () => ({ scrollHeight: 120, clientHeight: 120 }) },
      );
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).not.toContain("Show full report");
    expect(json).toContain('"data-report-collapsed":"false"');
  });

  it("keeps the toggle when the rendered report overflows", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <CollapsibleReport text={LONG}>
          <p>body</p>
        </CollapsibleReport>,
        { createNodeMock: () => ({ scrollHeight: 900, clientHeight: 240 }) },
      );
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Show full report");
  });

  it("opens for a citation inside it and reports each toggle", () => {
    const onToggle = vi.fn();
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <CollapsibleReport text={LONG} onToggle={onToggle}>
          <p>body</p>
        </CollapsibleReport>,
      );
    });
    const toggle = () =>
      renderer.root.findAll(
        (node) => node.type === "button" && node.props["aria-expanded"] !== undefined,
      )[0]!;
    act(() => toggle().props.onClick());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    act(() => toggle().props.onClick());
    expect(onToggle).toHaveBeenLastCalledWith(false);

    act(() =>
      renderer.update(
        <CollapsibleReport text={LONG} forceExpanded>
          <p>body</p>
        </CollapsibleReport>,
      ),
    );
    // Held open for the citation: no toggle that could not fold it anyway.
    const buttons = () => renderer.root.findAll((node) => node.type === "button");
    expect(buttons()).toEqual([]);
    // Once the citation lets go it stays open, and "Show less" folds it.
    act(() =>
      renderer.update(
        <CollapsibleReport text={LONG}>
          <p>body</p>
        </CollapsibleReport>,
      ),
    );
    expect(toggle().props["aria-expanded"]).toBe(true);
    act(() => toggle().props.onClick());
    expect(toggle().props["aria-expanded"]).toBe(false);
  });
});

describe("reportBodyOverflows", () => {
  it("reads overflow only when there is layout", () => {
    expect(reportBodyOverflows(null)).toBeNull();
    expect(reportBodyOverflows({ scrollHeight: 0, clientHeight: 0 })).toBeNull();
    expect(reportBodyOverflows({ scrollHeight: 240, clientHeight: 240 })).toBe(false);
    expect(reportBodyOverflows({ scrollHeight: 241, clientHeight: 240 })).toBe(false);
    expect(reportBodyOverflows({ scrollHeight: 600, clientHeight: 240 })).toBe(true);
  });

  it("starts open on request, and hides the toggle while a citation holds it open", () => {
    const opened = renderToStaticMarkup(
      <CollapsibleReport text={LONG} defaultExpanded>
        <p>body</p>
      </CollapsibleReport>,
    );
    expect(opened).toContain('data-report-collapsed="false"');
    expect(opened).toContain("Show less");

    const cited = renderToStaticMarkup(
      <CollapsibleReport text={LONG} forceExpanded>
        <p>body</p>
      </CollapsibleReport>,
    );
    expect(cited).toContain('data-report-collapsed="false"');
    expect(cited).toContain('data-report-expanded="true"');
    expect(cited).not.toContain("Show less");
  });

  it("pins the open footer above the composer inset", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <CollapsibleReport text={LONG} defaultExpanded>
          <p>body</p>
        </CollapsibleReport>,
      );
    });
    const footer = renderer.root.findAll(
      (node) => node.props["data-collapsible-footer"] === "true",
    )[0]!;
    expect(footer.props.className).toContain("var(--composer-timeline-inset");
  });
});

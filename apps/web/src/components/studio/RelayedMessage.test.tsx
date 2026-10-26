// @vitest-environment jsdom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RelayedMessage } from "./RelayedMessage";

const LONG = [
  "Reminder: the release thread owns 1.0.89 and will cut it once #778 merges.",
  "",
  Array.from(
    { length: 14 },
    (_, index) => `Detail ${index + 1}: the M4 install failed the same way 1.0.88 did.`,
  ).join(" "),
  "",
  "Please don't dispatch a Mac release yourself.",
].join("\n");

function relay(text: string, onOpen = vi.fn()) {
  return (
    <RelayedMessage
      label="Message from coordinator"
      source="coordinator"
      view={{ label: "View coordinator", onOpen }}
      createdAt="2026-10-26T03:08:05Z"
      timestampFormat="12-hour"
      original={text}
      text={text}
      renderMarkdown={(part) => <p data-body>{part}</p>}
    />
  );
}

const textOf = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");

describe("RelayedMessage", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows a short message open under a quiet header, and folds it to the header", async () => {
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(relay("Done. The PR is green."));
    });
    const section = renderer.root.findByType("section");
    expect(section.props["data-relayed-message"]).toBe("coordinator");
    expect(section.props["data-relayed-message-state"]).toBe("open");
    const toggle = renderer.root.findByProps({ "aria-expanded": true });
    expect(toggle.props["aria-label"]).toBe("Message from coordinator. Show less");
    expect(textOf(renderer)).toContain("Done. The PR is green.");
    await act(() => toggle.props.onClick());
    expect(section.props["data-relayed-message-state"]).toBe("folded");
    const body = renderer.root.findByProps({ id: toggle.props["aria-controls"] });
    expect(body.props.hidden).toBe(true);
    renderer.unmount();
  });

  it("folds a long message to its opening and opens it from the header", async () => {
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(relay(LONG));
    });
    const section = renderer.root.findByType("section");
    expect(section.props["data-worker-message"]).toBe("folded");
    expect(textOf(renderer)).toContain("Reminder: the release thread owns 1.0.89");
    expect(textOf(renderer)).not.toContain("Please don't dispatch");
    const toggle = renderer.root.findByProps({ "aria-expanded": false });
    expect(toggle.props["aria-label"]).toMatch(
      /^Message from coordinator\. Show full message, [\d,]+ more characters$/,
    );
    await act(() => toggle.props.onClick());
    expect(section.props["data-worker-message"]).toBe("open");
    expect(textOf(renderer)).toContain("Please don't dispatch a Mac release yourself.");
    // Opened by the reader, a quiet Show less follows them down the message.
    const footer = renderer.root.findByProps({ "data-relayed-message-footer": true });
    expect(footer.props.className).toContain("sticky");
    renderer.unmount();
  });

  it("links back to where it came from, with its time", async () => {
    const onOpen = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(relay("Done.", onOpen));
    });
    const view = renderer.root.find(
      (node) => node.type === "button" && node.children.includes("View coordinator"),
    );
    await act(() => view.props.onClick());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(renderer.root.findByType("time").props.dateTime).toBe("2026-10-26T03:08:05Z");
    renderer.unmount();
  });
});

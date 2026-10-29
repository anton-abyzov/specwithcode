import {
  INTERNAL_RECEIPTS,
  MOBILE_CARRY_FORWARD,
} from "../../../tests/agent-messages/internalReceipts";
// @vitest-environment jsdom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const findState = vi.hoisted(() => ({ query: "" }));
vi.mock("../find/conversationFindStore", () => ({
  useConversationFindQueryWithin: () => findState.query,
}));

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

function relay(
  text: string,
  onOpen = vi.fn(),
  detail: "concise" | "normal" | "verbose" = "normal",
  source: "coordinator" | "thread" = "coordinator",
) {
  return (
    <RelayedMessage
      detail={detail}
      label="Message from coordinator"
      source={source}
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
    findState.query = "";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", () => 0);
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["Done. The PR is green.", LONG, MOBILE_CARRY_FORWARD])(
    "Results only hides previews until opened: %s",
    async (text) => {
      let renderer!: ReactTestRenderer;
      await act(() => {
        renderer = create(relay(text, vi.fn(), "concise"));
      });
      const toggle = renderer.root.findByProps({ "aria-expanded": false });
      const body = renderer.root.findByProps({ id: toggle.props["aria-controls"] });
      expect(body.props.hidden).toBe(true);
      await act(() => toggle.props.onClick());
      expect(body.props.hidden).not.toBe(true);
      expect(textOf(renderer)).toContain(text);
      renderer.unmount();
    },
  );

  it("Find opens a Results-only relay even when the match is in its formerly visible lead", async () => {
    let renderer!: ReactTestRenderer;
    findState.query = "release thread owns";
    await act(() => {
      renderer = create(relay(LONG, vi.fn(), "concise"));
    });
    const toggle = renderer.root.findByProps({ "aria-expanded": true });
    const body = renderer.root.findByProps({ id: toggle.props["aria-controls"] });
    expect(body.props.hidden).not.toBe(true);
    expect(textOf(renderer)).toContain("Please don't dispatch");
    await act(() => renderer.unmount());
  });

  it.each(["normal", "concise"] as const)(
    "folds screenshot receipts in %s without losing originals",
    async (detail) => {
      const texts = INTERNAL_RECEIPTS;
      for (const text of texts) {
        let renderer!: ReactTestRenderer;
        await act(() => {
          renderer = create(
            <>
              {relay(text, vi.fn(), detail, "coordinator")}
              {relay(text, vi.fn(), detail, "thread")}
            </>,
          );
        });
        const toggles = renderer.root.findAllByProps({ "aria-expanded": false });
        expect(toggles).toHaveLength(2);
        expect(renderer.root.findAllByProps({ "data-relayed-attention": true })).toHaveLength(0);
        for (const toggle of toggles) {
          expect(
            renderer.root.findByProps({ id: toggle.props["aria-controls"] }).props.hidden,
          ).toBe(true);
          await act(() => toggle.props.onClick());
        }
        expect(textOf(renderer)).toContain(text);
        await act(() => renderer.unmount());
      }
    },
  );
  it.each([
    "Approve the deployment?",
    "## Approve the deployment?",
    "- Confirm the destination before I continue.",
    "Deployment failed. Please log in to continue.",
    "**Blockers:** Anton must choose a destination.",
    "Authentication failed. Please sign in to continue.",
  ])("keeps candidate user attention visible: %s", async (text) => {
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(relay(text, vi.fn(), "concise"));
    });
    expect(renderer.root.findAllByProps({ "data-relayed-attention": true }).length).toBe(1);
    expect(textOf(renderer)).toContain(text);
    await act(() => renderer.unmount());
  });
  it("keeps short internal receipts behind a quiet disclosure", async () => {
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(relay("Done. The PR is green."));
    });
    const section = renderer.root.findByType("section");
    expect(section.props["data-relayed-message-state"]).toBe("folded");
    expect(textOf(renderer)).not.toContain("Done. The PR is green.");
    const toggle = renderer.root.findByProps({ "aria-expanded": false });
    await act(() => toggle.props.onClick());
    expect(textOf(renderer)).toContain("Done. The PR is green.");
    await act(() => renderer.unmount());
  });

  it("folds routine prose while retaining failure prose and the full original", async () => {
    let renderer!: ReactTestRenderer;
    await act(() => {
      renderer = create(relay(LONG));
    });
    const section = renderer.root.findByType("section");
    expect(section.props["data-worker-message"]).toBe("folded");
    expect(textOf(renderer)).not.toContain("Reminder: the release thread owns 1.0.89");
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

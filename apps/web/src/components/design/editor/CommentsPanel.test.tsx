// @vitest-environment jsdom
import type { DesignComment, DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { newDesignDocument } from "@specweave-studio/shared/designOps";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CommentsPanel } from "./CommentsPanel";

const base = newDesignDocument({
  id: "d_comments",
  kind: "design",
  title: "Comments",
  now: "2026-10-24T00:00:00.000Z",
  createdBy: { kind: "user" },
});
const page = base.pages[0]!;
const frame = page.nodes[0]!;

const comment = (id: string, extra: Partial<DesignComment> = {}): DesignComment => ({
  id,
  pageId: page.id,
  nodeId: frame.id,
  x: 30,
  y: 40,
  text: `Text of ${id}`,
  author: { kind: "user" },
  createdAt: "2026-10-24T12:00:00.000Z",
  resolved: false,
  ...extra,
});
const withComments = (comments: DesignComment[]): DesignDocument => ({ ...base, comments });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const buttons = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent?.trim() === text,
  );

function mount(
  design: DesignDocument,
  options: { canComment?: boolean; canReply?: boolean } = {},
  onCommit = vi.fn<(operations: DesignOperation[]) => void>(),
) {
  act(() => {
    root.render(
      <CommentsPanel
        document={design}
        draft={null}
        activeId={null}
        canComment={options.canComment ?? true}
        canReply={options.canReply ?? true}
        onCommit={onCommit}
        onCancelDraft={() => undefined}
        onOpen={() => undefined}
        onClose={() => undefined}
      />,
    );
  });
  return onCommit;
}

function type(field: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CommentsPanel threads", () => {
  it("lists replies under their thread and numbers threads, not comments", () => {
    mount(
      withComments([
        comment("c_root"),
        comment("c_reply", { parentId: "c_root", text: "Agreed" }),
        comment("c_second", { nodeId: null }),
      ]),
    );
    const threads = [
      ...container.querySelectorAll("[data-testid=comments-panel] > ol > li[data-comment]"),
    ];
    expect(threads.map((li) => li.getAttribute("data-comment"))).toEqual(["c_root", "c_second"]);
    const replies = threads[0]!.querySelector('ol[aria-label="Replies"]');
    expect(replies?.textContent).toContain("Agreed");
    expect(threads[0]!.querySelector("button span")?.textContent).toBe("1");
    expect(threads[1]!.querySelector("button span")?.textContent).toBe("2");
    expect(threads[1]!.querySelector('ol[aria-label="Replies"]')).toBeNull();
  });

  it("offers Reply only with comment access, a threading server and an open thread", () => {
    const open = withComments([comment("c_root")]);
    mount(open);
    expect(buttons("Reply")).toHaveLength(1);
    mount(open, { canReply: false });
    expect(buttons("Reply")).toHaveLength(0);
    mount(open, { canComment: false });
    expect(buttons("Reply")).toHaveLength(0);
    mount(withComments([comment("c_root", { resolved: true })]));
    expect(buttons("Reply")).toHaveLength(0);
  });

  it("sends a reply with the thread's id and anchor, then closes the form", () => {
    const onCommit = mount(withComments([comment("c_root")]));
    act(() => buttons("Reply")[0]!.click());
    const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!;
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    type(field, "  Tide times go in the footer.  ");
    act(() => buttons("Reply").at(-1)!.click());
    expect(onCommit).toHaveBeenCalledTimes(1);
    const [operation] = onCommit.mock.calls[0]![0];
    expect(operation).toMatchObject({
      op: "add_comment",
      comment: {
        parentId: "c_root",
        pageId: page.id,
        nodeId: frame.id,
        x: 30,
        y: 40,
        text: "Tide times go in the footer.",
        resolved: false,
      },
    });
    expect(container.querySelector('textarea[aria-label="Reply"]')).toBeNull();
  });

  it("cancels a reply with Escape and hides it while the thread is resolved or gone", () => {
    const design = withComments([comment("c_root")]);
    const onCommit = mount(design);
    const replyField = () =>
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]');
    act(() => buttons("Reply")[0]!.click());
    act(() => {
      replyField()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(replyField()).toBeNull();
    act(() => buttons("Reply")[0]!.click());
    type(replyField()!, "Half a thought");
    mount(withComments([comment("c_root", { resolved: true })]), {}, onCommit);
    expect(replyField()).toBeNull();
    mount(withComments([]), {}, onCommit);
    expect(replyField()).toBeNull();
    // Reopened elsewhere: the unsent reply is still there.
    mount(design, {}, onCommit);
    expect(replyField()?.value).toBe("Half a thought");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("resolves the thread by its first comment and counts resolved threads", () => {
    const onCommit = mount(
      withComments([
        comment("c_root"),
        comment("c_reply", { parentId: "c_root" }),
        comment("c_done", { resolved: true }),
        comment("c_done_reply", { parentId: "c_done", resolved: true }),
      ]),
    );
    expect(container.textContent).toContain("Show resolved (1)");
    act(() => buttons("Resolve")[0]!.click());
    expect(onCommit).toHaveBeenCalledWith([
      { op: "resolve_comment", commentId: "c_root", resolved: true },
    ]);
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Delete reply"]')!.click(),
    );
    expect(onCommit).toHaveBeenLastCalledWith([{ op: "delete_comment", commentId: "c_reply" }]);
  });
});

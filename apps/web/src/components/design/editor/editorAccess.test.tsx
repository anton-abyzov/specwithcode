import type {
  DesignDocument,
  DesignSystemId,
  EnvironmentId,
  ThreadId,
} from "@specweave-studio/contracts";
import { newDesignDocument } from "@specweave-studio/shared/designOps";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { DesignSystemPickerView } from "../systems/DesignSystemPicker";
import { BoundThreadPane } from "./BoundThreadPane";
import { CommentsPanel, commentDraftAnchor, type CommentDraft } from "./CommentsPanel";
import { MiniToolbar } from "./MiniToolbar";

const env = "env-a" as EnvironmentId;

function doc(): DesignDocument {
  return newDesignDocument({
    id: "d_access",
    kind: "design",
    title: "Access",
    now: "2026-10-20T00:00:00.000Z",
    createdBy: { kind: "user" },
    random: () => 0.25,
  });
}

const noop = () => undefined;
const draftOnGone: CommentDraft = {
  pageId: "p",
  nodeId: "n_gone",
  x: 4,
  y: 6,
  canvasX: 140,
  canvasY: 260,
};

describe("comment drafts", () => {
  it("falls back to the canvas point when the anchored layer is gone", () => {
    expect(commentDraftAnchor(draftOnGone, () => false)).toEqual({ nodeId: null, x: 140, y: 260 });
    expect(commentDraftAnchor(draftOnGone, () => true)).toEqual({ nodeId: "n_gone", x: 4, y: 6 });
  });

  it("renders a draft whose layer was removed instead of crashing", () => {
    const html = renderToStaticMarkup(
      <CommentsPanel
        document={doc()}
        draft={{ ...draftOnGone, pageId: doc().pages[0]!.id }}
        activeId={null}
        canComment
        onCommit={noop}
        onCancelDraft={noop}
        onOpen={noop}
        onClose={noop}
      />,
    );
    expect(html).toContain("New comment on");
    expect(html).toContain("the canvas");
  });
});

describe("access gating", () => {
  const node = doc().pages[0]!.nodes[0]!;
  const toolbar = (canEdit: boolean, canComment: boolean) =>
    renderToStaticMarkup(
      <MiniToolbar
        nodes={[node]}
        system={null}
        mode="light"
        canEdit={canEdit}
        canComment={canComment}
        canAskAgent={canEdit}
        onFill={noop}
        onComment={noop}
        onAskAgent={async () => undefined}
      />,
    );

  it("shows Ask agent only with edit access and Comment only with comment access", () => {
    expect(toolbar(true, true)).toContain("Ask agent");
    expect(toolbar(false, true)).not.toContain("Ask agent");
    expect(toolbar(false, true)).toContain("Comment on selection");
    expect(toolbar(false, false)).not.toContain("Comment on selection");
  });

  it("offers Start a thread only with edit access", () => {
    const pane = (canStart: boolean, thread: "none" | "other") =>
      renderToStaticMarkup(
        <BoundThreadPane
          binding={
            thread === "none"
              ? null
              : { environmentId: "env-b" as EnvironmentId, threadId: "t" as ThreadId }
          }
          environmentId={env}
          machine={() => ({
            environmentId: "env-b" as EnvironmentId,
            label: "Mac mini",
            linked: true,
          })}
          renderChat={() => null}
          onStartThread={async () => undefined}
          onOpenThere={noop}
          canStart={canStart}
        />,
      );
    expect(pane(true, "none")).toContain("Start a thread");
    expect(pane(false, "none")).not.toContain(">Start a thread<");
    expect(pane(false, "other")).not.toContain("Start a thread here");
    expect(pane(false, "other")).toContain("Open there");
  });
});

describe("DesignSystemPickerView inline", () => {
  it("shows loading in the trigger and is disabled without edit access", () => {
    const html = renderToStaticMarkup(
      <DesignSystemPickerView
        inline
        owner={{ kind: "playground" }}
        systems={null}
        projects={[]}
        value={"s_fixture" as DesignSystemId}
        onChange={() => undefined}
        disabled
      />,
    );
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Loading design systems");
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});

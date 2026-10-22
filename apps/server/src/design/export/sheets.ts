import type { DesignDocument, DesignNode, DesignPage } from "@specweave-studio/contracts";
import type { DesignHtmlTarget } from "@specweave-studio/shared/designRender";

/** Top-level visible frames of a page. */
export const designFrames = (page: DesignPage): ReadonlyArray<DesignNode> =>
  page.nodes.filter(
    (node) => node.parentId === null && node.type === "frame" && node.hidden !== true,
  );

export interface DesignSheet {
  readonly page: DesignPage;
  readonly target: DesignHtmlTarget;
}

/**
 * What a PDF page or a PPTX slide shows, for every page that is not skipped.
 * A slide is its page's frame, so a deck exports one sheet per slide; a
 * design exports every top-level frame. A page without frames exports whole,
 * and an empty page exports nothing.
 */
export function exportSheets(document: DesignDocument): ReadonlyArray<DesignSheet> {
  return document.pages
    .filter((page) => page.skipped !== true)
    .flatMap((page) => {
      const frames = designFrames(page);
      if (frames.length === 0)
        return page.nodes.length > 0 ? [{ page, target: { pageId: page.id } }] : [];
      const chosen = document.kind === "slides" ? frames.slice(0, 1) : frames;
      return chosen.map((frame) => ({ page, target: { pageId: page.id, frameId: frame.id } }));
    });
}

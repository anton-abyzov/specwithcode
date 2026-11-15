import type { Root, RootContent } from "mdast";
import ReactMarkdown from "react-markdown";

import { CHAT_REMARK_GFM } from "../../markdown-gfm";

/**
 * The collapsed reasoning preview is one truncated line, so it parses only a
 * prefix of the block. Long blocks streamed in full would otherwise be parsed
 * again on every update. The expanded view renders the whole block.
 */
export const REASONING_PREVIEW_SOURCE_MAX_LENGTH = 8_000;
/** The flattened preview text is cut here; far more than one line shows. */
export const REASONING_PREVIEW_TEXT_MAX_LENGTH = 2_048;
/** How far back from the limit a paragraph or line break is still preferred. */
const SAFE_BOUNDARY_WINDOW = 2_000;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * At most `max` characters of `text`, cut at a paragraph break, else a line
 * break, else whitespace near the limit, so the parser does not see half a
 * word, and never between the halves of a surrogate pair.
 */
export function reasoningPreviewSource(
  text: string,
  max: number = REASONING_PREVIEW_SOURCE_MAX_LENGTH,
): string {
  if (text.length <= max) return text;
  const floor = Math.max(0, max - SAFE_BOUNDARY_WINDOW);
  for (const separator of ["\n\n", "\n"]) {
    const at = text.lastIndexOf(separator, max - separator.length);
    if (at > floor) return text.slice(0, at);
  }
  for (let at = max; at > floor; at -= 1) {
    if (/\s/.test(text[at] ?? "")) return text.slice(0, at);
  }
  const end = isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

/** Flattens the parsed preview into one line of label text. */
export function remarkThoughtPreview(fallback: string) {
  return (tree: Root) => {
    const fragments: string[] = [];
    let remaining = REASONING_PREVIEW_TEXT_MAX_LENGTH;
    const append = (value: string) => {
      if (remaining <= 0 || value.length === 0) return;
      const text = value.slice(0, remaining);
      remaining -= text.length;
      fragments.push(text);
    };
    const visit = (node: Root | RootContent) => {
      if (remaining <= 0 || node.type === "html" || node.type === "definition") return;
      if ("alt" in node) append(node.alt ?? "");
      else if ("value" in node) append(node.value);
      else if ("children" in node) {
        const separated = ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(
          node.type,
        );
        for (const [index, child] of node.children.entries()) {
          if (remaining <= 0) break;
          if (index > 0 && separated) append(" ");
          visit(child);
        }
      } else if (node.type === "break") append(" ");
    };
    visit(tree);
    tree.children = [
      { type: "text", value: fragments.join("").replace(/\s+/g, " ").trim() || fallback },
    ];
  };
}

/** The collapsed one-line preview of a reasoning block. */
export function ReasoningPreviewMarkdown({
  text,
  fallback,
}: {
  readonly text: string;
  readonly fallback: string;
}) {
  return (
    <ReactMarkdown remarkPlugins={[CHAT_REMARK_GFM, [remarkThoughtPreview, fallback]]}>
      {reasoningPreviewSource(text)}
    </ReactMarkdown>
  );
}

import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import type { Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";
import { getDisplayDateSegments, type DisplayDateOptions } from "./lib/displayDates";

export interface MarkdownDisplayDateOptions extends DisplayDateOptions {
  timestampFormat: TimestampFormat;
}

/** HTML belongs to its author, including text between inline opening/closing tags. */
function containsHtml(node: Root | RootContent): boolean {
  return node.type === "html" || ("children" in node && node.children.some(containsHtml));
}

/** Display-only AST transformation: source offsets, literals and link labels stay intact. */
export const remarkDisplayDates: Plugin<[MarkdownDisplayDateOptions], Root> = function (options) {
  return (tree) => {
    const visit = (node: Root | RootContent): void => {
      if (
        node.type === "link" ||
        node.type === "linkReference" ||
        node.type === "code" ||
        node.type === "inlineCode" ||
        node.type === "html" ||
        !("children" in node)
      )
        return;
      // Raw inline HTML is represented as separate sibling tokens in mdast.
      // Preserve its whole text-bearing block instead of guessing tag nesting.
      if (["paragraph", "heading", "tableCell"].includes(node.type) && containsHtml(node)) return;
      const children: RootContent[] = [];
      for (const child of node.children) {
        if (child.type !== "text") {
          visit(child);
          children.push(child);
          continue;
        }
        const segments = getDisplayDateSegments(child.value, options.timestampFormat, options);
        if (!segments.some((segment) => segment.type === "date")) {
          children.push(child);
          continue;
        }
        for (const segment of segments) {
          const text: Text = {
            type: "text",
            value: segment.type === "date" ? segment.label : segment.value,
          };
          if (segment.type === "date") {
            text.data = {
              hName: "time",
              hProperties: { dateTime: segment.value, dataMarkdownCopy: segment.value },
            };
          }
          children.push(text);
        }
      }
      // Every replacement is phrasing text, valid anywhere the original text was valid.
      node.children = children as typeof node.children;
    };
    visit(tree);
  };
};

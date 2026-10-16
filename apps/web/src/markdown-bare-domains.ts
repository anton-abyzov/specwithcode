import type { Link, Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";

// Common web TLDs only, so `Node.js`, `index.ts` or `v1.2` never read as sites.
const BARE_DOMAIN_PATTERN =
  /(?<![\w@/.:-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|dev|ai|app|co|sh|so|gg|me|xyz|tech|cloud|site|page|run|ly)(?:\/[^\s<>()"'`]*)?)(?![\w-])/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** `spec-weave.com/pricing` and other bare domains, split into text and links. */
export function bareDomainSegments(
  value: string,
): Array<{ readonly type: "text" | "link"; readonly value: string }> {
  const segments: Array<{ type: "text" | "link"; value: string }> = [];
  let index = 0;
  for (const match of value.matchAll(BARE_DOMAIN_PATTERN)) {
    const domain = match[1]!.replace(TRAILING_PUNCTUATION, "");
    const start = match.index;
    // GFM already links `www.` addresses.
    if (/^www\./i.test(domain)) continue;
    if (start > index) segments.push({ type: "text", value: value.slice(index, start) });
    segments.push({ type: "link", value: domain });
    index = start + domain.length;
  }
  if (index < value.length) segments.push({ type: "text", value: value.slice(index) });
  return segments;
}

/** Links bare domains in prose, the way GFM already links `www.` and `https://`. */
export const remarkBareDomainLinks: Plugin<[], Root> = function () {
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
      const children: RootContent[] = [];
      let changed = false;
      for (const child of node.children) {
        if (child.type !== "text") {
          visit(child);
          children.push(child);
          continue;
        }
        const segments = bareDomainSegments(child.value);
        if (!segments.some((segment) => segment.type === "link")) {
          children.push(child);
          continue;
        }
        changed = true;
        for (const segment of segments) {
          const text: Text = { type: "text", value: segment.value };
          if (segment.type === "text") {
            children.push(text);
            continue;
          }
          const link: Link = { type: "link", url: `https://${segment.value}`, children: [text] };
          children.push(link);
        }
      }
      if (changed) node.children = children as typeof node.children;
    };
    visit(tree);
  };
};

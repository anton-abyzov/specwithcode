import { Fragment, type ReactNode } from "react";

/**
 * Put React nodes into a translated sentence: `{name}` placeholders left in
 * the text are replaced by `nodes[name]`, so a translation can move a code
 * span or a highlighted name to wherever its grammar needs it.
 */
export function renderRich(text: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  const parts = text.split(/(\{\w+\})/g);
  return parts.map((part, index) => {
    const match = /^\{(\w+)\}$/.exec(part);
    const name = match?.[1];
    if (name !== undefined && name in nodes) {
      return <Fragment key={index}>{nodes[name]}</Fragment>;
    }
    return part.length > 0 ? <Fragment key={index}>{part}</Fragment> : null;
  });
}

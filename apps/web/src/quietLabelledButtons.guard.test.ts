// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * An action that stands alone must look clickable at rest (the rule is at the top of
 * components/ui/button.tsx). `ghost`, `ghost-muted` and `ghost-destructive` have no resting
 * border, fill or underline, so a Button on one of them whose children are only a label,
 * with no icon, reads as a caption: "Stop copy" in a dialog footer was the case that started
 * this. `link` is underlined at rest and is left alone.
 *
 * This guard finds every such Button and compares the count per file with EXCEPTIONS: the
 * labelled quiet Buttons that are fine because their container already shows they are
 * pressed (a tab or toggle with a pressed state, a list or menu row, a toolbar strip, a
 * disclosure). A new one fails here. Give it `outline` (or `destructive-outline` when it
 * stops or removes something), or, when it truly is one of those cases, add it to the list.
 *
 * A variant counts as quiet when any string literal it can take is quiet: `variant="ghost"`,
 * `variant={"ghost"}` and `variant={on ? "secondary" : "ghost"}` are all found. A variant
 * computed elsewhere (a variable or a prop) is not.
 */
const sourceRoot = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const QUIET_VARIANTS = new Set(["ghost", "ghost-muted", "ghost-destructive"]);

/**
 * Labelled, icon-less quiet Buttons that stay, by file (relative to apps/web/src). Each is a
 * segment of a toggle group that is `secondary` while selected and `ghost` otherwise.
 */
const EXCEPTIONS: Readonly<Record<string, number>> = {
  "components/design/editor/PropertiesPanel.tsx": 1,
  "components/device/DeviceStreamView.tsx": 2,
  "components/skills/SkillAuthoringSheet.tsx": 3,
  "components/skills/SkillDetailPanel.tsx": 1,
};

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (entry.name.endsWith(".tsx") && !/\.test\.|test-fixtures/.test(entry.name))
      found.push(path);
  }
  return found;
}

/** The index just past the `>` that closes the opening tag starting at `start`, or -1. */
function openingTagEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return index + 1;
  }
  return -1;
}

/**
 * The string literals the `name` attribute of an opening tag can take: one for `name="a"`
 * or `name={"a"}`, each branch for `name={on ? "a" : "b"}`, none when it has no literal.
 */
function attributeLiterals(tag: string, name: string): string[] {
  const attribute = new RegExp(`(?<![\\w-])${name}=`).exec(tag);
  if (!attribute) return [];
  const start = attribute.index + attribute[0].length;
  const first = tag[start];
  if (first === '"' || first === "'") {
    const end = tag.indexOf(first, start + 1);
    return end < 0 ? [] : [tag.slice(start + 1, end)];
  }
  if (first !== "{") return [];
  let depth = 0;
  let end = start;
  for (; end < tag.length; end += 1) {
    if (tag[end] === "{") depth += 1;
    else if (tag[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return Array.from(
    tag.slice(start, end).matchAll(/(["'`])([\w-]+)\1/g),
    (literal) => literal[2] ?? "",
  );
}

/** How many Buttons in `source` are on a quiet variant with only a label inside. */
function quietLabelledButtons(source: string): number {
  let count = 0;
  for (const match of source.matchAll(/<Button\b/g)) {
    const end = openingTagEnd(source, match.index);
    if (end < 0) continue;
    const tag = source.slice(match.index, end);
    // Self-closing: the label, if any, belongs to the element that renders it.
    if (tag.endsWith("/>")) continue;
    if (!attributeLiterals(tag, "variant").some((variant) => QUIET_VARIANTS.has(variant))) continue;
    const sizes = attributeLiterals(tag, "size");
    if (sizes.length > 0 && sizes.every((size) => size.startsWith("icon"))) continue;
    const close = source.indexOf("</Button>", end);
    if (close < 0) continue;
    const children = source.slice(end, close).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    // An element inside is an icon, a badge or a nested layout: the guard leaves those alone.
    if (/<[A-Za-z]/.test(children)) continue;
    if (children.trim() === "") continue;
    count += 1;
  }
  return count;
}

describe("labelled buttons rest on a border or a fill", () => {
  it("counts a label-only quiet Button and skips icon, bordered and icon-only ones", () => {
    expect(
      quietLabelledButtons(`<Button variant="ghost" onClick={() => go()}>Stop copy</Button>`),
    ).toBe(1);
    expect(quietLabelledButtons(`<Button variant="ghost-muted">{tx("Change")}</Button>`)).toBe(1);
    expect(quietLabelledButtons(`<Button variant="link">{tx("Change")}</Button>`)).toBe(0);
    expect(quietLabelledButtons(`<Button variant="outline">Stop copy</Button>`)).toBe(0);
    expect(quietLabelledButtons(`<Button variant="ghost"><XIcon /> Close</Button>`)).toBe(0);
    expect(quietLabelledButtons(`<Button variant="ghost" size="icon-xs">×</Button>`)).toBe(0);
    expect(
      quietLabelledButtons(`<Trigger render={<Button variant="ghost" />}>More</Trigger>`),
    ).toBe(0);
  });

  it("finds a quiet variant written as an expression", () => {
    for (const variant of QUIET_VARIANTS) {
      expect(quietLabelledButtons(`<Button variant="${variant}">Stop copy</Button>`)).toBe(1);
      expect(quietLabelledButtons(`<Button variant={"${variant}"}>Stop copy</Button>`)).toBe(1);
      expect(quietLabelledButtons(`<Button variant={'${variant}'}>Stop copy</Button>`)).toBe(1);
      expect(
        quietLabelledButtons(`<Button variant={on ? "secondary" : "${variant}"}>Flat</Button>`),
      ).toBe(1);
    }
    expect(quietLabelledButtons(`<Button variant={"outline"}>Stop copy</Button>`)).toBe(0);
    expect(quietLabelledButtons(`<Button variant={tone}>Stop copy</Button>`)).toBe(0);
    expect(quietLabelledButtons(`<Button data-variant="ghost">Stop copy</Button>`)).toBe(0);
    expect(quietLabelledButtons(`<Button variant="ghost" size={"icon-xs"}>×</Button>`)).toBe(0);
    expect(
      quietLabelledButtons(`<Button variant="ghost" size={small ? "icon-xs" : "sm"}>Go</Button>`),
    ).toBe(1);
  });

  it("finds no new label-only Button on a quiet variant", () => {
    const actual: Record<string, number> = {};
    for (const file of sourceFiles(sourceRoot)) {
      const count = quietLabelledButtons(NodeFS.readFileSync(file, "utf8"));
      if (count > 0)
        actual[NodePath.relative(sourceRoot, file).split(NodePath.sep).join("/")] = count;
    }
    expect(
      actual,
      "A Button with only a label on ghost, ghost-muted or ghost-destructive looks like a caption. " +
        "Use outline (destructive-outline when it stops or removes something); see the rule in components/ui/button.tsx. " +
        "If its container already shows it is pressed (tab, toggle, row, toolbar), record it in EXCEPTIONS.",
    ).toEqual(EXCEPTIONS);
  });
});

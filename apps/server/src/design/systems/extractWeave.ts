/**
 * Weave-style `tokens.json`: named sections (`color`, `spacing`, `radius`,
 * `shadow`, `layout`, `motion`, any other with a `tokens` array), per-theme
 * values from `color.themes`, `usage` notes, and type styles under
 * `type.groups[].styles`. Read with jsonc-parser so each token keeps its line.
 *
 * Weave keeps its tokens twice, in `tokens.json` and in `weave.css`, and sites
 * keep copies of `weave.css`. Both are hand-maintained, so this module also
 * compares them: value mismatches between the JSON and the CSS, names only in
 * one of them, and copies that differ from the canonical file (drift).
 */
import { type Node as JsonNode, getNodeValue, parseTree } from "jsonc-parser";
import postcss, { type AtRule, type Container } from "postcss";

import type { DesignSystemFinding, DesignTokenType } from "@specweave-studio/contracts";

import { commonPrefix } from "./classify.ts";
import {
  type Collected,
  type ExtractedMode,
  type MutableToken,
  type SourceText,
  clip,
  compareText,
  finding,
  lineIndex,
  modeName,
  provenance,
  assertJsonDepth,
} from "./common.ts";

export const WEAVE_EXTRACTOR = "weave-json@1";

const SECTION_TYPES: Record<string, DesignTokenType | undefined> = {
  color: "color",
  shadow: "shadow",
  spacing: "dimension",
  radius: "dimension",
  layout: undefined,
  motion: undefined,
};

const child = (node: JsonNode | undefined, key: string): JsonNode | undefined =>
  node?.type === "object"
    ? node.children?.find((property) => property.children?.[0]?.value === key)?.children?.[1]
    : undefined;

const stringAt = (node: JsonNode | undefined, key: string): string | undefined => {
  const value = child(node, key);
  return value?.type === "string" ? String(value.value) : undefined;
};

/** True for a Weave-style tokens file (sections of `{ name, value, usage }` lists). */
export const isWeaveTokens = (text: string): boolean => {
  if (!/"tokens"\s*:\s*\[/.test(text) || !/"usage"\s*:/.test(text)) return false;
  assertJsonDepth(text);
  const root = parseTree(text);
  const tokens = child(child(root, "color"), "tokens");
  return (
    tokens?.type === "array" &&
    (tokens.children ?? []).some((item) => stringAt(item, "name") !== undefined)
  );
};

export const collectWeave = (source: SourceText): Collected => {
  assertJsonDepth(source.text);
  const root = parseTree(source.text, [], { allowTrailingComma: true });
  const position = lineIndex(source.text);
  if (root?.type !== "object") {
    return {
      modes: [],
      tokens: [],
      components: [],
      findings: [finding("parse", "warning", "Not a Weave tokens file", source.path)],
    };
  }
  const themesNode = child(child(root, "color"), "themes");
  const modes: ExtractedMode[] = [];
  for (const theme of themesNode?.children ?? []) {
    const id = stringAt(theme, "id");
    if (id) modes.push({ id, name: stringAt(theme, "name") ?? modeName(id) });
  }
  if (modes.length === 0) modes.push({ id: "default", name: "Default" });
  const baseMode = modes[0]!.id;
  const tokens = new Map<string, MutableToken>();
  const findings: DesignSystemFinding[] = [];

  const put = (
    name: string,
    type: DesignTokenType | undefined,
    group: string,
    valueNode: JsonNode,
    description: string | undefined,
    context: string,
    allModes: boolean,
  ) => {
    const token: MutableToken = tokens.get(name) ?? {
      name,
      type: type ?? "other",
      group,
      values: {},
      explicitType: type !== undefined,
      ...(description ? { description: clip(description) } : {}),
    };
    const at = (node: JsonNode, mode: string) => {
      token.values[mode] = {
        raw: clip(String(getNodeValue(node))),
        resolved: null,
        provenance: provenance(
          source,
          WEAVE_EXTRACTOR,
          position(node.offset),
          `${context}.${mode}`,
        ),
      };
    };
    if (valueNode.type === "object") {
      for (const mode of modes) {
        const perMode = child(valueNode, mode.id);
        if (perMode) at(perMode, mode.id);
      }
    } else if (allModes) {
      for (const mode of modes) at(valueNode, mode.id);
    } else {
      at(valueNode, baseMode);
    }
    tokens.set(name, token);
  };

  for (const property of root.children ?? []) {
    const section = property.children?.[0]?.value;
    const body = property.children?.[1];
    if (typeof section !== "string" || section === "type") continue;
    const list = child(body, "tokens");
    if (list?.type !== "array") continue;
    for (const [index, item] of (list.children ?? []).entries()) {
      const name = stringAt(item, "name");
      const value = child(item, "value");
      if (!name || !value) continue;
      put(
        name,
        SECTION_TYPES[section],
        section,
        value,
        stringAt(item, "usage"),
        `${section}.tokens[${index}]`,
        section === "color",
      );
    }
  }

  // Type: families become font tokens, styles become typography tokens.
  const type = child(root, "type");
  const prefix = commonPrefix([...tokens.keys()]);
  const families = child(type, "families");
  const familyNames = new Map<string, string>();
  for (const property of families?.children ?? []) {
    const key = property.children?.[0]?.value;
    const value = property.children?.[1];
    if (typeof key !== "string" || value?.type !== "string") continue;
    const name = `${prefix}font-${key}`;
    familyNames.set(key, name);
    put(name, "fontFamily", "type", value, undefined, `type.families.${key}`, false);
  }
  for (const [groupIndex, group] of (child(type, "groups")?.children ?? []).entries()) {
    const family = stringAt(group, "family");
    for (const [styleIndex, style] of (child(group, "styles")?.children ?? []).entries()) {
      const name = stringAt(style, "name");
      if (!name) continue;
      const read = (key: string) => {
        const node = child(style, key);
        return node === undefined ? undefined : String(getNodeValue(node));
      };
      const familyToken = family ? familyNames.get(family) : undefined;
      const shorthand = [
        read("fontWeight") ?? "400",
        `${read("fontSize") ?? "16px"}${read("lineHeight") ? `/${read("lineHeight")}` : ""}`,
        familyToken ? `var(--${familyToken})` : (family ?? "sans-serif"),
      ].join(" ");
      const letterSpacing = read("letterSpacing");
      const usage = stringAt(style, "usage");
      const description = [usage, letterSpacing ? `Letter spacing ${letterSpacing}.` : undefined]
        .filter(Boolean)
        .join(" ");
      const token: MutableToken = {
        name,
        type: "typography",
        group: "type",
        explicitType: true,
        values: {
          [baseMode]: {
            raw: clip(shorthand),
            resolved: null,
            provenance: provenance(
              source,
              WEAVE_EXTRACTOR,
              position(style.offset),
              `type.groups[${groupIndex}].styles[${styleIndex}]`,
            ),
          },
        },
        ...(description ? { description: clip(description) } : {}),
      };
      tokens.set(name, token);
    }
  }

  return {
    modes,
    tokens: [...tokens.values()].sort((left, right) => compareText(left.name, right.name)),
    components: [],
    findings,
  };
};

/**
 * Compares `tokens.json` with its `weave.css`: values per mode, and names
 * that only one of them declares. Type styles that have no CSS variables are
 * summarized in one finding.
 */
export const crossCheckWeave = (
  json: Collected,
  css: Collected,
  cssPath: string,
): DesignSystemFinding[] => {
  const findings: DesignSystemFinding[] = [];
  const cssTokens = new Map(css.tokens.map((token) => [token.name, token]));
  const jsonTokens = new Map(json.tokens.map((token) => [token.name, token]));
  const onlyInJson: string[] = [];
  for (const token of json.tokens) {
    const other = cssTokens.get(token.name);
    if (other === undefined) {
      onlyInJson.push(token.name);
      continue;
    }
    for (const [mode, value] of Object.entries(token.values).sort(([left], [right]) =>
      compareText(left, right),
    )) {
      const cssValue =
        other.values[mode] ??
        (Object.keys(other.values).length === 1 ? Object.values(other.values)[0] : undefined);
      if (cssValue === undefined) continue;
      if (cssValue.raw.replace(/\s+/g, "") !== value.raw.replace(/\s+/g, "")) {
        findings.push(
          finding(
            "mismatch",
            "warning",
            `${token.name} (${mode}) is ${value.raw} in ${value.provenance.location} but ${cssValue.raw} in ${cssPath}`,
            cssPath,
            cssValue.provenance.line,
          ),
        );
      }
    }
  }
  for (const token of css.tokens) {
    if (!jsonTokens.has(token.name)) {
      const value = Object.values(token.values)[0];
      findings.push(
        finding(
          "only-in-css",
          "warning",
          `--${token.name} is in ${cssPath} but not in tokens.json`,
          cssPath,
          value?.provenance.line,
        ),
      );
    }
  }
  if (onlyInJson.length > 0) {
    findings.push(
      finding(
        "only-in-json",
        "info",
        `${onlyInJson.length} ${onlyInJson.length === 1 ? "token is" : "tokens are"} only in tokens.json, with no CSS variable: ${onlyInJson.sort(compareText).slice(0, 12).join(", ")}${onlyInJson.length > 12 ? ", ..." : ""}`,
        json.tokens[0]?.values[Object.keys(json.tokens[0].values)[0]!]?.provenance.location,
      ),
    );
  }
  return findings;
};

interface RuleShape {
  readonly key: string;
  readonly line: number;
  readonly body: string;
}

const ruleShapes = (
  text: string,
): { custom: Map<string, RuleShape>; rules: Map<string, RuleShape> } => {
  const custom = new Map<string, RuleShape>();
  const rules = new Map<string, RuleShape>();
  const root = postcss.parse(text, { from: undefined });
  root.walkRules((rule) => {
    const context: string[] = [];
    for (
      let parent = rule.parent as Container | undefined;
      parent && parent.type !== "root";
      parent = parent.parent as Container | undefined
    ) {
      if (parent.type === "atrule")
        context.unshift(`@${(parent as AtRule).name} ${(parent as AtRule).params}`);
    }
    const selector = [...context, rule.selector.replace(/\s+/g, " ")].join(" ");
    const plain: string[] = [];
    rule.each((node) => {
      if (node.type !== "decl") return;
      if (node.prop.startsWith("--")) {
        custom.set(`${selector}|${node.prop}`, {
          key: node.prop,
          line: node.source?.start?.line ?? 0,
          body: node.value.trim(),
        });
      } else {
        plain.push(
          `${node.prop}:${node.value.replace(/\s+/g, " ").trim()}${node.important ? "!important" : ""}`,
        );
      }
    });
    if (plain.length > 0)
      rules.set(selector, {
        key: selector,
        line: rule.source?.start?.line ?? 0,
        body: plain.join(";"),
      });
  });
  return { custom, rules };
};

/**
 * Drift of a copy of the canonical stylesheet: identical bytes report nothing;
 * otherwise each added, removed or changed custom property and each changed
 * component rule becomes a finding at the copy's line.
 */
export const weaveCopyDrift = (canonical: SourceText, copy: SourceText): DesignSystemFinding[] => {
  if (canonical.sha256 === copy.sha256) return [];
  let left;
  let right;
  try {
    left = ruleShapes(canonical.text);
    right = ruleShapes(copy.text);
  } catch {
    return [
      finding(
        "drift",
        "warning",
        `${copy.path} differs from ${canonical.path} and could not be parsed`,
        copy.path,
      ),
    ];
  }
  const findings: DesignSystemFinding[] = [];
  const addedNames = new Map<string, number[]>();
  for (const [key, shape] of right.custom) {
    const original = left.custom.get(key);
    if (original === undefined) {
      const lines = addedNames.get(shape.key) ?? [];
      lines.push(shape.line);
      addedNames.set(shape.key, lines);
    } else if (original.body !== shape.body) {
      findings.push(
        finding(
          "drift",
          "warning",
          `${shape.key} is ${shape.body} in ${copy.path} but ${original.body} in ${canonical.path}`,
          copy.path,
          shape.line,
        ),
      );
    }
  }
  for (const [name, lines] of [...addedNames].sort(([a], [b]) => compareText(a, b))) {
    const inCanonical = [...left.custom.values()].some((shape) => shape.key === name);
    findings.push(
      finding(
        "drift",
        "warning",
        inCanonical
          ? `${name} is declared in more places in ${copy.path} (lines ${lines.join(", ")}) than in ${canonical.path}`
          : `${name} is only in ${copy.path} (lines ${lines.join(", ")}), not in canonical ${canonical.path}`,
        copy.path,
        lines[0],
      ),
    );
  }
  const removed = [...left.custom.values()].filter(
    (shape) => ![...right.custom.values()].some((other) => other.key === shape.key),
  );
  for (const name of [...new Set(removed.map((shape) => shape.key))].sort(compareText)) {
    findings.push(
      finding(
        "drift",
        "warning",
        `${name} from ${canonical.path} is missing in ${copy.path}`,
        copy.path,
      ),
    );
  }
  for (const [selector, shape] of right.rules) {
    const original = left.rules.get(selector);
    if (original === undefined) {
      findings.push(
        finding(
          "drift",
          "warning",
          `Rule ${selector} is only in ${copy.path}`,
          copy.path,
          shape.line,
        ),
      );
    } else if (original.body !== shape.body) {
      findings.push(
        finding(
          "drift",
          "warning",
          `Rule ${selector} differs from ${canonical.path} (${original.body} -> ${shape.body})`,
          copy.path,
          shape.line,
        ),
      );
    }
  }
  for (const [selector] of left.rules) {
    if (!right.rules.has(selector))
      findings.push(
        finding(
          "drift",
          "warning",
          `Rule ${selector} from ${canonical.path} is missing in ${copy.path}`,
          copy.path,
        ),
      );
  }
  return findings;
};

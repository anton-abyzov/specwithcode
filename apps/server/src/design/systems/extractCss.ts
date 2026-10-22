/**
 * CSS custom properties with their mode. Root-like rules (`:root`, `html`,
 * `:host`, Tailwind v4 `@theme`) hold the base mode; `.dark`,
 * `[data-theme="dark"]`, `@variant dark` and `@media (prefers-color-scheme:
 * dark)` hold dark; other `[data-theme="x"]` values become their own mode.
 * The prefers-color-scheme copy is a fallback: when an explicit dark rule
 * exists it is only compared, and a difference is reported. Custom properties
 * scoped to component classes or responsive media are counted, not imported.
 */
import postcss, { type AtRule, type Container, type Declaration, type Rule } from "postcss";

import type { DesignSystemFinding } from "@specweave-studio/contracts";

import {
  type Collected,
  type MutableToken,
  type SourceText,
  clip,
  compareText,
  finding,
  modeName,
  provenance,
  customPropertyNames,
  singleLine,
} from "./common.ts";

export const CSS_EXTRACTOR = "css@1";

const ROOT_LIKE = /^(?::root|html|:host|body|\*|&)?$/;

interface SelectorMode {
  /** `base`, `dark`, `light`, or a named mode. */
  readonly mode: string;
}

const THEME_ATTRIBUTE = "(?:theme|mode|color-scheme|theme-id|appearance)";

/**
 * What a selector's attributes say: a named mode (`[data-theme=dark]`), the
 * base for a theme attribute without a value (`[data-theme]` matches every
 * theme), or `scope` for any other attribute, which marks a sub-tree such as
 * `[data-app-sidebar]` rather than a theme.
 */
const attributeMode = (part: string): string | "scope" | null => {
  const valued = new RegExp(
    `\\[data-${THEME_ATTRIBUTE}\\s*=\\s*["']?([A-Za-z0-9_-]+)["']?\\s*\\]`,
    "i",
  ).exec(part);
  if (valued) return valued[1]!.toLowerCase();
  const others = part
    .replace(new RegExp(`\\[data-${THEME_ATTRIBUTE}\\s*\\]`, "gi"), "")
    .match(/\[[^\]]*\]/g);
  return others ? "scope" : null;
};

/** Mode of one selector in a list, or null when it is not a root-like rule. */
const selectorMode = (selector: string): SelectorMode | null => {
  const withoutNot = selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "");
  let mode = "base";
  if (/\.dark\b|\.theme-dark\b/.test(withoutNot)) mode = "dark";
  else if (/\.light\b|\.theme-light\b/.test(withoutNot)) mode = "light";
  const attribute = attributeMode(withoutNot);
  if (attribute === "scope") return null;
  if (attribute) mode = attribute;
  const rest = withoutNot
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\.(?:dark|light|theme-dark|theme-light)\b/g, "")
    .replace(/:(?:where|is)\(\s*\)/g, "")
    .replace(/\s+/g, "")
    .replace(/^(?::root|html|:host|body)(?=:root|html|:host|body)/, "");
  return ROOT_LIKE.test(rest) ? { mode } : null;
};

const splitSelectors = (selector: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
};

type Placement =
  | {
      readonly kind: "token";
      readonly modes: ReadonlyArray<string>;
      readonly fallback: boolean;
      readonly context: string;
    }
  | { readonly kind: "component"; readonly selector: string }
  | { readonly kind: "responsive" }
  | { readonly kind: "ignored" };

const placementOf = (declaration: Declaration): Placement => {
  const chain: Array<AtRule | Rule> = [];
  for (
    let parent = declaration.parent as Container | undefined;
    parent && parent.type !== "root";
    parent = parent.parent as Container | undefined
  ) {
    if (parent.type === "atrule" || parent.type === "rule") chain.unshift(parent as AtRule | Rule);
  }
  let modes: string[] = ["base"];
  let fallback = false;
  const context: string[] = [];
  for (const node of chain) {
    if (node.type === "atrule") {
      const atRule = node as AtRule;
      const name = atRule.name.toLowerCase();
      const params = atRule.params.trim();
      context.push(`@${name}${params ? ` ${params}` : ""}`);
      if (name === "media") {
        if (/prefers-color-scheme\s*:\s*dark/i.test(params)) {
          modes = ["dark"];
          fallback = true;
        } else if (/prefers-color-scheme\s*:\s*light/i.test(params)) {
          modes = ["light"];
          fallback = true;
        } else {
          return { kind: "responsive" };
        }
      } else if (name === "variant" || name === "custom-variant") {
        if (name === "custom-variant") return { kind: "ignored" };
        modes = [
          params.toLowerCase() === "dark"
            ? "dark"
            : params.toLowerCase() === "light"
              ? "light"
              : params,
        ];
      } else if (name === "theme" || name === "layer" || name === "supports" || name === "scope") {
        continue;
      } else {
        return { kind: "ignored" };
      }
    } else {
      const selector = node.selector;
      context.push(selector.replace(/\s+/g, " "));
      const parts = splitSelectors(selector).map(selectorMode);
      if (parts.some((part) => part === null)) {
        return { kind: "component", selector: selector.replace(/\s+/g, " ") };
      }
      const named = [...new Set(parts.map((part) => part!.mode))];
      // A nested rule refines the outer mode; base keeps what the outer chose.
      const refined = named.filter((mode) => mode !== "base");
      if (refined.length > 0) {
        if (!(fallback && refined.every((mode) => mode === "light"))) modes = refined;
      }
    }
  }
  return { kind: "token", modes, fallback, context: context.join(" ") || ":root" };
};

const normalizeValue = singleLine;

/** Reads every custom property of one CSS file. Values are unresolved here. */
export const collectCss = (source: SourceText): Collected => {
  const findings: DesignSystemFinding[] = [];
  let root;
  try {
    root = postcss.parse(source.text, { from: undefined });
  } catch (error) {
    const line = (error as { line?: number }).line;
    return {
      modes: [],
      tokens: [],
      components: [],
      findings: [
        finding(
          "parse",
          "warning",
          `Could not parse CSS: ${(error as Error).message.split("\n")[0]}`,
          source.path,
          line,
        ),
      ],
    };
  }

  const explicit = new Map<string, Map<string, MutableToken["values"][string]>>();
  const fallbacks = new Map<string, Map<string, MutableToken["values"][string]>>();
  const componentScoped = new Map<string, number>();
  let responsive = 0;

  root.walkDecls((declaration) => {
    if (!declaration.prop.startsWith("--")) return;
    const name = declaration.prop.slice(2);
    if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > 200) return;
    const placement = placementOf(declaration);
    if (placement.kind === "component") {
      componentScoped.set(placement.selector, (componentScoped.get(placement.selector) ?? 0) + 1);
      return;
    }
    if (placement.kind === "responsive") {
      responsive += 1;
      return;
    }
    if (placement.kind === "ignored") return;
    const raw = normalizeValue(declaration.value);
    if (raw === "initial") return;
    const start = declaration.source?.start;
    const value = {
      raw: clip(raw),
      resolved: null,
      provenance: provenance(
        source,
        CSS_EXTRACTOR,
        start ? { line: start.line, column: start.column } : undefined,
        placement.context,
      ),
    };
    const target = placement.fallback ? fallbacks : explicit;
    for (const mode of placement.modes) {
      const byName = target.get(mode) ?? new Map();
      byName.set(name, value);
      target.set(mode, byName);
    }
  });

  for (const [mode, byName] of [...fallbacks].sort(([left], [right]) => compareText(left, right))) {
    const declared = explicit.get(mode);
    if (declared === undefined) {
      explicit.set(mode, byName);
      continue;
    }
    for (const [name, value] of [...byName].sort(([left], [right]) => compareText(left, right))) {
      const other = declared.get(name);
      if (other === undefined) {
        findings.push(
          finding(
            "mismatch",
            "warning",
            `--${name} is set for ${mode} only by the prefers-color-scheme fallback, not by the explicit ${mode} rule`,
            source.path,
            value.provenance.line,
          ),
        );
      } else if (other.raw !== value.raw) {
        findings.push(
          finding(
            "mismatch",
            "warning",
            `--${name} differs between the explicit ${mode} rule (${other.raw}) and the prefers-color-scheme fallback (${value.raw})`,
            source.path,
            value.provenance.line,
          ),
        );
      }
    }
  }

  const modeIds = [...explicit.keys()];
  const hasLightDark = modeIds.some((mode) => mode === "light" || mode === "dark");
  const baseId = hasLightDark ? "light" : "default";
  const tokens = new Map<string, MutableToken>();
  for (const [mode, byName] of explicit) {
    const id = mode === "base" ? baseId : mode;
    for (const [name, value] of byName) {
      const token = tokens.get(name) ?? { name, type: "other" as const, values: {} };
      // The explicit rule for the base id (`[data-theme="light"]`) wins over `:root`.
      if (token.values[id] === undefined || mode !== "base") token.values[id] = value;
      tokens.set(name, token);
    }
  }

  if (componentScoped.size > 0) {
    const selectors = [...componentScoped.keys()].sort(compareText);
    const count = [...componentScoped.values()].reduce((sum, value) => sum + value, 0);
    findings.push(
      finding(
        "skipped",
        "info",
        `${count} custom ${count === 1 ? "property" : "properties"} scoped to component rules (${selectors.slice(0, 6).join(", ")}${selectors.length > 6 ? ", ..." : ""}) ${count === 1 ? "is" : "are"} component-local and not imported as tokens`,
        source.path,
      ),
    );
  }
  if (responsive > 0) {
    findings.push(
      finding(
        "skipped",
        "info",
        `${responsive} custom ${responsive === 1 ? "property" : "properties"} inside responsive @media blocks ${responsive === 1 ? "was" : "were"} not imported as modes`,
        source.path,
      ),
    );
  }

  const ids = [...new Set([...tokens.values()].flatMap((token) => Object.keys(token.values)))];
  const ordered = ids.sort((left, right) =>
    left === baseId ? -1 : right === baseId ? 1 : compareText(left, right),
  );
  return {
    modes: ordered.map((id) => ({ id, name: modeName(id) })),
    tokens: [...tokens.values()].sort((left, right) => compareText(left.name, right.name)),
    components: [],
    findings,
  };
};

/** Counts custom properties without building tokens (used by the scan). */
export const countCssCustomProperties = (text: string): number => {
  return new Set(customPropertyNames(text)).size;
};

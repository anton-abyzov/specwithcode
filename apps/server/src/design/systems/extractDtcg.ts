/**
 * Token JSON: W3C design tokens (`$value`, `$type`, `$description`; Figma's
 * variables export uses this format), and the older `value`/`type` form of
 * Tokens Studio and Style Dictionary. Read with jsonc-parser so every token
 * keeps its line and column. Groups pass `$type` down to their tokens;
 * `{group.token}` references are resolved later, per mode.
 *
 * Modes: one file is one mode. A Figma export names its files
 * `<Collection>.<Mode>.tokens.json`, so the collection becomes the token group
 * and the mode comes from the name. A Tokens Studio file with `$themes` gives
 * one mode per theme, built from the sets that theme enables, in set order.
 */
import {
  type Node as JsonNode,
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  type ParseError,
} from "jsonc-parser";

import type {
  DesignProvenance,
  DesignSystemFinding,
  DesignTokenType,
} from "@specweave-studio/contracts";

import {
  type Collected,
  type ExtractedMode,
  type MutableToken,
  type SourceText,
  clip,
  compareText,
  finding,
  kebabCase,
  lineIndex,
  modeName,
  provenance,
  safeId,
  assertJsonDepth,
} from "./common.ts";

export const DTCG_EXTRACTOR = "dtcg@1";

export interface DtcgOptions {
  /** `figma-export` records provenance as `<file name>#<variable path>`. */
  readonly origin?: "file" | "figma-export";
  /** Overrides the mode taken from the file name. */
  readonly mode?: string;
}

const TYPE_MAP: Record<string, DesignTokenType> = {
  color: "color",
  dimension: "dimension",
  spacing: "dimension",
  sizing: "dimension",
  size: "dimension",
  borderradius: "dimension",
  borderwidth: "dimension",
  fontfamily: "fontFamily",
  fontfamilies: "fontFamily",
  fontweight: "fontWeight",
  fontweights: "fontWeight",
  fontsize: "dimension",
  fontsizes: "dimension",
  lineheight: "dimension",
  lineheights: "dimension",
  letterspacing: "dimension",
  duration: "duration",
  cubicbezier: "easing",
  easing: "easing",
  number: "number",
  opacity: "number",
  float: "number",
  shadow: "shadow",
  boxshadow: "shadow",
  typography: "typography",
  string: "other",
  boolean: "other",
};

/** `color.brand.500` -> `color-brand-500`; Figma names (`Brand/Primary`) -> `brand-primary`. */
export const tokenNameFromPath = (path: ReadonlyArray<string>): string =>
  path
    .map((segment) => kebabCase(segment.replace(/\//g, "-")))
    .filter(Boolean)
    .join("-");

export const referenceName = (reference: string): string => tokenNameFromPath(reference.split("."));

/** `Colors.Dark.tokens.json` -> collection `Colors`, mode `Dark`. */
export const modeFromFileName = (fileName: string): { collection?: string; mode?: string } => {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const stem = base.replace(/\.(?:tokens\.)?json$/i, "").replace(/\.tokens$/i, "");
  const parts = stem.split(".");
  if (parts.length >= 2) return { collection: parts.slice(0, -1).join("."), mode: parts.at(-1)! };
  if (/\.tokens\.json$/i.test(base) && parts.length === 1) return { mode: parts[0]! };
  return {};
};

const quoteFamily = (family: string) =>
  /[\s]/.test(family) && !/^["']/.test(family) ? `"${family}"` : family;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const dimensionText = (value: unknown): string => {
  if (value !== null && typeof value === "object" && "value" in (value as object)) {
    const record = value as { value: unknown; unit?: unknown };
    return `${String(record.value)}${typeof record.unit === "string" ? record.unit : ""}`;
  }
  return String(value);
};

const colorText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as {
      colorSpace?: unknown;
      components?: unknown;
      alpha?: unknown;
      hex?: unknown;
    };
    const alpha = typeof record.alpha === "number" && record.alpha !== 1 ? record.alpha : undefined;
    if (typeof record.hex === "string") {
      if (alpha === undefined) return record.hex;
      return `${record.hex}${Math.round(alpha * 255)
        .toString(16)
        .padStart(2, "0")}`;
    }
    if (Array.isArray(record.components)) {
      const space = typeof record.colorSpace === "string" ? record.colorSpace : "srgb";
      const components = record.components.map((component) => String(component)).join(" ");
      return `color(${space} ${components}${alpha !== undefined ? ` / ${alpha}` : ""})`;
    }
  }
  return canonicalJson(value);
};

const shadowText = (value: unknown): string => {
  const one = (shadow: unknown): string => {
    if (shadow === null || typeof shadow !== "object") return String(shadow);
    const record = shadow as Record<string, unknown>;
    const parts = [
      record.inset === true || record.type === "innerShadow" ? "inset" : "",
      dimensionText(record.offsetX ?? record.x ?? 0),
      dimensionText(record.offsetY ?? record.y ?? 0),
      dimensionText(record.blur ?? 0),
      dimensionText(record.spread ?? 0),
      colorText(record.color ?? "transparent"),
    ];
    return parts.filter(Boolean).join(" ");
  };
  return Array.isArray(value) ? value.map(one).join(", ") : one(value);
};

/** Turns a token value of any DTCG type into the CSS-ish text stored as `raw`. */
export const valueText = (value: unknown, type: DesignTokenType | undefined): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  switch (type) {
    case "color":
      return colorText(value);
    case "dimension":
    case "duration":
      return dimensionText(value);
    case "fontFamily":
      return Array.isArray(value)
        ? value.map((family) => quoteFamily(String(family))).join(", ")
        : canonicalJson(value);
    case "easing":
      return Array.isArray(value) && value.length === 4
        ? `cubic-bezier(${value.join(", ")})`
        : canonicalJson(value);
    case "shadow":
      return shadowText(value);
    default:
      if (
        value !== null &&
        typeof value === "object" &&
        "value" in (value as object) &&
        "unit" in (value as object)
      ) {
        return dimensionText(value);
      }
      return canonicalJson(value);
  }
};

const childByKey = (node: JsonNode | undefined, key: string): JsonNode | undefined =>
  node?.type === "object"
    ? node.children?.find((property) => property.children?.[0]?.value === key)?.children?.[1]
    : undefined;

const isTokenNode = (node: JsonNode, form: "dtcg" | "legacy") => {
  if (node.type !== "object") return false;
  if (childByKey(node, "$value") !== undefined) return true;
  if (form !== "legacy") return false;
  const value = childByKey(node, "value");
  return (
    value !== undefined &&
    (value.type !== "object" ||
      childByKey(value, "value") === undefined ||
      childByKey(node, "type") !== undefined)
  );
};

interface Walked {
  readonly path: string[];
  readonly node: JsonNode;
  readonly type: DesignTokenType | undefined;
}

const walkTokens = (
  node: JsonNode,
  form: "dtcg" | "legacy",
  path: string[],
  inherited: DesignTokenType | undefined,
  out: Walked[],
) => {
  if (node.type !== "object") return;
  const typeNode =
    childByKey(node, "$type") ?? (form === "legacy" ? childByKey(node, "type") : undefined);
  const declaredType =
    typeNode?.type === "string"
      ? TYPE_MAP[
          String(typeNode.value)
            .toLowerCase()
            .replace(/[^a-z]/g, "")
        ]
      : undefined;
  const type = declaredType ?? inherited;
  if (isTokenNode(node, form)) {
    out.push({ path, node, type });
    return;
  }
  for (const property of node.children ?? []) {
    const key = property.children?.[0]?.value;
    const child = property.children?.[1];
    if (typeof key !== "string" || child === undefined || key.startsWith("$")) continue;
    walkTokens(child, form, [...path, key], type, out);
  }
};

interface SetSelection {
  readonly mode: string;
  readonly sets: ReadonlyArray<string>;
}

/** Tokens Studio themes: which sets make up each mode. */
const tokensStudioThemes = (root: JsonNode): SetSelection[] | null => {
  const themes = childByKey(root, "$themes");
  if (themes?.type !== "array" || (themes.children?.length ?? 0) === 0) return null;
  const order = getNodeValue(findNodeAtLocation(root, ["$metadata", "tokenSetOrder"]) ?? root);
  const setOrder: string[] = Array.isArray(order)
    ? order.filter((item): item is string => typeof item === "string")
    : [];
  const result: SetSelection[] = [];
  for (const theme of themes.children ?? []) {
    const value = getNodeValue(theme) as {
      name?: unknown;
      selectedTokenSets?: Record<string, unknown>;
    };
    if (typeof value?.name !== "string" || value.selectedTokenSets === undefined) continue;
    const enabled = Object.entries(value.selectedTokenSets)
      .filter(([, status]) => status === "enabled" || status === "source")
      .map(([set]) => set);
    const ordered = [
      ...setOrder.filter((set) => enabled.includes(set)),
      ...enabled.filter((set) => !setOrder.includes(set)).sort(compareText),
    ];
    result.push({ mode: safeId(value.name, "theme"), sets: ordered });
  }
  return result.length > 0 ? result : null;
};

export const detectTokenJson = (text: string): "dtcg" | "legacy" | null => {
  if (/"\$value"\s*:/.test(text)) return "dtcg";
  if (/"\$themes"\s*:/.test(text) || /"value"\s*:/.test(text)) return "legacy";
  return null;
};

export const collectDtcg = (source: SourceText, options: DtcgOptions = {}): Collected => {
  const errors: ParseError[] = [];
  assertJsonDepth(source.text);
  const root = parseTree(source.text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const position = lineIndex(source.text);
  if (root === undefined || root.type !== "object") {
    return {
      modes: [],
      tokens: [],
      components: [],
      findings: [finding("parse", "warning", "Not a JSON object of tokens", source.path)],
    };
  }
  const findings: DesignSystemFinding[] = errors
    .slice(0, 5)
    .map((error) =>
      finding(
        "parse",
        "warning",
        `JSON syntax error ${error.error}`,
        source.path,
        position(error.offset).line,
      ),
    );
  const form = detectTokenJson(source.text) ?? "dtcg";
  const fromName = modeFromFileName(source.path);
  const collection = fromName.collection ? safeId(fromName.collection) : undefined;
  const origin = options.origin ?? "file";

  const selections: SetSelection[] = tokensStudioThemes(root) ?? [
    { mode: safeId(options.mode ?? fromName.mode ?? "default", "default"), sets: [] },
  ];

  const tokens = new Map<string, MutableToken>();
  const modes: ExtractedMode[] = [];
  for (const selection of selections) {
    modes.push({ id: selection.mode, name: modeName(selection.mode) });
    const roots: Array<{ node: JsonNode; path: string[] }> =
      selection.sets.length === 0
        ? [{ node: root, path: [] }]
        : selection.sets.flatMap((set) => {
            const node = childByKey(root, set);
            return node ? [{ node, path: [set] }] : [];
          });
    for (const { node, path: setPath } of roots) {
      const walked: Walked[] = [];
      walkTokens(node, form, [], undefined, walked);
      for (const item of walked) {
        const valueNode = childByKey(item.node, "$value") ?? childByKey(item.node, "value")!;
        const descriptionNode =
          childByKey(item.node, "$description") ?? childByKey(item.node, "description");
        const name = tokenNameFromPath(item.path);
        if (name.length === 0 || name.length > 200) continue;
        const raw = valueText(getNodeValue(valueNode), item.type);
        const variablePath = item.path.join("/");
        const where: DesignProvenance =
          origin === "figma-export"
            ? provenance(
                source,
                DTCG_EXTRACTOR,
                position(valueNode.offset),
                [...setPath, ...item.path].join("."),
                "figma-export",
                `${source.path}#${variablePath}`,
              )
            : provenance(
                source,
                DTCG_EXTRACTOR,
                position(valueNode.offset),
                [...setPath, ...item.path].join("."),
              );
        const token = tokens.get(name) ?? {
          name,
          type: item.type ?? "other",
          values: {},
          explicitType: item.type !== undefined,
          ...(collection ? { group: collection } : {}),
        };
        if (descriptionNode?.type === "string" && token.description === undefined) {
          token.description = clip(String(descriptionNode.value), 2_000);
        }
        token.values[selection.mode] = { raw: clip(raw), resolved: null, provenance: where };
        tokens.set(name, token);
      }
    }
  }
  return {
    modes,
    tokens: [...tokens.values()].sort((left, right) => compareText(left.name, right.name)),
    components: [],
    findings,
  };
};

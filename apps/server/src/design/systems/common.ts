// @effect-diagnostics nodeBuiltinImport:off - Pure helpers over file text; hashing only.
/**
 * Shared shapes and helpers for the design-system extractors. Every extractor
 * is a pure function of file text: same bytes in, byte-identical tokens out,
 * sorted by name, with file:line provenance on every value.
 */
import * as NodeCrypto from "node:crypto";

import type {
  DesignProvenance,
  DesignSystemComponent,
  DesignSystemFinding,
  DesignToken,
  DesignTokenType,
  DesignTokenValue,
} from "@specweave-studio/contracts";

/** One file as read from the owner's root (or an uploaded export). */
export interface SourceText {
  /** Root-relative path with `/` separators, or the export's file name. */
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
}

export interface ExtractedMode {
  readonly id: string;
  readonly name: string;
}

export interface Extraction {
  readonly modes: ReadonlyArray<ExtractedMode>;
  readonly tokens: ReadonlyArray<DesignToken>;
  readonly components: ReadonlyArray<DesignSystemComponent>;
  readonly findings: ReadonlyArray<DesignSystemFinding>;
}

export type MutableToken = {
  name: string;
  type: DesignTokenType;
  group?: string;
  description?: string;
  values: Record<string, DesignTokenValue>;
  aliasOf?: string;
  /** Set when the source states the type (`$type`, a Weave section); otherwise inferred. */
  explicitType?: boolean;
};

/** What one extractor read from one file, before references are resolved. */
export interface Collected {
  readonly modes: ReadonlyArray<ExtractedMode>;
  readonly tokens: ReadonlyArray<MutableToken>;
  readonly components: ReadonlyArray<DesignSystemComponent>;
  readonly findings: ReadonlyArray<DesignSystemFinding>;
}

export const modeName = (id: string): string =>
  id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ") || id;

export const sha256Hex = (text: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

export const sourceText = (path: string, text: string): SourceText => ({
  path,
  text,
  sha256: sha256Hex(text),
});

/** Byte-order comparison, independent of the host locale. */
export const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** 1-based line and column of a UTF-16 offset. */
export const lineColumnAt = (
  text: string,
  offset: number,
): { readonly line: number; readonly column: number } => {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
};

/** Precomputed line starts for files with many lookups. */
export const lineIndex = (text: string): ((offset: number) => { line: number; column: number }) => {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
  };
};

export const kebabCase = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

/** Ids in contracts allow `[A-Za-z0-9_-]` up to 80 characters. */
export const safeId = (value: string, fallback = "item"): string => {
  const id = kebabCase(value).slice(0, 80).replace(/-+$/g, "");
  return id.length > 0 ? id : fallback;
};

export const provenance = (
  source: SourceText,
  extractor: string,
  position: { readonly line: number; readonly column: number } | undefined,
  context: string | undefined,
  kind: DesignProvenance["source"] = "file",
  location: string = source.path,
): DesignProvenance => ({
  source: kind,
  location: location.slice(0, 500),
  ...(position ? { line: position.line, column: position.column } : {}),
  ...(context ? { context: context.slice(0, 300) } : {}),
  sha256: source.sha256,
  extractor,
});

/** Sorts tokens and their mode keys so serialized output is stable. */
export const sortTokens = (tokens: Iterable<MutableToken>): DesignToken[] =>
  [...tokens]
    .sort((left, right) => compareText(left.name, right.name))
    .map((token) => {
      const values: Record<string, DesignTokenValue> = {};
      for (const mode of Object.keys(token.values).sort(compareText)) {
        values[mode] = token.values[mode]!;
      }
      return {
        name: token.name,
        type: token.type,
        ...(token.group !== undefined ? { group: token.group } : {}),
        ...(token.description !== undefined ? { description: token.description } : {}),
        values,
        ...(token.aliasOf !== undefined ? { aliasOf: token.aliasOf } : {}),
      };
    });

export const sortComponents = (
  components: Iterable<DesignSystemComponent>,
): DesignSystemComponent[] => [...components].sort((left, right) => compareText(left.id, right.id));

export const sortFindings = (findings: Iterable<DesignSystemFinding>): DesignSystemFinding[] =>
  [...findings].sort(
    (left, right) =>
      compareText(left.location ?? "", right.location ?? "") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );

export const finding = (
  code: string,
  severity: DesignSystemFinding["severity"],
  message: string,
  location?: string,
  line?: number,
): DesignSystemFinding => ({
  code,
  severity,
  message: message.slice(0, 2_000),
  ...(location !== undefined ? { location: location.slice(0, 500) } : {}),
  ...(line !== undefined ? { line } : {}),
});

/** Caps a raw value at the contract's limit without splitting a surrogate pair. */
export const clip = (value: string, max = 2_000): string =>
  value.length <= max ? value : Array.from(value).slice(0, max).join("").slice(0, max);

/**
 * Names of the custom properties declared in `text` (`--name:`), in order.
 * The look-behind starts a match only at the first dash of a run, so a long
 * run of dashes or spaces costs linear time, not quadratic.
 */
const DECLARATION = /(?<![\w-])--([A-Za-z0-9_-]+)\s*:/g;
export const customPropertyNames = (text: string): string[] =>
  Array.from(text.matchAll(DECLARATION), (match) => match[1]!);

/** Joins a value's lines with single spaces; split and trim instead of a backtracking regex. */
export const singleLine = (value: string): string =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");

/** Deepest nesting a token file may have; real files stay under 12. */
export const MAX_JSON_DEPTH = 64;

export class JsonTooDeep extends Error {
  constructor() {
    super(`nested deeper than ${MAX_JSON_DEPTH} levels`);
  }
}

/** Throws `JsonTooDeep` before a parser recurses into a hostile file. Linear; skips strings. */
export const assertJsonDepth = (text: string): void => {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw new JsonTooDeep();
    } else if (char === "}" || char === "]") depth -= 1;
  }
};

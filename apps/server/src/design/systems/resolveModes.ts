/**
 * Resolves references between tokens within each mode, the way the cascade
 * would: a mode that does not redeclare a token inherits the base mode's
 * declaration, and references inside it resolve against the same mode. A token
 * declared only in the base mode but depending on a token that changes in
 * another mode gets a derived value there (same raw text and provenance, its
 * own resolved value). Cycles are reported once and resolve to null, and so
 * does a token whose reference chain is deeper than `MAX_REFERENCE_DEPTH`.
 */
import valueParser from "postcss-value-parser";

import type { DesignSystemFinding } from "@specweave-studio/contracts";

import { clip, compareText, finding, type MutableToken } from "./common.ts";

/** Longest reference chain followed; a deeper token is reported and left unresolved. */
export const MAX_REFERENCE_DEPTH = 64;

export interface Reference {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly fallback?: string;
}

/** Finds references in a raw value: CSS `var(--x, fallback)` or DTCG `{group.token}`. */
export type ReferenceFinder = (raw: string) => ReadonlyArray<Reference>;

export const cssReferences: ReferenceFinder = (raw) => {
  if (!raw.includes("var(")) return [];
  const references: Reference[] = [];
  valueParser(raw).walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "var") return;
    const [first, divider, ...rest] = node.nodes;
    if (first?.type === "word" && first.value.startsWith("--")) {
      const fallback =
        divider?.type === "div" && divider.value === ","
          ? valueParser.stringify(rest).trim()
          : undefined;
      references.push({
        start: node.sourceIndex,
        end: node.sourceEndIndex,
        name: first.value.slice(2),
        ...(fallback !== undefined ? { fallback } : {}),
      });
    }
    return false;
  });
  return references;
};

export const braceReferences =
  (toName: (path: string) => string): ReferenceFinder =>
  (raw) => {
    const references: Reference[] = [];
    for (const match of raw.matchAll(/\{([^{}]+)\}/g)) {
      references.push({
        start: match.index,
        end: match.index + match[0].length,
        name: toName(match[1]!.trim()),
      });
    }
    return references;
  };

export interface ResolveOptions {
  readonly baseMode: string;
  readonly modes: ReadonlyArray<string>;
  readonly references: ReferenceFinder;
  /** Location used for findings that are not tied to one token. */
  readonly location?: string;
}

/**
 * Fills `resolved` on every value, adds derived per-mode values, sets
 * `aliasOf` for pure references, and returns findings. Mutates `tokens`.
 */
export const resolveModes = (
  tokens: Map<string, MutableToken>,
  options: ResolveOptions,
): DesignSystemFinding[] => {
  const findings: DesignSystemFinding[] = [];
  const reportedCycles = new Set<string>();
  const external = new Map<string, number>();
  const memo = new Map<string, string | null>();

  // Every token referenced from a token's values in any mode, fallbacks included.
  const edges = new Map<string, ReadonlyArray<string>>();
  const referencedIn = (raw: string, into: Set<string>) => {
    for (const reference of options.references(raw)) {
      if (tokens.has(reference.name)) into.add(reference.name);
      if (reference.fallback !== undefined) referencedIn(reference.fallback, into);
    }
  };
  const edgesOf = (name: string) => {
    let found = edges.get(name);
    if (found === undefined) {
      const into = new Set<string>();
      for (const value of Object.values(tokens.get(name)?.values ?? {}))
        referencedIn(value.raw, into);
      found = [...into].sort(compareText);
      edges.set(name, found);
    }
    return found;
  };

  /**
   * Length of the longest reference chain from a token (cycle edges add
   * nothing; cycles are reported by `resolve`). Iterative, so a chain of any
   * length is measured without deep recursion; resolution then never follows
   * more than `MAX_REFERENCE_DEPTH` references.
   */
  const heights = new Map<string, number>();
  const heightOf = (start: string): number => {
    const cached = heights.get(start);
    if (cached !== undefined) return cached;
    const onPath = new Set([start]);
    const frames = [{ name: start, next: 0, best: 0 }];
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const children = edgesOf(frame.name);
      if (frame.next < children.length) {
        const child = children[frame.next++]!;
        const known = heights.get(child);
        if (known !== undefined) frame.best = Math.max(frame.best, known + 1);
        else if (!onPath.has(child)) {
          onPath.add(child);
          frames.push({ name: child, next: 0, best: 0 });
        }
        continue;
      }
      frames.pop();
      onPath.delete(frame.name);
      heights.set(frame.name, frame.best);
      const parent = frames.at(-1);
      if (parent) parent.best = Math.max(parent.best, frame.best + 1);
    }
    return heights.get(start)!;
  };
  // Heights inside a cycle are a lower bound, so the stack is also capped as a backstop.
  const cutShort = new Set<string>();
  const tooDeep = (name: string) => cutShort.has(name) || heightOf(name) > MAX_REFERENCE_DEPTH;

  const declared = (name: string, mode: string) => {
    const token = tokens.get(name);
    return token?.values[mode] ?? token?.values[options.baseMode];
  };

  const substitute = (raw: string, mode: string, stack: ReadonlyArray<string>): string | null => {
    const references = options.references(raw);
    if (references.length === 0) return raw;
    let output = "";
    let cursor = 0;
    for (const reference of references) {
      output += raw.slice(cursor, reference.start);
      cursor = reference.end;
      let value: string | null = null;
      if (tokens.has(reference.name)) {
        value = resolve(reference.name, mode, stack);
      } else {
        external.set(reference.name, (external.get(reference.name) ?? 0) + 1);
      }
      if (value === null && reference.fallback !== undefined) {
        value = substitute(reference.fallback, mode, stack);
      }
      if (value === null) return null;
      output += value;
    }
    return output + raw.slice(cursor);
  };

  const resolve = (name: string, mode: string, stack: ReadonlyArray<string>): string | null => {
    const key = `${mode}\u0000${name}`;
    if (memo.has(key)) return memo.get(key)!;
    const cycleStart = stack.indexOf(name);
    if (cycleStart >= 0) {
      const members = [...stack.slice(cycleStart)];
      const signature = `${mode}:${[...members].sort(compareText).join(",")}`;
      if (!reportedCycles.has(signature)) {
        reportedCycles.add(signature);
        const value = declared(members[0]!, mode);
        findings.push(
          finding(
            "cycle",
            "warning",
            `Reference cycle in mode ${mode}: ${[...members, name].map((item) => `--${item}`).join(" -> ")}`,
            value?.provenance.location ?? options.location,
            value?.provenance.line,
          ),
        );
      }
      return null;
    }
    const value = declared(name, mode);
    if (value === undefined) return null;
    if (stack.length >= MAX_REFERENCE_DEPTH) cutShort.add(stack[0]!);
    if (tooDeep(name) || stack.length >= MAX_REFERENCE_DEPTH) {
      memo.set(key, null);
      return null;
    }
    const resolved = substitute(value.raw, mode, [...stack, name]);
    memo.set(key, resolved === null ? null : clip(resolved));
    return memo.get(key)!;
  };

  // Transitive dependencies, to decide which base-only tokens vary per mode.
  const dependencies = new Map<string, Set<string>>();
  const dependsOn = (name: string, seen: Set<string> = new Set()): Set<string> => {
    const cached = dependencies.get(name);
    if (cached) return cached;
    const result = new Set<string>();
    if (seen.has(name) || seen.size >= MAX_REFERENCE_DEPTH || tooDeep(name)) return result;
    seen.add(name);
    const token = tokens.get(name);
    for (const value of Object.values(token?.values ?? {})) {
      for (const reference of options.references(value.raw)) {
        if (!tokens.has(reference.name)) continue;
        result.add(reference.name);
        for (const nested of dependsOn(reference.name, seen)) result.add(nested);
      }
    }
    seen.delete(name);
    dependencies.set(name, result);
    return result;
  };

  const names = [...tokens.keys()].sort(compareText);
  for (const name of names) {
    const token = tokens.get(name)!;
    const base = token.values[options.baseMode];
    if (base !== undefined) {
      const deps = dependsOn(name);
      for (const mode of options.modes) {
        if (mode === options.baseMode || token.values[mode] !== undefined) continue;
        if ([...deps].some((dependency) => tokens.get(dependency)?.values[mode] !== undefined)) {
          token.values[mode] = { ...base };
        }
      }
    }
    for (const mode of Object.keys(token.values).sort(compareText)) {
      const value = token.values[mode]!;
      token.values[mode] = { ...value, resolved: resolve(name, mode, []) };
    }
    const sample = base ?? Object.values(token.values)[0];
    if (sample) {
      const references = options.references(sample.raw);
      const only = references[0];
      if (
        references.length === 1 &&
        only !== undefined &&
        only.start === 0 &&
        only.end === sample.raw.trim().length &&
        tokens.has(only.name) &&
        only.name !== name
      ) {
        token.aliasOf = only.name;
      }
    }
  }

  const deep = names.filter(tooDeep);
  if (deep.length > 0) {
    const first = tokens.get(deep[0]!)!;
    const at = first.values[options.baseMode] ?? Object.values(first.values)[0];
    findings.push(
      finding(
        "unresolved",
        "warning",
        `${deep.length} ${deep.length === 1 ? "token follows" : "tokens follow"} more than ${MAX_REFERENCE_DEPTH} references and ${deep.length === 1 ? "was" : "were"} left unresolved: ${deep
          .slice(0, 8)
          .map((name) => `--${name}`)
          .join(", ")}${deep.length > 8 ? ", ..." : ""}`,
        at?.provenance.location ?? options.location,
        at?.provenance.line,
      ),
    );
  }

  if (external.size > 0) {
    const sorted = [...external.keys()].sort(compareText);
    const sample = sorted
      .slice(0, 8)
      .map((name) => `--${name}`)
      .join(", ");
    findings.push(
      finding(
        "unresolved",
        "info",
        `${sorted.length} referenced ${sorted.length === 1 ? "variable is" : "variables are"} not defined in the selected sources (for example framework defaults or values set at runtime): ${sample}${sorted.length > 8 ? ", ..." : ""}`,
        options.location,
      ),
    );
  }
  return findings;
};

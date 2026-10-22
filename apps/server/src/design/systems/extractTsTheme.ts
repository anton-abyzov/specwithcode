/**
 * Theme objects written as TypeScript literals. Uses the TypeScript compiler
 * API (6.x, loaded on first use; the workspace's TypeScript 7 has no
 * in-process API) and never evaluates code: only string and number literals,
 * object literals, `as const`/`satisfies`, spreads and references to other
 * literal constants in the same file are read. Anything else is skipped.
 *
 * Two shapes become modes:
 *   - a theme definition `{ id, appearance, colors: {...}, variants: { dark: {...} } }`
 *     gives modes `<id>-<appearance>` and `<id>-<variant>`;
 *   - a flat object of at least five colors (`LIGHT_THEME_COLORS = {...}`)
 *     gives a mode named after the constant.
 * Keys become kebab-case token names; one token per key across all modes.
 */
import * as NodeModule from "node:module";

import type * as TS from "typescript-legacy";

import type { DesignSystemFinding } from "@specweave-studio/contracts";

import { isColorValue } from "./classify.ts";
import {
  type Collected,
  type MutableToken,
  type SourceText,
  clip,
  compareText,
  finding,
  kebabCase,
  modeName,
  provenance,
} from "./common.ts";

export const TS_THEME_EXTRACTOR = "ts-theme@1";

type TypeScript = typeof TS;
let typescript: Promise<TypeScript> | undefined;

// TypeScript stays external to the server bundle (scripts/lib/cli-external-packages.ts):
// it is CommonJS that reads `__filename` while it starts, and an inlined copy
// runs in an ES module where that does not exist. A Node single-executable
// resolves only built-ins through `import`, so it is loaded with `require`,
// which reads the real filesystem in every runtime.
const requireTypeScript = NodeModule.createRequire(import.meta.url);

/** Loads the compiler once; scans that never meet a theme file never load it. */
export const loadTypeScript = (): Promise<TypeScript> => {
  typescript ??= new Promise((resolve) =>
    resolve(requireTypeScript("typescript-legacy") as TypeScript),
  );
  return typescript;
};

interface LiteralString {
  readonly kind: "string";
  readonly value: string;
  readonly node: TS.Node;
}
interface LiteralObject {
  readonly kind: "object";
  readonly entries: ReadonlyArray<readonly [string, Literal]>;
  readonly node: TS.Node;
}
type Literal = LiteralString | LiteralObject;

interface ThemeMode {
  readonly id: string;
  readonly values: ReadonlyArray<readonly [string, LiteralString]>;
  readonly context: string;
}

export interface TsThemeOptions {
  /** Prepended to every token name (`app-theme-` when CSS reads `--app-theme-*`). */
  readonly prefix?: string;
}

const unwrap = (ts: TypeScript, node: TS.Expression): TS.Expression => {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const propertyKey = (ts: TypeScript, name: TS.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
};

const parse = (ts: TypeScript, source: SourceText) =>
  ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const topLevelConstants = (ts: TypeScript, file: TS.SourceFile) => {
  const constants = new Map<string, TS.Expression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return constants;
};

/** Evaluation steps per file; a theme needs a few thousand, a hostile file stops here. */
export const MAX_EVALUATION_STEPS = 100_000;

/**
 * Evaluates object literals and the constants they name. Each binding is
 * evaluated once and reused (chained spreads such as `{...a0, x: a0}` stay
 * linear), a binding that refers back to itself is null, and evaluation stops
 * after `MAX_EVALUATION_STEPS`.
 */
const evaluator = (ts: TypeScript, constants: Map<string, TS.Expression>) => {
  const bindings = new Map<string, Literal | null>();
  const inProgress = new Set<string>();
  let steps = 0;
  const binding = (name: string): Literal | null => {
    if (bindings.has(name)) return bindings.get(name)!;
    const target = constants.get(name);
    if (target === undefined || inProgress.has(name)) return null;
    inProgress.add(name);
    const value = evaluate(target);
    inProgress.delete(name);
    bindings.set(name, value);
    return value;
  };
  const evaluate = (expression: TS.Expression): Literal | null => {
    steps += 1;
    if (steps > MAX_EVALUATION_STEPS) return null;
    const node = unwrap(ts, expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { kind: "string", value: node.text, node };
    }
    if (ts.isNumericLiteral(node)) return { kind: "string", value: node.text, node };
    if (ts.isIdentifier(node)) return binding(node.text);
    if (!ts.isObjectLiteralExpression(node)) return null;
    const entries = new Map<string, Literal>();
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyKey(ts, property.name);
        const value = key === null ? null : evaluate(property.initializer);
        if (key !== null && value !== null) entries.set(key, value);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const value = evaluate(property.name);
        if (value !== null) entries.set(property.name.text, value);
      } else if (ts.isSpreadAssignment(property)) {
        const spread = evaluate(property.expression);
        if (spread?.kind === "object")
          for (const [key, value] of spread.entries) entries.set(key, value);
      }
    }
    return { kind: "object", entries: [...entries], node };
  };
  return binding;
};

const stringEntries = (literal: Literal | undefined): Array<readonly [string, LiteralString]> =>
  literal?.kind === "object"
    ? literal.entries.filter(
        (entry): entry is readonly [string, LiteralString] => entry[1].kind === "string",
      )
    : [];

const entry = (literal: LiteralObject, key: string) =>
  literal.entries.find(([name]) => name === key)?.[1];

const isPalette = (values: ReadonlyArray<readonly [string, LiteralString]>) =>
  values.length >= 5 &&
  values.filter(([, value]) => isColorValue(value.value)).length / values.length >= 0.8;

const constantModeId = (name: string) =>
  kebabCase(name).replace(/-(?:theme-colors|colors|palette|theme)$/, "") || kebabCase(name);

const themeModes = (ts: TypeScript, file: TS.SourceFile): ThemeMode[] => {
  const constants = topLevelConstants(ts, file);
  const binding = evaluator(ts, constants);
  const modes: ThemeMode[] = [];
  const usedAsColors = new Set<string>();
  for (const name of constants.keys()) {
    const literal = binding(name);
    if (literal?.kind !== "object") continue;
    const colors = entry(literal, "colors");
    const colorValues = stringEntries(colors);
    if (!isPalette(colorValues)) continue;
    const colorsNode = unwrap(
      ts,
      (literal.node as TS.ObjectLiteralExpression).properties
        .filter(ts.isPropertyAssignment)
        .find((property) => propertyKey(ts, property.name) === "colors")?.initializer ??
        (literal.node as TS.Expression),
    );
    if (ts.isIdentifier(colorsNode)) usedAsColors.add(colorsNode.text);
    const idLiteral = entry(literal, "id");
    const id = idLiteral?.kind === "string" ? kebabCase(idLiteral.value) : constantModeId(name);
    const appearance = entry(literal, "appearance");
    const baseMode = appearance?.kind === "string" ? `${id}-${kebabCase(appearance.value)}` : id;
    modes.push({ id: baseMode, values: colorValues, context: `${name}.colors` });
    const variants = entry(literal, "variants");
    if (variants?.kind === "object") {
      for (const [variant, value] of variants.entries) {
        const variantValues = stringEntries(value);
        if (isPalette(variantValues)) {
          modes.push({
            id: `${id}-${kebabCase(variant)}`,
            values: variantValues,
            context: `${name}.variants.${variant}`,
          });
        }
      }
    }
  }
  for (const name of constants.keys()) {
    if (usedAsColors.has(name)) continue;
    const literal = binding(name);
    if (literal?.kind !== "object" || entry(literal, "colors") !== undefined) continue;
    const values = stringEntries(literal);
    if (values.length === literal.entries.length && isPalette(values)) {
      modes.push({ id: constantModeId(name), values, context: name });
    }
  }
  return modes;
};

export const collectTsTheme = (
  ts: TypeScript,
  source: SourceText,
  options: TsThemeOptions = {},
): Collected => {
  const file = parse(ts, source);
  const modes = themeModes(ts, file);
  const findings: DesignSystemFinding[] = [];
  const tokens = new Map<string, MutableToken>();
  const seenModes = new Set<string>();
  for (const mode of modes) {
    if (seenModes.has(mode.id)) {
      findings.push(
        finding(
          "duplicate-mode",
          "warning",
          `Mode ${mode.id} is defined twice; the first one is kept`,
          source.path,
        ),
      );
      continue;
    }
    seenModes.add(mode.id);
    for (const [key, value] of mode.values) {
      const name = `${options.prefix ?? ""}${kebabCase(key)}`;
      const position = file.getLineAndCharacterOfPosition(value.node.getStart(file));
      const token = tokens.get(name) ?? {
        name,
        type: "color" as const,
        values: {},
        explicitType: false,
      };
      token.values[mode.id] = {
        raw: clip(value.value),
        resolved: null,
        provenance: provenance(
          source,
          TS_THEME_EXTRACTOR,
          { line: position.line + 1, column: position.character + 1 },
          `${mode.context}.${key}`,
        ),
      };
      tokens.set(name, token);
    }
  }
  return {
    modes: modes
      .filter((mode, index) => modes.findIndex((other) => other.id === mode.id) === index)
      .map((mode) => ({ id: mode.id, name: modeName(mode.id) })),
    tokens: [...tokens.values()].sort((left, right) => compareText(left.name, right.name)),
    components: [],
    findings,
  };
};

/** Theme keys found in a file, for prefix detection and the scan count. */
export const tsThemeKeys = (
  ts: TypeScript,
  source: SourceText,
): { keys: string[]; modes: string[] } => {
  const modes = themeModes(ts, parse(ts, source));
  const keys = new Set<string>();
  for (const mode of modes) for (const [key] of mode.values) keys.add(kebabCase(key));
  return { keys: [...keys].sort(compareText), modes: [...new Set(modes.map((mode) => mode.id))] };
};

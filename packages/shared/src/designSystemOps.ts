import {
  DESIGN_SYSTEM_SCHEMA,
  type DesignActor,
  type DesignProvenance,
  type DesignSystem,
  type DesignSystemComponent,
  type DesignSystemOperation,
  type DesignToken,
  type DesignTokenEdit,
  type DesignTokenValue,
} from "@specweave-studio/contracts";

/**
 * The one reducer for editing a design system by hand. The system page
 * applies operations optimistically and the server applies the same
 * operations under its revision check, so both sides agree on the result.
 *
 * Pure: never mutates its input. It sets `updatedAt` to the edit's time but
 * never `revision`; the store owns that. Values a person writes are stamped
 * with editor provenance; a value whose raw text did not change keeps the
 * provenance it was imported with, so a rescan still tells edits apart.
 *
 * `resolved` is recomputed for the tokens an edit touches and every token
 * that refers to them: literals resolve to themselves, `var(--x)` and `{x}`
 * resolve against the same mode (falling back to the first mode, as the
 * cascade would), and a cycle or a missing token leaves `null`.
 */

/** `extractor` of every value and component written in the editor. */
export const DESIGN_SYSTEM_EDITOR_EXTRACTOR = "editor@1";
/** Modes a new system starts with when the person does not pick any. */
export const DESIGN_SYSTEM_DEFAULT_MODES = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
] as const;

/** As `DesignSystem` allows. */
const MAX_TOKENS = 20_000;
const MAX_COMPONENTS = 5_000;
const MAX_VALUE_LENGTH = 2_000;
/** Modes a person may add, the same cap as a new system's. */
const MAX_MODES = 8;
/** Longest reference chain followed before a value is left unresolved. */
const MAX_REFERENCE_DEPTH = 64;

export type DesignSystemOperationErrorCode = "not_found" | "invalid" | "too_large";

export type DesignSystemApplyOutcome =
  | { readonly ok: true; readonly system: DesignSystem }
  | {
      readonly ok: false;
      readonly code: DesignSystemOperationErrorCode;
      readonly detail: string;
      /** Position of the failing operation in the batch. */
      readonly index: number;
    };

export interface DesignSystemEditContext {
  readonly actor: DesignActor;
  /** ISO time of the edit; becomes `updatedAt`. */
  readonly now: string;
}

class OperationFailure {
  readonly code: DesignSystemOperationErrorCode;
  readonly detail: string;
  constructor(code: DesignSystemOperationErrorCode, detail: string) {
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code: DesignSystemOperationErrorCode, detail: string): never => {
  throw new OperationFailure(code, detail);
};

const editorProvenance = (actor: DesignActor): DesignProvenance => ({
  source: actor.kind === "agent" ? "agent" : "user",
  location: "editor",
  extractor: DESIGN_SYSTEM_EDITOR_EXTRACTOR,
});

/** A new, empty system at revision 0 with no sources. */
export function newDesignSystem(input: {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly modes?: ReadonlyArray<{ readonly id: string; readonly name: string }> | undefined;
  readonly now: string;
}): DesignSystem {
  const description = input.description?.trim();
  return {
    schema: DESIGN_SYSTEM_SCHEMA,
    id: input.id,
    name: input.name.trim(),
    ...(description ? { description } : {}),
    revision: 0,
    createdAt: input.now,
    updatedAt: input.now,
    modes: (input.modes ?? DESIGN_SYSTEM_DEFAULT_MODES).map((mode) => ({
      id: mode.id,
      name: mode.name.trim(),
    })),
    tokens: [],
    components: [],
    sources: [],
    copiedFrom: null,
  };
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

interface TokenReference {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly brace: boolean;
  readonly fallback?: string;
}

const IDENT_CHAR = /[A-Za-z0-9_-]/;
const BRACE_NAME = /^[A-Za-z0-9._-]+$/;

/** Index of the `)` closing the `(` at `open`, or -1. Quotes are skipped. */
function closingParen(raw: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Index of the first comma outside parentheses, or -1. */
function topLevelComma(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) return index;
  }
  return -1;
}

/** `var(--name, fallback)` and `{name}` references in a raw value, in order, outermost only. */
function tokenReferences(raw: string): TokenReference[] {
  const references: TokenReference[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (
      (char === "v" || char === "V") &&
      raw.slice(index, index + 4).toLowerCase() === "var(" &&
      (index === 0 || !IDENT_CHAR.test(raw[index - 1]!))
    ) {
      const close = closingParen(raw, index + 3);
      if (close < 0) break;
      const inner = raw.slice(index + 4, close);
      const comma = topLevelComma(inner);
      const head = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      if (/^--\S+$/.test(head)) {
        references.push({
          start: index,
          end: close + 1,
          name: head.slice(2),
          brace: false,
          ...(comma < 0 ? {} : { fallback: inner.slice(comma + 1).trim() }),
        });
      }
      index = close + 1;
      continue;
    }
    if (char === "{") {
      const close = raw.indexOf("}", index + 1);
      const name = close < 0 ? "" : raw.slice(index + 1, close).trim();
      if (BRACE_NAME.test(name)) {
        references.push({ start: index, end: close + 1, name, brace: true });
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
  return references;
}

/** A `{a.b}` reference names `a.b`, or `a-b` as DTCG imports write it. */
const braceTarget = (tokens: ReadonlyMap<string, DesignToken>, name: string) =>
  tokens.has(name) ? name : name.replaceAll(".", "-");

/**
 * The token a dotted name would take `{name}` references from: a new `a.b`
 * answers `{a.b}` before an existing `a-b` does.
 */
function braceCapture(tokens: ReadonlyMap<string, DesignToken>, name: string, except: string) {
  const dashed = name.replaceAll(".", "-");
  if (dashed !== name && dashed !== except && tokens.has(dashed)) {
    fail("invalid", `{${name}} already refers to ${dashed}. Pick another name.`);
  }
}

/** Every token name `raw` refers to, fallbacks included. */
function referencedNames(raw: string, into: Set<string>): Set<string> {
  for (const reference of tokenReferences(raw)) {
    into.add(reference.name);
    if (reference.brace) into.add(reference.name.replaceAll(".", "-"));
    if (reference.fallback !== undefined) referencedNames(reference.fallback, into);
  }
  return into;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `raw` with references to `from` pointing at `to`, fallbacks included. A
 * brace reference counts in either spelling, `{from}` or the `{a.b}` a DTCG
 * import keeps for `a-b`, as resolution reads it against `tokens`.
 */
function renameReferences(
  raw: string,
  from: string,
  to: string,
  tokens: ReadonlyMap<string, DesignToken>,
): string {
  const name = escapeRegExp(from);
  return raw
    .replace(new RegExp(`([vV][aA][rR]\\(\\s*--)${name}(?=\\s*[,)])`, "g"), `$1${to}`)
    .replace(/\{\s*([^{}\s]+)\s*\}/g, (whole, inner: string) =>
      inner === from || (BRACE_NAME.test(inner) && braceTarget(tokens, inner) === from)
        ? `{${to}}`
        : whole,
    );
}

/** The token `raw` is exactly a reference to, if it is one. */
function wholeReference(raw: string, tokens: ReadonlyMap<string, DesignToken>): string | null {
  const references = tokenReferences(raw);
  const only = references[0];
  if (references.length !== 1 || only === undefined) return null;
  if (only.start !== 0 || only.end !== raw.length) return null;
  const name = only.brace ? braceTarget(tokens, only.name) : only.name;
  return tokens.has(name) ? name : null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Recomputes `resolved` for `seeds` that still exist and every token that
 * refers to a seed, directly or through others. Other tokens keep their
 * values: an import may have resolved them from context the system lacks.
 */
function resolveChanged(
  tokens: Map<string, DesignToken>,
  firstMode: string,
  seeds: ReadonlySet<string>,
): void {
  if (seeds.size === 0) return;
  const dependents = new Map<string, string[]>();
  for (const token of tokens.values()) {
    const names = new Set<string>();
    for (const value of Object.values(token.values)) referencedNames(value.raw, names);
    for (const name of names) {
      const list = dependents.get(name);
      if (list === undefined) dependents.set(name, [token.name]);
      else list.push(token.name);
    }
  }
  const dirty = new Set<string>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (dirty.has(name)) continue;
    dirty.add(name);
    for (const dependent of dependents.get(name) ?? []) queue.push(dependent);
  }

  const memo = new Map<string, string | null>();
  const substitute = (raw: string, mode: string, stack: readonly string[]): string | null => {
    const references = tokenReferences(raw);
    if (references.length === 0) return raw;
    let output = "";
    let cursor = 0;
    for (const reference of references) {
      output += raw.slice(cursor, reference.start);
      cursor = reference.end;
      const target = reference.brace ? braceTarget(tokens, reference.name) : reference.name;
      let value = tokens.has(target) ? resolve(target, mode, stack) : null;
      if (value === null && reference.fallback !== undefined) {
        value = substitute(reference.fallback, mode, stack);
      }
      if (value === null) return null;
      output += value;
    }
    return output + raw.slice(cursor);
  };
  const resolve = (name: string, mode: string, stack: readonly string[]): string | null => {
    const key = `${mode}\u0000${name}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    // A cycle, or a chain too long to follow.
    if (stack.includes(name) || stack.length >= MAX_REFERENCE_DEPTH) return null;
    const token = tokens.get(name);
    const own = token?.values[mode];
    const value = own ?? token?.values[firstMode];
    if (value === undefined) return null;
    let resolved =
      own !== undefined && own.resolved !== null && !dirty.has(name)
        ? own.resolved
        : substitute(value.raw, mode, [...stack, name]);
    if (resolved !== null && resolved.length > MAX_VALUE_LENGTH) resolved = null;
    memo.set(key, resolved);
    return resolved;
  };

  for (const name of dirty) {
    const token = tokens.get(name);
    if (token === undefined) continue;
    const values: Record<string, DesignTokenValue> = {};
    for (const [mode, value] of Object.entries(token.values)) {
      values[mode] = { ...value, resolved: resolve(name, mode, []) };
    }
    tokens.set(name, { ...token, values });
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

interface Draft {
  name: string;
  description: string | undefined;
  modes: Array<{ id: string; name: string }>;
  tokens: Map<string, DesignToken>;
  components: DesignSystemComponent[];
  /** Tokens whose `resolved` must be recomputed, by name; removed names included. */
  readonly changed: Set<string>;
}

function putToken(draft: Draft, edit: DesignTokenEdit, provenance: DesignProvenance) {
  const existing = draft.tokens.get(edit.name);
  if (existing === undefined && draft.tokens.size >= MAX_TOKENS) {
    fail(
      "too_large",
      `A design system holds at most ${MAX_TOKENS.toLocaleString("en-US")} tokens.`,
    );
  }
  if (existing === undefined) braceCapture(draft.tokens, edit.name, edit.name);
  for (const modeId of Object.keys(edit.values)) {
    if (!draft.modes.some((mode) => mode.id === modeId)) {
      fail("not_found", `No mode ${modeId} in this design system.`);
    }
  }
  if (edit.aliasOf !== undefined) {
    if (edit.aliasOf === edit.name) fail("invalid", `${edit.name} cannot be an alias of itself.`);
    if (!draft.tokens.has(edit.aliasOf)) fail("not_found", `No token ${edit.aliasOf} to alias.`);
  }
  const given = new Map<string, string>();
  for (const mode of draft.modes) {
    const raw = edit.values[mode.id]?.trim();
    if (raw) given.set(mode.id, raw);
  }
  // A mode left out gets a copy of the first mode's value (or the first one given).
  const inherited = given.get(draft.modes[0]!.id) ?? given.values().next().value;
  if (inherited === undefined) fail("invalid", `Give ${edit.name} a value.`);
  const values: Record<string, DesignTokenValue> = {};
  for (const mode of draft.modes) {
    const raw = given.get(mode.id) ?? inherited!;
    const before = existing?.values[mode.id];
    values[mode.id] =
      before !== undefined && before.raw === raw
        ? { raw, resolved: before.resolved, provenance: before.provenance }
        : { raw, resolved: null, provenance };
  }
  const group = edit.group?.trim();
  const description = edit.description?.trim();
  const aliasOf =
    edit.aliasOf ??
    (() => {
      const target = wholeReference(values[draft.modes[0]!.id]!.raw, draft.tokens);
      return target === edit.name ? null : target;
    })();
  draft.tokens.set(edit.name, {
    name: edit.name,
    type: edit.type,
    ...(group ? { group } : {}),
    ...(description ? { description } : {}),
    values,
    ...(aliasOf ? { aliasOf } : {}),
  });
  draft.changed.add(edit.name);
}

function renameToken(draft: Draft, from: string, to: string, provenance: DesignProvenance) {
  if (from === to) return;
  if (!draft.tokens.has(from)) fail("not_found", `No token ${from}.`);
  if (draft.tokens.has(to)) fail("invalid", `A token named ${to} already exists.`);
  braceCapture(draft.tokens, to, from);
  const renamed = new Map<string, DesignToken>();
  for (const [name, token] of draft.tokens) {
    let next: DesignToken = name === from ? { ...token, name: to } : token;
    if (next.aliasOf === from) next = { ...next, aliasOf: to };
    let rewritten = false;
    const values: Record<string, DesignTokenValue> = {};
    for (const [mode, value] of Object.entries(next.values)) {
      const raw = renameReferences(value.raw, from, to, draft.tokens);
      rewritten ||= raw !== value.raw;
      // Rewritten text is an edit, not what the source said.
      values[mode] = raw === value.raw ? value : { raw, resolved: value.resolved, provenance };
    }
    if (rewritten) {
      next = { ...next, values };
      draft.changed.add(next.name);
    }
    renamed.set(next.name, next);
  }
  draft.tokens = renamed;
  draft.changed.add(from);
  draft.changed.add(to);
}

function deleteToken(draft: Draft, name: string) {
  if (!draft.tokens.delete(name)) fail("not_found", `No token ${name}.`);
  for (const [other, token] of draft.tokens) {
    if (token.aliasOf !== name) continue;
    const { aliasOf: _aliasOf, ...rest } = token;
    draft.tokens.set(other, rest);
  }
  draft.changed.add(name);
}

const sameComponent = (
  left: DesignSystemComponent,
  right: Omit<DesignSystemComponent, "provenance">,
) => {
  const { provenance: _provenance, ...content } = left;
  return JSON.stringify(content) === JSON.stringify(right);
};

function applyOne(
  draft: Draft,
  operation: DesignSystemOperation,
  provenance: DesignProvenance,
): void {
  switch (operation.op) {
    case "set_info": {
      if (operation.name !== undefined) {
        const name = operation.name.trim();
        if (!name) fail("invalid", "A design system needs a name.");
        draft.name = name;
      }
      if (operation.description !== undefined) {
        draft.description = operation.description?.trim() || undefined;
      }
      return;
    }
    case "put_mode": {
      const name = operation.mode.name.trim();
      if (!name) fail("invalid", "A mode needs a name.");
      const at = draft.modes.findIndex((mode) => mode.id === operation.mode.id);
      if (at >= 0) {
        draft.modes[at] = { id: operation.mode.id, name };
        return;
      }
      if (draft.modes.length >= MAX_MODES) {
        fail("too_large", `A design system has at most ${MAX_MODES} modes.`);
      }
      draft.modes.push({ id: operation.mode.id, name });
      return;
    }
    case "delete_mode": {
      const at = draft.modes.findIndex((mode) => mode.id === operation.modeId);
      if (at < 0) fail("not_found", `No mode ${operation.modeId}.`);
      if (draft.modes.length === 1) fail("invalid", "A design system needs at least one mode.");
      draft.modes.splice(at, 1);
      const first = draft.modes[0]!.id;
      for (const [name, token] of draft.tokens) {
        const { [operation.modeId]: removed, ...kept } = token.values;
        // Modes fall back only on the first, so losing a later one changes no other value.
        if (removed === undefined && at > 0) continue;
        const values: Record<string, DesignTokenValue> = { ...kept };
        let next: DesignToken = { ...token, values };
        const own = at === 0 ? values[first] : undefined;
        if (at === 0 && own === undefined && removed !== undefined) {
          // The new first mode keeps the value it fell back on, read again in its own mode.
          values[first] = removed;
          draft.changed.add(name);
        } else if (at === 0 && own !== undefined && own.raw !== removed?.raw) {
          // Modes without a value of their own now fall back on a different one.
          if (draft.modes.some((mode) => values[mode.id] === undefined)) draft.changed.add(name);
          const { aliasOf: _aliasOf, ...rest } = next;
          const target = wholeReference(own.raw, draft.tokens);
          next = target !== null && target !== name ? { ...rest, aliasOf: target } : rest;
        }
        draft.tokens.set(name, next);
      }
      return;
    }
    case "put_token":
      return putToken(draft, operation.token, provenance);
    case "rename_token":
      return renameToken(draft, operation.from, operation.to, provenance);
    case "delete_token":
      return deleteToken(draft, operation.name);
    case "put_component": {
      const { component } = operation;
      if (!component.name.trim()) fail("invalid", "A component needs a name.");
      const at = draft.components.findIndex((candidate) => candidate.id === component.id);
      const before = at < 0 ? undefined : draft.components[at]!;
      if (before === undefined && draft.components.length >= MAX_COMPONENTS) {
        fail(
          "too_large",
          `A design system holds at most ${MAX_COMPONENTS.toLocaleString("en-US")} components.`,
        );
      }
      const next: DesignSystemComponent = {
        ...component,
        provenance:
          before !== undefined && sameComponent(before, component) ? before.provenance : provenance,
      };
      if (at < 0) draft.components.push(next);
      else draft.components[at] = next;
      return;
    }
    case "delete_component": {
      const at = draft.components.findIndex((component) => component.id === operation.componentId);
      if (at < 0) fail("not_found", `No component ${operation.componentId}.`);
      draft.components.splice(at, 1);
      return;
    }
  }
}

/** Applies `operations` in order; the first one that fails rejects the whole batch. */
export function applyDesignSystemOperations(
  system: DesignSystem,
  operations: ReadonlyArray<DesignSystemOperation>,
  context: DesignSystemEditContext,
): DesignSystemApplyOutcome {
  const draft: Draft = {
    name: system.name,
    description: system.description,
    modes: system.modes.map((mode) => ({ ...mode })),
    tokens: new Map(system.tokens.map((token) => [token.name, token])),
    components: [...system.components],
    changed: new Set(),
  };
  const provenance = editorProvenance(context.actor);
  for (const [index, operation] of operations.entries()) {
    try {
      applyOne(draft, operation, provenance);
    } catch (error) {
      if (error instanceof OperationFailure) {
        return { ok: false, code: error.code, detail: error.detail, index };
      }
      throw error;
    }
  }
  resolveChanged(draft.tokens, draft.modes[0]!.id, draft.changed);
  const { description: _description, ...rest } = system;
  return {
    ok: true,
    system: {
      ...rest,
      name: draft.name,
      ...(draft.description === undefined ? {} : { description: draft.description }),
      modes: draft.modes,
      tokens: [...draft.tokens.values()],
      components: draft.components,
      updatedAt: context.now,
    },
  };
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export interface ParsedColor {
  /** `#rrggbb`, lowercase; null for an oklch color, which is kept as written. */
  readonly hex: string | null;
  /** The color without its alpha: the hex, or `oklch(L C H)`. */
  readonly base: string;
  /** Opacity in whole percent, 0 to 100. */
  readonly alpha: number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

const toNumber = (text: string): number | null => (NUMBER.test(text) ? Number(text) : null);

/** `50%` or `0.5` as a whole percent. */
function alphaPercent(text: string | undefined): number | null {
  if (text === undefined) return 100;
  const percent = text.endsWith("%");
  const value = toNumber(percent ? text.slice(0, -1) : text);
  if (value === null) return null;
  return Math.round(clamp(percent ? value : value * 100, 0, 100));
}

const hexByte = (value: number) =>
  Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");

/** Channels and alpha of `rgb(1 2 3 / 50%)`, `rgba(1, 2, 3, 0.5)` and the like. */
function colorArguments(text: string): { channels: string[]; alpha?: string } | null {
  const slash = text.split("/");
  if (slash.length > 2) return null;
  if (slash.length === 2) {
    const channels = slash[0]!.trim().split(/\s+/);
    const alpha = slash[1]!.trim();
    return alpha ? { channels, alpha } : null;
  }
  const parts = text.includes(",")
    ? text.split(",").map((part) => part.trim())
    : text.trim().split(/\s+/);
  if (parts.length === 4) return { channels: parts.slice(0, 3), alpha: parts[3]! };
  return { channels: parts };
}

function rgbChannel(text: string): number | null {
  if (text.endsWith("%")) {
    const value = toNumber(text.slice(0, -1));
    return value === null ? null : clamp((value / 100) * 255, 0, 255);
  }
  const value = toNumber(text);
  return value === null ? null : clamp(value, 0, 255);
}

function hueDegrees(text: string): number | null {
  const match = /^(.*?)(deg|grad|rad|turn)?$/i.exec(text);
  const value = toNumber(match?.[1] ?? "");
  if (value === null) return null;
  const unit = match?.[2]?.toLowerCase();
  const degrees =
    unit === "turn"
      ? value * 360
      : unit === "rad"
        ? (value * 180) / Math.PI
        : unit === "grad"
          ? value * 0.9
          : value;
  return ((degrees % 360) + 360) % 360;
}

const percentOf = (text: string): number | null => {
  const value = toNumber(text.endsWith("%") ? text.slice(0, -1) : text);
  return value === null ? null : clamp(value, 0, 100) / 100;
};

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const amount = saturation * Math.min(lightness, 1 - lightness);
  const part = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    return lightness - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [part(0) * 255, part(8) * 255, part(4) * 255];
}

/**
 * Reads a color as hex plus alpha: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()`/`rgba()`, `hsl()`/`hsla()` and `transparent`. `oklch()` is kept as
 * written, with only its alpha read. Anything else (a reference, a named
 * color, `color-mix()`) is null.
 */
export function parseColor(value: string): ParsedColor | null {
  const text = value.trim();
  if (text.toLowerCase() === "transparent") return { hex: "#000000", base: "#000000", alpha: 0 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text);
  if (hex) {
    const digits = hex[1]!.toLowerCase();
    const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
    const rgb = `#${full.slice(0, 6)}`;
    const alpha = full.length === 8 ? Math.round((parseInt(full.slice(6), 16) / 255) * 100) : 100;
    return { hex: rgb, base: rgb, alpha };
  }
  const call = /^(rgba?|hsla?|oklch)\(\s*([^()]*?)\s*\)$/i.exec(text);
  if (!call) return null;
  const kind = call[1]!.toLowerCase();
  const args = colorArguments(call[2]!);
  if (args === null || args.channels.length !== 3) return null;
  const alpha = alphaPercent(args.alpha);
  if (alpha === null) return null;
  const [first, second, third] = args.channels as [string, string, string];
  if (kind === "oklch") {
    const lightness = toNumber(first.endsWith("%") ? first.slice(0, -1) : first);
    const chroma = toNumber(second.endsWith("%") ? second.slice(0, -1) : second);
    const hue = third.toLowerCase() === "none" ? 0 : hueDegrees(third);
    if (lightness === null || chroma === null || hue === null) return null;
    return { hex: null, base: `oklch(${first} ${second} ${third})`, alpha };
  }
  let channels: [number, number, number];
  if (kind.startsWith("rgb")) {
    const red = rgbChannel(first);
    const green = rgbChannel(second);
    const blue = rgbChannel(third);
    if (red === null || green === null || blue === null) return null;
    channels = [red, green, blue];
  } else {
    const hue = hueDegrees(first);
    const saturation = percentOf(second);
    const lightness = percentOf(third);
    if (hue === null || saturation === null || lightness === null) return null;
    channels = hslToRgb(hue, saturation, lightness);
  }
  const rgb = `#${channels.map(hexByte).join("")}`;
  return { hex: rgb, base: rgb, alpha };
}

/**
 * Writes a color with an alpha percent: `#rrggbb` when opaque, `#rrggbbaa`
 * otherwise; an oklch color keeps its form with `/ <alpha>%`. Null when
 * `color` is not one `parseColor` reads.
 */
export function formatColor(color: string, alpha = 100): string | null {
  const parsed = parseColor(color);
  if (parsed === null) return null;
  const percent = Math.round(clamp(alpha, 0, 100));
  if (parsed.hex !== null) {
    return percent >= 100 ? parsed.hex : `${parsed.hex}${hexByte((percent / 100) * 255)}`;
  }
  return percent >= 100 ? parsed.base : `${parsed.base.slice(0, -1)} / ${percent}%)`;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export interface TypographyParts {
  /** Keywords before the weight, such as `italic`; null when there are none. */
  readonly style: string | null;
  /** `600`, `bold`; null when the shorthand leaves it out. */
  readonly weight: string | null;
  readonly size: string;
  readonly lineHeight: string | null;
  /** The family list or reference, as written (`var(--font-sans)`, `Inter, sans-serif`). */
  readonly family: string;
}

const WEIGHT = /^(?:[1-9]\d{0,2}|1000|normal|bold|bolder|lighter)$/i;
const SIZE =
  /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|pt|pc|vw|vh|vmin|vmax|ch|ex|lh|rlh|cap|ic|cqw|cqh|q|mm|cm|in)|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger|(?:calc|clamp|min|max)\(.*\))$/i;

/** Whitespace-separated words outside parentheses and quotes, with their offsets. */
function words(text: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = -1;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    const space = char === undefined || (depth === 0 && /\s/.test(char));
    if (space) {
      if (start >= 0) out.push({ start, end: index, text: text.slice(start, index) });
      start = -1;
      continue;
    }
    if (start < 0) start = index;
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
  }
  return out;
}

/** Index of a `/` outside parentheses, or -1. */
function topLevelSlash(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "/" && depth === 0) return index;
  }
  return -1;
}

/**
 * Reads CSS font shorthand such as `600 32px/1.2 var(--font-sans)`. Null
 * when no size or family can be found (a bare reference, for example).
 */
export function parseTypography(value: string): TypographyParts | null {
  // `32px / 1.2` is the same as `32px/1.2`.
  const text = value.trim().replace(/\s*\/\s*/g, "/");
  const list = words(text);
  const sizeAt = list.findIndex((word) => {
    const slash = topLevelSlash(word.text);
    return SIZE.test(slash < 0 ? word.text : word.text.slice(0, slash)) || slash > 0;
  });
  if (sizeAt < 0 || sizeAt === list.length - 1) return null;
  const sizeWord = list[sizeAt]!;
  const slash = topLevelSlash(sizeWord.text);
  const size = slash < 0 ? sizeWord.text : sizeWord.text.slice(0, slash);
  const lineHeight = slash < 0 ? null : sizeWord.text.slice(slash + 1);
  if (!size || lineHeight === "") return null;
  let weight: string | null = null;
  const style: string[] = [];
  for (const word of list.slice(0, sizeAt)) {
    if (weight === null && WEIGHT.test(word.text)) weight = word.text;
    else style.push(word.text);
  }
  return {
    style: style.length > 0 ? style.join(" ") : null,
    weight,
    size,
    lineHeight,
    family: text.slice(sizeWord.end).trim(),
  };
}

/** CSS font shorthand from its parts, the inverse of `parseTypography`. */
export function formatTypography(parts: TypographyParts): string {
  return [
    parts.style,
    parts.weight,
    parts.lineHeight === null ? parts.size : `${parts.size}/${parts.lineHeight}`,
    parts.family.trim(),
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ");
}

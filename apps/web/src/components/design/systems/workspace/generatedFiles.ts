/**
 * Files the app builds from a design system instead of storing them:
 * `tokens.css` (one custom property per token and mode) and `tokens.json`.
 * They list in Files as generated and download like any other file.
 */
import type { DesignSystem, DesignToken, DesignTokenValue } from "@specweave-studio/contracts";

import type { BrowserFile } from "./filesModel";

export const GENERATED_FILE_PATHS = ["tokens.css", "tokens.json"] as const;

/** A token name as a custom property: `--` plus the name, with characters CSS does not take bare escaped. */
export function customProperty(name: string): string {
  return `--${name.replace(/[^A-Za-z0-9_-]/g, (character) => `\\${character}`)}`;
}

/** `{brand.500}` references become `var(--brand\.500)`; line breaks and stray braces cannot end the rule. */
function cssValue(raw: string): string {
  return raw
    .replace(/\{([A-Za-z0-9._-]+)\}/g, (_match, name: string) => `var(${customProperty(name)})`)
    .replace(/[\r\n]+/g, " ")
    .replace(/[{}]/g, "")
    .replace(/;+\s*$/, "")
    .trim();
}

/** The value a token has in a mode: that mode's, else `default`, else the first mode's. */
function valueIn(
  token: DesignToken,
  modeId: string,
  firstModeId: string,
): DesignTokenValue | undefined {
  return token.values[modeId] ?? token.values.default ?? token.values[firstModeId];
}

const commentText = (text: string) => text.replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ");

/**
 * Custom properties per mode: the first mode on `:root`, each other mode
 * under `[data-theme="<id>"]` with only the values that differ from it.
 */
export function buildTokensCss(system: DesignSystem): string {
  const [first, ...others] = system.modes;
  const firstId = first?.id ?? "default";
  const lines = [
    `/* Generated from the design system "${commentText(system.name)}" (revision ${system.revision}). */`,
    "/* Do not edit: the app writes this file again from the tokens. */",
    "",
  ];
  const block = (selector: string, declarations: string[], label: string) => {
    if (declarations.length === 0) return;
    lines.push(`/* ${commentText(label)} */`, `${selector} {`, ...declarations, "}", "");
  };
  const rootDeclarations: string[] = [];
  for (const token of system.tokens) {
    const value = valueIn(token, firstId, firstId);
    if (value === undefined) continue;
    const css = cssValue(value.raw);
    if (css !== "") rootDeclarations.push(`  ${customProperty(token.name)}: ${css};`);
  }
  block(":root", rootDeclarations, first?.name ?? "Default");
  for (const mode of others) {
    const declarations: string[] = [];
    for (const token of system.tokens) {
      const own = token.values[mode.id];
      if (own === undefined) continue;
      const base = valueIn(token, firstId, firstId);
      if (base !== undefined && base.raw === own.raw) continue;
      const css = cssValue(own.raw);
      if (css !== "") declarations.push(`  ${customProperty(token.name)}: ${css};`);
    }
    block(`[data-theme="${mode.id.replace(/["\\]/g, "")}"]`, declarations, mode.name);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** The tokens as JSON: raw values per mode, resolved values where they differ, notes and aliases. */
export function buildTokensJson(system: DesignSystem): string {
  const tokens: Record<string, unknown> = {};
  for (const token of system.tokens) {
    const values: Record<string, string> = {};
    const resolved: Record<string, string | null> = {};
    for (const [modeId, value] of Object.entries(token.values)) {
      values[modeId] = value.raw;
      if (value.resolved !== value.raw) resolved[modeId] = value.resolved;
    }
    tokens[token.name] = {
      type: token.type,
      ...(token.group === undefined ? {} : { group: token.group }),
      ...(token.description === undefined ? {} : { description: token.description }),
      ...(token.aliasOf === undefined ? {} : { aliasOf: token.aliasOf }),
      values,
      ...(Object.keys(resolved).length === 0 ? {} : { resolved }),
    };
  }
  const document = {
    $generated: "Generated from this design system by the app. Do not edit.",
    name: system.name,
    ...(system.description === undefined ? {} : { description: system.description }),
    revision: system.revision,
    modes: system.modes.map((mode) => ({ id: mode.id, name: mode.name })),
    tokens,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Both generated files as Files entries, carrying their text. */
export function generatedFiles(system: DesignSystem): BrowserFile[] {
  const css = buildTokensCss(system);
  const json = buildTokensJson(system);
  return [
    {
      path: "tokens.css",
      origin: "generated",
      bytes: byteLength(css),
      mimeType: "text/css",
      updatedAt: system.updatedAt,
      text: css,
    },
    {
      path: "tokens.json",
      origin: "generated",
      bytes: byteLength(json),
      mimeType: "application/json",
      updatedAt: system.updatedAt,
      text: json,
    },
  ];
}

/**
 * Merges what the extractors collected from several files into one sorted
 * extraction: modes in a stable order (base first), tokens by name (the first
 * source in path order wins a mode; a different value later is reported),
 * references resolved per mode, then types and groups inferred where the
 * source did not state them.
 */
import type { DesignSystemComponent, DesignSystemFinding } from "@specweave-studio/contracts";

import { groupTokens, inferTokenType } from "./classify.ts";
import {
  type Collected,
  type ExtractedMode,
  type Extraction,
  type MutableToken,
  compareText,
  finding,
  sortComponents,
  sortFindings,
  sortTokens,
} from "./common.ts";
import { referenceName } from "./extractDtcg.ts";
import {
  type ReferenceFinder,
  braceReferences,
  cssReferences,
  resolveModes,
} from "./resolveModes.ts";

const braces = braceReferences(referenceName);

/** CSS `var()` and DTCG `{a.b}` references, in text order. */
export const anyReferences: ReferenceFinder = (raw) =>
  [...cssReferences(raw), ...(raw.includes("{") ? braces(raw) : [])].sort(
    (left, right) => left.start - right.start,
  );

const BASE_MODES = ["light", "default"];

export const baseModeOf = (modes: ReadonlyArray<ExtractedMode>): string =>
  BASE_MODES.find((id) => modes.some((mode) => mode.id === id)) ?? modes[0]?.id ?? "default";

export const assemble = (parts: ReadonlyArray<Collected>): Extraction => {
  const modes: ExtractedMode[] = [];
  const tokens = new Map<string, MutableToken>();
  const components = new Map<string, DesignSystemComponent>();
  const findings: DesignSystemFinding[] = [];

  for (const part of parts) {
    for (const mode of part.modes)
      if (!modes.some((known) => known.id === mode.id)) modes.push(mode);
    findings.push(...part.findings);
    for (const incoming of part.tokens) {
      const existing = tokens.get(incoming.name);
      if (existing === undefined) {
        tokens.set(incoming.name, {
          ...incoming,
          values: { ...incoming.values },
        });
        continue;
      }
      for (const [mode, value] of Object.entries(incoming.values)) {
        const current = existing.values[mode];
        if (current === undefined) {
          existing.values[mode] = value;
        } else if (current.raw !== value.raw) {
          findings.push(
            finding(
              "conflict",
              "warning",
              `${incoming.name} (${mode}) is ${current.raw} in ${current.provenance.location}:${current.provenance.line ?? "?"} and ${value.raw} here; the first is kept`,
              value.provenance.location,
              value.provenance.line,
            ),
          );
        }
      }
      if (existing.description === undefined && incoming.description !== undefined) {
        existing.description = incoming.description;
      }
      if (!existing.explicitType && incoming.explicitType) {
        existing.type = incoming.type;
        existing.explicitType = true;
      }
      if (existing.group === undefined && incoming.group !== undefined)
        existing.group = incoming.group;
    }
    for (const component of part.components)
      if (!components.has(component.id)) components.set(component.id, component);
  }

  const baseMode = baseModeOf(modes);
  const orderedModes = [
    ...modes.filter((mode) => mode.id === baseMode),
    ...modes.filter((mode) => mode.id === "dark" && mode.id !== baseMode),
    ...modes.filter((mode) => mode.id !== baseMode && mode.id !== "dark"),
  ];

  findings.push(
    ...resolveModes(tokens, {
      baseMode,
      modes: orderedModes.map((mode) => mode.id),
      references: anyReferences,
    }),
  );

  for (const token of tokens.values()) {
    if (token.explicitType) continue;
    const sample = token.values[baseMode] ?? Object.values(token.values)[0];
    token.type = inferTokenType(token.name, sample?.resolved ?? sample?.raw ?? "");
  }
  const ungrouped = [...tokens.values()].filter((token) => token.group === undefined);
  const groups = groupTokens(ungrouped.sort((left, right) => compareText(left.name, right.name)));
  for (const token of ungrouped) {
    const group = groups.get(token.name);
    if (group !== undefined) token.group = group;
  }

  return {
    modes: orderedModes,
    tokens: sortTokens(tokens.values()),
    components: sortComponents(components.values()),
    findings: sortFindings(findings),
  };
};

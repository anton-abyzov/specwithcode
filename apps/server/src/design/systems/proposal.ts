// @effect-diagnostics nodeBuiltinImport:off - Plain promises over files inside one approved root.
/**
 * Turns selected sources into a proposal and a confirmed review into the
 * system that gets written. Extraction output depends only on file bytes;
 * timestamps live in the wrapper (`createdAt`, `readAt`), never in tokens.
 *
 * Review rules: an unticked added item is not written; an unticked changed
 * item keeps its previous value; an unticked removed item stays. Items that
 * only moved (provenance changed, values did not) count as unchanged and are
 * written with their new provenance.
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  DESIGN_SYSTEM_SCHEMA,
  type DesignActor,
  type DesignOwnerInput,
  type DesignSystem,
  type DesignSystemComponent,
  type DesignSystemComponentChange,
  type DesignSystemConfirmInput,
  type DesignSystemFinding,
  type DesignSystemLineage,
  type DesignSystemProposal,
  type DesignSystemProposalOrigin,
  type DesignSystemSource,
  type DesignSystemTokenChange,
  type DesignSystemTokensFile,
  type DesignToken,
} from "@specweave-studio/contracts";

import { assemble } from "./assemble.ts";
import {
  type Collected,
  type Extraction,
  type SourceText,
  compareText,
  finding,
  safeId,
  sha256Hex,
  sortFindings,
  sourceText,
  customPropertyNames,
  modeName,
} from "./common.ts";
import {
  type ComponentReader,
  discoverBarrel,
  discoverCssClasses,
  discoverFolder,
} from "./discoverComponents.ts";
import { collectCss } from "./extractCss.ts";
import { collectDtcg, detectTokenJson } from "./extractDtcg.ts";
import { collectTsTheme, loadTypeScript, tsThemeKeys } from "./extractTsTheme.ts";
import { collectWeave, crossCheckWeave, isWeaveTokens, weaveCopyDrift } from "./extractWeave.ts";
import {
  RootPathError,
  componentReadPlan,
  detectThemePrefix,
  dominantPrefix,
  preloadReader,
  readInsideRoot,
} from "./scanCandidates.ts";

export interface SourcedExtraction {
  readonly extraction: Extraction;
  /** Sources with their hashes; `readAt` is filled by the caller. */
  readonly sources: ReadonlyArray<Omit<DesignSystemSource, "readAt">>;
  readonly stylesheet?: string;
  /** Name taken from the sources (`"name"` of a Weave tokens file). */
  readonly suggestedName?: string;
}

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** One hash over every file a folder-like source read, so a rescan can compare it. */
export const digestOf = (files: ReadonlyArray<SourceText>): string =>
  sha256Hex(
    [...files]
      .sort((left, right) => compareText(left.path, right.path))
      .map((file) => `${file.path}\u0000${file.sha256}\n`)
      .join(""),
  );

/** Lists folders under the root by name only (no file contents), for component reads and copy lookup. */
export const listFolders = async (realRoot: string, start = ""): Promise<Map<string, string[]>> => {
  const folders = new Map<string, string[]>();
  const queue = [start];
  let seen = 0;
  while (queue.length > 0 && seen < 60_000) {
    const folder = queue.shift()!;
    let entries;
    try {
      entries = await NodeFS.readdir(NodePath.join(realRoot, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => compareText(left.name, right.name));
    const files: string[] = [];
    for (const entry of entries) {
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (
          !entry.name.startsWith(".") &&
          !/^(?:node_modules|dist|build|out|coverage|vendor|target|storybook-static|playwright-report|test-results)$/.test(
            entry.name,
          )
        ) {
          queue.push(relative);
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative);
        seen += 1;
      }
    }
    folders.set(folder, files);
  }
  return folders;
};

const isFolderSource = (folders: ReadonlyMap<string, ReadonlyArray<string>>, path: string) =>
  folders.has(path);

/**
 * Reads the selected paths inside the root and extracts them together, so
 * references between files resolve (a stylesheet reading another's tokens).
 */
export const extractFromCode = async (
  realRoot: string,
  paths: ReadonlyArray<string>,
): Promise<SourcedExtraction> => {
  const unique = [...new Set(paths)].sort(compareText);
  const folders = await listFolders(realRoot);
  const findings: DesignSystemFinding[] = [];
  const sources: Array<Omit<DesignSystemSource, "readAt">> = [];
  const texts = new Map<string, SourceText>();
  for (const path of unique) {
    if (isFolderSource(folders, path)) continue;
    try {
      texts.set(path, await readInsideRoot(realRoot, path));
    } catch (error) {
      const reason = error instanceof RootPathError ? error.reason : "unreadable";
      findings.push(finding("unreadable", "warning", `${path} was not read (${reason})`, path));
    }
  }

  const weaveJson = [...texts.values()].filter(
    (source) => source.path.endsWith(".json") && isWeaveTokens(source.text),
  );
  const weaveSheets = new Set(
    weaveJson.flatMap((json) =>
      [...texts.values()]
        .filter(
          (source) => source.path.endsWith(".css") && folderOf(source.path) === folderOf(json.path),
        )
        .map((source) => source.path),
    ),
  );
  const cssTexts = [...texts.values()]
    .filter((source) => source.path.endsWith(".css"))
    .map((source) => source.text);
  const parts: Collected[] = [];
  let stylesheet: string | undefined;
  let suggestedName: string | undefined;

  for (const path of unique) {
    if (isFolderSource(folders, path)) {
      const ts = await loadTypeScript();
      const plan = componentReadPlan(new Map([[path, folders.get(path) ?? []]]), path);
      const reader = await preloadReader(realRoot, folders, plan);
      const discovered = discoverFolder(ts, reader, path);
      parts.push({
        modes: [],
        tokens: [],
        components: discovered.components,
        findings: discovered.findings,
      });
      sources.push({ kind: "file", location: path, sha256: digestOf(readFiles(reader, plan)) });
      continue;
    }
    const source = texts.get(path);
    if (!source) continue;
    if (path.endsWith(".json")) {
      if (isWeaveTokens(source.text)) {
        const collected = collectWeave(source);
        parts.push(collected);
        suggestedName ??= /"name"\s*:\s*"([^"]{1,180})"/.exec(source.text)?.[1];
        const sheet = [...weaveSheets].find((sheetPath) => folderOf(sheetPath) === folderOf(path));
        if (sheet) {
          const css = texts.get(sheet)!;
          findings.push(...crossCheckWeave(collected, collectCss(css), sheet));
          findings.push(...(await weaveDriftFindings(realRoot, folders, css)));
        }
      } else if (detectTokenJson(source.text) !== null) {
        parts.push(collectDtcg(source));
      } else {
        findings.push(
          finding("unsupported", "warning", `${path} is not a recognized token file`, path),
        );
      }
      sources.push({ kind: "file", location: path, sha256: source.sha256 });
    } else if (path.endsWith(".css")) {
      if (weaveSheets.has(path)) {
        // The JSON is authoritative for tokens; the stylesheet gives the component classes.
        const prefix = dominantPrefix(customPropertyNames(source.text)) ?? undefined;
        const classes = discoverCssClasses(source, prefix);
        parts.push({
          modes: [],
          tokens: [],
          components: classes.components,
          findings: classes.findings,
        });
        stylesheet ??= source.text;
      } else {
        const collected = collectCss(source);
        const prefix = dominantPrefix(collected.tokens.map((token) => token.name));
        const classes = prefix
          ? discoverCssClasses(source, prefix)
          : { components: [], findings: [] };
        parts.push({ ...collected, components: classes.components });
        if (classes.components.length > 0) stylesheet ??= source.text;
      }
      sources.push({ kind: "file", location: path, sha256: source.sha256 });
    } else if (/\.tsx?$/.test(path)) {
      const ts = await loadTypeScript();
      if (/(?:^|\/)index\.tsx?$/.test(path)) {
        const plan = componentReadPlan(folders, folderOf(path));
        const reader = await preloadReader(realRoot, folders, plan);
        const discovered = discoverBarrel(ts, reader, source);
        parts.push({
          modes: [],
          tokens: [],
          components: discovered.components,
          findings: discovered.findings,
        });
        sources.push({ kind: "file", location: path, sha256: digestOf(readFiles(reader, plan)) });
      } else {
        const { keys } = tsThemeKeys(ts, source);
        const prefix = detectThemePrefix(keys, cssTexts);
        parts.push(collectTsTheme(ts, source, prefix ? { prefix } : {}));
        sources.push({ kind: "file", location: path, sha256: source.sha256 });
      }
    }
  }
  const extraction = assemble(parts);
  return {
    extraction: { ...extraction, findings: sortFindings([...extraction.findings, ...findings]) },
    sources: sources.sort((left, right) => compareText(left.location, right.location)),
    ...(stylesheet !== undefined ? { stylesheet } : {}),
    ...(suggestedName !== undefined ? { suggestedName } : {}),
  };
};

const readFiles = (reader: ComponentReader, plan: ReadonlyArray<string>): SourceText[] =>
  plan.map((path) => reader.read(path)).filter((source): source is SourceText => source !== null);

/** Other files with the stylesheet's name inside the root are copies; each difference is drift. */
const weaveDriftFindings = async (
  realRoot: string,
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
  canonical: SourceText,
): Promise<DesignSystemFinding[]> => {
  const name = baseName(canonical.path);
  const copies = [...folders.values()]
    .flat()
    .filter((path) => baseName(path) === name && path !== canonical.path)
    .sort(compareText);
  const findings: DesignSystemFinding[] = [];
  for (const path of copies.slice(0, 20)) {
    try {
      const copy = await readInsideRoot(realRoot, path);
      if (!/--[a-z0-9]+-/.test(copy.text)) continue;
      const drift = weaveCopyDrift(canonical, copy);
      if (drift.length === 0) {
        findings.push(
          finding("copy", "info", `${path} is an identical copy of ${canonical.path}`, path),
        );
      }
      findings.push(...drift);
    } catch {
      // A copy that cannot be read safely is ignored.
    }
  }
  return findings;
};

/**
 * Token files the user picked (a Figma variables export or any DTCG file).
 * Their contents arrive in the request; nothing is read from disk.
 */
export const extractFromTokensFiles = (
  files: ReadonlyArray<DesignSystemTokensFile>,
): SourcedExtraction => {
  const nameOf = (file: DesignSystemTokensFile) => baseName(file.fileName.replace(/\\/g, "/"));
  const sorted = [...files].sort((left, right) => compareText(nameOf(left), nameOf(right)));
  const parts: Collected[] = [];
  const findings: DesignSystemFinding[] = [];
  const sources: Array<Omit<DesignSystemSource, "readAt">> = [];
  for (const file of sorted) {
    const name = nameOf(file);
    const source = sourceText(name, file.contents);
    const form = detectTokenJson(file.contents);
    if (isWeaveTokens(file.contents)) {
      parts.push(collectWeave(source));
    } else if (form !== null) {
      parts.push(collectDtcg(source, { origin: "figma-export" }));
    } else {
      findings.push(
        finding("unsupported", "warning", `${name} is not a DTCG or Figma variables export`, name),
      );
      continue;
    }
    sources.push({ kind: "figma-export", location: name, sha256: source.sha256 });
  }
  const extraction = assemble(parts);
  return {
    extraction: { ...extraction, findings: sortFindings([...extraction.findings, ...findings]) },
    sources,
  };
};

// ---------------------------------------------------------------------------
// Diff and review
// ---------------------------------------------------------------------------

const semanticToken = (token: DesignToken) =>
  JSON.stringify({
    type: token.type,
    group: token.group ?? null,
    description: token.description ?? null,
    aliasOf: token.aliasOf ?? null,
    values: Object.keys(token.values)
      .sort(compareText)
      .map((mode) => [mode, token.values[mode]!.raw, token.values[mode]!.resolved]),
  });

const semanticComponent = (component: DesignSystemComponent) => {
  const { provenance: _provenance, ...rest } = component;
  return JSON.stringify(rest, Object.keys(rest).sort(compareText));
};

export const diffTokens = (
  next: ReadonlyArray<DesignToken>,
  previous: ReadonlyArray<DesignToken>,
): DesignSystemTokenChange[] => {
  const before = new Map(previous.map((token) => [token.name, token]));
  const after = new Map(next.map((token) => [token.name, token]));
  const changes: DesignSystemTokenChange[] = [];
  for (const token of next) {
    const old = before.get(token.name);
    if (old === undefined) changes.push({ name: token.name, change: "added", token });
    else if (semanticToken(old) !== semanticToken(token))
      changes.push({ name: token.name, change: "changed", token, previous: old });
    else changes.push({ name: token.name, change: "unchanged", token });
  }
  for (const token of previous)
    if (!after.has(token.name)) changes.push({ name: token.name, change: "removed", token });
  return changes.sort((left, right) => compareText(left.name, right.name));
};

export const diffComponents = (
  next: ReadonlyArray<DesignSystemComponent>,
  previous: ReadonlyArray<DesignSystemComponent>,
): DesignSystemComponentChange[] => {
  const before = new Map(previous.map((component) => [component.id, component]));
  const after = new Map(next.map((component) => [component.id, component]));
  const changes: DesignSystemComponentChange[] = [];
  for (const component of next) {
    const old = before.get(component.id);
    if (old === undefined) changes.push({ id: component.id, change: "added", component });
    else if (semanticComponent(old) !== semanticComponent(component))
      changes.push({ id: component.id, change: "changed", component, previous: old });
    else changes.push({ id: component.id, change: "unchanged", component });
  }
  for (const component of previous)
    if (!after.has(component.id)) changes.push({ id: component.id, change: "removed", component });
  return changes.sort((left, right) => compareText(left.id, right.id));
};

export interface ProposalInput {
  readonly id: string;
  readonly owner: DesignOwnerInput;
  readonly origin: DesignSystemProposalOrigin;
  readonly createdBy: DesignActor;
  readonly now: string;
  readonly sourced: SourcedExtraction;
  /** The system being updated, or null for a new one. */
  readonly previous: DesignSystem | null;
  readonly systemId: string;
  readonly name: string;
  readonly description?: string;
  /** Lineage to a system the owner holds; replaces the previous revision's when either is given. */
  readonly derivedFrom?: DesignSystemLineage;
  readonly derivedFromLabel?: string;
}

export const buildProposal = (input: ProposalInput): DesignSystemProposal => {
  const { extraction } = input.sourced;
  const previous = input.previous;
  const description = input.description ?? previous?.description;
  const lineageGiven = input.derivedFrom !== undefined || input.derivedFromLabel !== undefined;
  const derivedFrom = lineageGiven ? input.derivedFrom : previous?.derivedFrom;
  const derivedFromLabel = lineageGiven ? input.derivedFromLabel : previous?.derivedFromLabel;
  const stylesheet = input.sourced.stylesheet ?? previous?.stylesheet;
  const system: DesignSystem = {
    schema: DESIGN_SYSTEM_SCHEMA,
    id: input.systemId,
    name: previous?.name ?? input.name,
    ...(description !== undefined ? { description } : {}),
    revision: previous ? previous.revision + 1 : 0,
    createdAt: previous?.createdAt ?? input.now,
    updatedAt: input.now,
    modes:
      extraction.modes.length > 0
        ? extraction.modes.map((mode) => ({
            id: safeId(mode.id, "default"),
            name: mode.name.slice(0, 180),
          }))
        : [{ id: "default", name: "Default" }],
    tokens: [...extraction.tokens],
    components: [...extraction.components],
    ...(stylesheet !== undefined ? { stylesheet: stylesheet.slice(0, 1024 * 1024) } : {}),
    sources: input.sourced.sources.map((source) => ({ ...source, readAt: input.now })),
    ...(derivedFrom !== undefined ? { derivedFrom } : {}),
    ...(derivedFromLabel !== undefined ? { derivedFromLabel } : {}),
    copiedFrom: previous?.copiedFrom ?? null,
  };
  return {
    id: input.id,
    owner: input.owner,
    origin: input.origin,
    createdAt: input.now,
    createdBy: input.createdBy,
    target: previous ? { systemId: previous.id, revision: previous.revision } : null,
    system,
    tokens: diffTokens(system.tokens, previous?.tokens ?? []),
    components: diffComponents(system.components, previous?.components ?? []),
    findings: [...extraction.findings],
  };
};

/** The system to write after the user's review. */
export const applyReview = (
  proposal: DesignSystemProposal,
  review: Pick<DesignSystemConfirmInput, "excludeTokens" | "excludeComponents" | "name">,
): DesignSystem => {
  const excludedTokens = new Set(review.excludeTokens);
  const excludedComponents = new Set(review.excludeComponents);
  const tokens: DesignToken[] = [];
  for (const change of proposal.tokens) {
    const excluded = excludedTokens.has(change.name);
    if (change.change === "removed") {
      if (excluded) tokens.push(change.token);
    } else if (change.change === "changed" && excluded) {
      tokens.push(change.previous!);
    } else if (!(change.change === "added" && excluded)) {
      tokens.push(change.token);
    }
  }
  const components: DesignSystemComponent[] = [];
  for (const change of proposal.components) {
    const excluded = excludedComponents.has(change.id);
    if (change.change === "removed") {
      if (excluded) components.push(change.component);
    } else if (change.change === "changed" && excluded) {
      components.push(change.previous!);
    } else if (!(change.change === "added" && excluded)) {
      components.push(change.component);
    }
  }
  // Every mode a written value uses is declared: the new system's modes in
  // their order, then modes only kept tokens still use (a mode the source
  // dropped stays while the user keeps a value in it).
  const usedModes = new Set(tokens.flatMap((token) => Object.keys(token.values)));
  const declared = new Set(proposal.system.modes.map((mode) => mode.id));
  const modes = [
    ...proposal.system.modes.filter((mode) => usedModes.has(mode.id)),
    ...[...usedModes]
      .filter((id) => !declared.has(id))
      .sort(compareText)
      .map((id) => ({ id, name: modeName(id) })),
  ];
  return {
    ...proposal.system,
    name: proposal.target === null && review.name ? review.name : proposal.system.name,
    modes: modes.length > 0 ? modes : proposal.system.modes.slice(0, 1),
    tokens: tokens.sort((left, right) => compareText(left.name, right.name)),
    components: components.sort((left, right) => compareText(left.id, right.id)),
  };
};

export const proposalCounts = (proposal: DesignSystemProposal) => {
  const all = [...proposal.tokens, ...proposal.components];
  return {
    added: all.filter((change) => change.change === "added").length,
    changed: all.filter((change) => change.change === "changed").length,
    removed: all.filter((change) => change.change === "removed").length,
    findings: proposal.findings.length,
  };
};

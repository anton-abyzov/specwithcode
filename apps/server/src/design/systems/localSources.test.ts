// @effect-diagnostics nodeBuiltinImport:off - Writes the receipt with node:fs.
/**
 * Local-only check against real design systems on this Mac, read in place.
 * Runs only through scripts/studio-verify/design-systems-easychamp.mjs, which
 * sets DESIGN_SYSTEMS_RECEIPT; it is skipped everywhere else. The receipt
 * holds counts and file:line samples, never token values or source text.
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { extractFromCode } from "./proposal.ts";
import { scanCandidates } from "./scanCandidates.ts";

const receiptPath = process.env.DESIGN_SYSTEMS_RECEIPT;
const roots = {
  ecUikit: process.env.DESIGN_SYSTEMS_EC_UIKIT ?? "",
  umbrella: process.env.DESIGN_SYSTEMS_UMBRELLA ?? "",
  app: process.env.DESIGN_SYSTEMS_APP ?? "",
};

const where = (location: string | undefined, line: number | undefined) =>
  `${location ?? "?"}${line === undefined ? "" : `:${line}`}`;

async function measure(root: string, pick: (paths: string[]) => string[]) {
  const started = performance.now();
  const scan = await scanCandidates(root);
  const scanMs = Math.round(performance.now() - started);
  const paths = pick(scan.candidates.map((candidate) => candidate.path));
  const real = await NodeFS.realpath(root);
  const { extraction } = await extractFromCode(real, paths);
  return {
    root,
    scanMs,
    filesSeen: scan.filesSeen,
    candidates: scan.candidates.length,
    suggestions: scan.suggestions.map((suggestion) => ({
      key: suggestion.key,
      name: suggestion.name,
      paths: suggestion.paths,
      copies: suggestion.copies.length,
      ...(suggestion.derivedFromLabel === undefined
        ? {}
        : { derivedFromLabel: suggestion.derivedFromLabel }),
    })),
    truncated: scan.truncated,
    skippedByReason: Object.fromEntries(
      [...new Set(scan.skipped.map((skip) => skip.reason))]
        .sort()
        .map((reason) => [reason, scan.skipped.filter((skip) => skip.reason === reason).length]),
    ),
    proposedFrom: paths,
    modes: extraction.modes.map((mode) => mode.id),
    tokens: extraction.tokens.length,
    tokensByType: Object.fromEntries(
      [...new Set(extraction.tokens.map((token) => token.type))]
        .sort()
        .map((type) => [type, extraction.tokens.filter((token) => token.type === type).length]),
    ),
    components: extraction.components.length,
    tokenSamples: extraction.tokens.slice(0, 5).map((token) => {
      const value = Object.values(token.values)[0];
      return `${token.name} @ ${where(value?.provenance.location, value?.provenance.line)}`;
    }),
    componentSamples: extraction.components
      .slice(0, 5)
      .map(
        (component) =>
          `${component.name} @ ${where(component.provenance.location, component.provenance.line)}`,
      ),
    findings: extraction.findings.map(
      (finding) => `${finding.severity} ${finding.code}: ${finding.message.slice(0, 200)}`,
    ),
  };
}

describe.skipIf(receiptPath === undefined)("real design systems on this Mac", () => {
  it("measures ec-uikit, Weave and the app theme in place", { timeout: 120_000 }, async () => {
    const receipt = {
      ecUikit: await measure(roots.ecUikit, (paths) =>
        paths.filter(
          (path) => path === "src/styles/tokens.css" || path === "src/primitives/index.ts",
        ),
      ),
      weave: await measure(roots.umbrella, (paths) =>
        paths.filter((path) =>
          /(^|\/)specweave\/design\/weave\/(tokens\.json|weave\.css)$/.test(path),
        ),
      ),
      appTheme: await measure(roots.app, (paths) =>
        paths.filter(
          (path) =>
            path === "packages/shared/src/themePalettes.ts" || path === "apps/web/src/index.css",
        ),
      ),
    };
    await NodeFS.mkdir(NodePath.dirname(receiptPath!), { recursive: true });
    await NodeFS.writeFile(receiptPath!, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(receipt.ecUikit.tokens).toBeGreaterThan(0);
    expect(receipt.weave.tokens).toBeGreaterThan(0);
  });
});

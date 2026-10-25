// @effect-diagnostics nodeBuiltinImport:off - Reads a local checkout in place and writes the summary with node:fs.
/**
 * The scan against a real umbrella: EasyChamp's workspace on the maintainer's
 * Mac (`repositories/anton-abyzov/<repo>`, 40-odd checkouts, about 90,000
 * files), which ships its design system as ec-uikit and copies of its tokens
 * in other apps. Read-only: the scan and the preview only open files inside
 * the root and write nothing there. Skipped when the folder is absent (CI).
 * `STUDIO_EASYCHAMP_ROOT` points elsewhere; `STUDIO_EASYCHAMP_EVIDENCE` names
 * a file for the summary (counts and paths, no token values or source text).
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { SCAN_TIME_LIMIT_MS, scanCandidates } from "./scanCandidates.ts";
import { previewScan } from "./scanPreview.ts";

const ROOT = process.env.STUDIO_EASYCHAMP_ROOT ?? "/Users/you/Projects/sw-easychamp";
const EVIDENCE = process.env.STUDIO_EASYCHAMP_EVIDENCE;
const UIKIT = "repositories/anton-abyzov/ec-uikit";
const UIKIT_TOKENS = `${UIKIT}/src/styles/tokens.css`;
const COPIES = [
  "repositories/anton-abyzov/easychamp-status/public/assets/brand/uikit-tokens.css",
  "repositories/anton-abyzov/ec-snap/static/tokens.css",
];
/** Time to finish the file being read when the limit passes, and to group. */
const FINISH_MS = 1_500;

const listing = async (folder: string) =>
  NodeFS.existsSync(folder) ? (await NodeFSP.readdir(folder, { recursive: true })).sort() : null;

describe.skipIf(!NodeFS.existsSync(NodePath.join(ROOT, UIKIT_TOKENS)))(
  "scan of the EasyChamp umbrella (local, read-only)",
  () => {
    it(
      "offers ec-uikit first with its tokens, components and light and dark, within the time limit",
      { timeout: 60_000 },
      async () => {
        const designFolder = NodePath.join(ROOT, ".specweave/design");
        const before = await listing(designFolder);
        const started = performance.now();
        const scan = await scanCandidates(ROOT);
        const ms = Math.round(performance.now() - started);
        const previewStarted = performance.now();
        const previews = await previewScan(await NodeFSP.realpath(ROOT), scan);
        const previewMs = Math.round(performance.now() - previewStarted);

        const byPath = new Map(scan.candidates.map((candidate) => [candidate.path, candidate]));
        const summary = {
          root: ROOT,
          ms,
          previewMs,
          filesSeen: scan.filesSeen,
          truncated: scan.truncated,
          candidates: scan.candidates.length,
          suggestions: scan.suggestions.length,
          top: scan.suggestions.slice(0, 5).map((suggestion) => ({
            key: suggestion.key,
            name: suggestion.name,
            paths: suggestion.paths.length,
            tokens: suggestion.paths.reduce(
              (sum, path) => sum + (byPath.get(path)?.tokenCount ?? 0),
              0,
            ),
            components: suggestion.paths.reduce(
              (sum, path) => sum + (byPath.get(path)?.componentCount ?? 0),
              0,
            ),
            copies: suggestion.copies,
            ...(previews.has(suggestion.key)
              ? {
                  preview: {
                    ...previews.get(suggestion.key)!,
                    swatches: previews.get(suggestion.key)!.swatches.length,
                    sources: previews.get(suggestion.key)!.sources.length,
                  },
                }
              : {}),
          })),
        };
        if (EVIDENCE !== undefined) {
          await NodeFSP.mkdir(NodePath.dirname(EVIDENCE), { recursive: true });
          await NodeFSP.writeFile(EVIDENCE, `${JSON.stringify(summary, null, 2)}\n`);
        }

        const top = scan.suggestions[0]!;
        expect(top).toMatchObject({ key: `pkg:${UIKIT}`, name: "ec-uikit" });
        expect(top.paths).toContain(UIKIT_TOKENS);
        // October 23, 2026: 317 custom properties, 283 tokens, 321 components.
        expect(byPath.get(UIKIT_TOKENS)!.tokenCount).toBeGreaterThan(280);
        const preview = previews.get(top.key)!;
        expect(preview.tokens).toBeGreaterThan(250);
        expect(preview.modes).toEqual(expect.arrayContaining(["light", "dark"]));
        expect(preview.swatches).toHaveLength(8);
        expect(ms).toBeLessThan(SCAN_TIME_LIMIT_MS + FINISH_MS);
        // A busy machine can stop before every component folder or copy is counted
        // and says so; a full scan counts them all.
        if (scan.truncated) expect(preview.components).toBeGreaterThan(0);
        else {
          expect(preview.components).toBeGreaterThan(280);
          expect(top.copies).toEqual(expect.arrayContaining(COPIES));
        }
        expect(await listing(designFolder)).toEqual(before);
      },
    );
  },
);

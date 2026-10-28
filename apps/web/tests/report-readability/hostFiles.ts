/*
 * Markdown files agents write, as the document reader receives them. Values are
 * neutral stand-ins with the same shapes: 40- and 64-character digests, home
 * paths, statements one per line with no blank lines between them.
 */
export const DOCS = "/Users/example/Downloads/release-evidence";

const COMMIT = "4be1f0c9d2a7e65b31c8f09a7d4e2b6c58a1f3e0";
const DIGEST = "sha256:0d3c7e91b5a24f68c1e0973b2d5a8f4e6c19b07a3d2e58f1c4b6a9e07d3f2c81";

/** One statement per line, the way the October 21 release evidence was written. */
const STATEMENTS = [
  "# Release verified October 21, 2026",
  `API PR #480 merged at ${COMMIT}; release 39539928011 successful. Six API pods and one worker Ready, zero restarts; exact tag and registry digests verified. API health 200.`,
  `Console pods Ready with zero restarts at develop-4be1f0c, registry digest ${DIGEST}. Pod BUILD_ID q7VbN2xKpL9mRt4ZsW1cY matches the public sign-in response.`,
  "Read-only coach check at 04:16:13Z: owner report 403, clearance 200, zero rows, zero production mutations.",
  "No accepted contracts, stored season policies, billing activation, charges or outbound messages changed.",
  `Private report: ${DOCS}/report.html`,
  `Unsent drafts: ${DOCS}/message-drafts.md`,
  "",
].join("\n");

/** Prose hard-wrapped at 72 columns: its lines are one paragraph and stay one. */
const WRAPPED = [
  "# Hard-wrapped notes",
  "",
  "The import reads every registration export in the folder and keeps the",
  "newest row for each player. Payments that Square reports as refunded are",
  "subtracted once. A player who joined in October owes the months from the",
  "joining month to the end of the season, not the full six installments.",
  "",
  "Short label lines keep their own lines:",
  "Owner: club office",
  "Status: waiting for the export",
  "",
].join("\n");

/** A well-formed report: every structure the reader already handles must not move. */
const STRUCTURED = [
  "---",
  "status: verified",
  "owner: release worker",
  "---",
  "",
  "# Structured release report",
  "",
  "The console and API releases are live. Each check below ran against production read-only.",
  "",
  "## Checks",
  "",
  "- Pods: 6/6 Ready, zero restarts",
  `- Commit: \`${COMMIT}\``,
  `- Evidence: [release-result.md](${DOCS}/release-result.md)`,
  "",
  "| Check | Result | Proof |",
  "| --- | --- | --- |",
  "| Health | 200 | `curl -fsS /health` |",
  `| Digest | matched | \`${DIGEST}\` |`,
  "",
  "```sh",
  "kubectl get pods -n console -o wide",
  "```",
  "",
  "## Remaining",
  "",
  "Owner-view acceptance waits for the office account check.",
  "",
].join("\n");

/** Unbroken tokens on a phone: digests, deep paths and a long URL. */
const LONG_TOKENS = [
  "# Long values",
  "",
  `Digest ${DIGEST} was read from the registry.`,
  "",
  `Report at ${DOCS}/very-long-folder-name-for-the-october-season-import/per-player-balances-as-of-today.html with drafts beside it.`,
  "",
  "Run https://github.com/example-org/example-console/actions/runs/39541888053/job/112233445566778899 passed.",
  "",
].join("\n");

/**
 * A dense comparison the way the October 27 skills report was written: five
 * prose-heavy columns of identifiers, then a two-column table, a table of
 * values that cannot wrap and two columns of commands.
 */
const COMPARISON = [
  "# Which planning skill runs when",
  "",
  "Short answer: two separate skills, and neither runs when a project is created.",
  "",
  "## Skills",
  "",
  "| Skill | What it is | State in 3.1.14 | When it runs | Where results live |",
  "| --- | --- | --- | --- | --- |",
  "| Old `sw:grill` | A relentless code-review gate that ran before `sw:done` | **Deleted** in 2.0.0 (`51e280c05`, September 2). The `grill` config key is dead | Never | Replaced by the fresh-context `sw-review`; the only hard close gate is `specweave verify` |",
  "| `sw-brainstorm` | The earlier decision interview | **Retired** in 3.1.0 (#2078) and removed from projects on update | Never | Its decide step moved into `sw-increment` and `sw-grill-me` |",
  `| \`sw-grill-me\` | A relentless planning interview: it asks in rounds until every decision is settled | **Core** since 3.1.14; optional from 3.1.0 | When you ask, or when \`planning.deepInterview: deep\` is set | The spec's decisions section, beside [release-result.md](${DOCS}/release-result.md) |`,
  "",
  "## Checks",
  "",
  "| Check | Result |",
  "| --- | --- |",
  "| Installed skills | Both are present in the global CLI and in the project, with the same contents |",
  "| Project creation | Neither skill runs; creation only writes the folder layout |",
  "",
  "## Values",
  "",
  "| Item | Value | Note |",
  "| --- | --- | --- |",
  `| Registry digest | \`${DIGEST}\` | Read from the registry |`,
  "| Run | https://github.com/example-org/example-console/actions/runs/39541888053/job/112233445566778899 | Passed |",
  "",
  "## Commands",
  "",
  "| Check | Command |",
  "| --- | --- |",
  "| Readability | `node apps/web/tests/report-readability/verify.mjs --measure-only` |",
  "| Instructions | `node node_modules/vite-plus/bin/vp test run RuntimeInstructions.test.ts` |",
  "",
].join("\n");

/**
 * The table from the October 27 home cleanup report (screenshot 8465dc78),
 * sanitized: the same four columns, cell lengths and inline-code paths, which
 * render as file chips, with the home folder moved to /Users/example.
 */
const MOVES = [
  "# Home cleanup and remaining work",
  "",
  "A full recursive home size is deliberately not claimed: live application databases, provider state, cloud placeholders and protected archives were excluded.",
  "",
  "## Verified actions in this batch",
  "",
  "| Original path | Destination | Bytes | Reason |",
  "|---|---|---:|---|",
  ...[
    ["concert_v2_workflow.js", "Projects/experiments/concert-2026-06-13", "14,951"],
    ["concert_v3_workflow.js", "Projects/experiments/concert-2026-06-13", "16,862"],
    ["concert_video_research.js", "Projects/experiments/concert-2026-06-13", "4,376"],
    ["fable5-stream-script.md", "Projects/experiments/fable5-stream-2026-06-09", "15,289"],
    ["obs-bundle.sh", "scripts/obs", "3,038"],
    ["obs_auto_switch_back.py", "scripts/obs", "3,144"],
    ["n8n-start.sh", "scripts/n8n", "195"],
  ].map(
    ([name, folder, bytes]) =>
      `| \`/Users/example/${name}\` | \`/Users/example/${folder}/${name}\` | ${bytes} | Group related scripts; retain original compatibility path |`,
  ),
  "",
  "Receipts are in the evidence folder.",
  "",
].join("\n");

export const FIXTURE_DOCS = {
  statements: `${DOCS}/release-result.md`,
  wrapped: `${DOCS}/notes.md`,
  structured: `${DOCS}/structured.md`,
  longTokens: `${DOCS}/long-values.md`,
  comparison: `${DOCS}/skills-comparison.md`,
  moves: `${DOCS}/home-cleanup.md`,
} as const;

export const HOST_FILES = new Map<string, string>([
  [FIXTURE_DOCS.statements, STATEMENTS],
  [FIXTURE_DOCS.wrapped, WRAPPED],
  [FIXTURE_DOCS.structured, STRUCTURED],
  [FIXTURE_DOCS.longTokens, LONG_TOKENS],
  [FIXTURE_DOCS.comparison, COMPARISON],
  [FIXTURE_DOCS.moves, MOVES],
]);

/** The names directly in `folder`, or null when the host has no such folder. */
export function listFolder(folder: string): Array<{ path: string; kind: "file" }> | null {
  const prefix = `${folder.replace(/\/+$/, "")}/`;
  const names = [...HOST_FILES.keys()]
    .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
    .map((path) => ({ path: path.slice(prefix.length), kind: "file" as const }));
  return names.length > 0 ? names : null;
}

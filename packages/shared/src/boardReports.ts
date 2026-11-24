/**
 * The groups of an increment's `reports/` files, by path alone, so the server
 * that lists them and any client that shows them (even against an older
 * server) sort them the same way: what a person reads first, then reviews,
 * then screens and media, then the evidence a task's check left behind.
 */

export type BoardReportGroup = "report" | "review" | "image" | "evidence";

/** The order groups are listed and opened in. */
export const BOARD_REPORT_GROUPS: ReadonlyArray<BoardReportGroup> = [
  "report",
  "review",
  "image",
  "evidence",
];

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v)$/i;
const DOCUMENT =
  /\.(md|mdx|markdown|html?|pdf|docx|xlsx|pptx|csv|tsv|excalidraw|sheet\.json|canvas)$/i;
/** What `specweave task done --run` and `specweave verify` write. */
const EVIDENCE_NAME = /^(task-[^/]*\.(txt|log)|verify\.(json|md))$/i;
const REVIEW_NAME = /^review/i;

/** The part of a report's path inside `reports/`, with forward slashes. */
export function boardReportRelative(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const at = slashed.lastIndexOf("/reports/");
  return at === -1
    ? (slashed.split("/").at(-1) ?? slashed)
    : slashed.slice(at + "/reports/".length);
}

export function boardReportGroup(path: string): BoardReportGroup {
  const relative = boardReportRelative(path);
  const segments = relative.split("/").filter(Boolean);
  const name = segments.at(-1) ?? relative;
  if (IMAGE.test(name)) return "image";
  if (segments[0]?.toLowerCase() === "reviews" || REVIEW_NAME.test(name)) return "review";
  if (EVIDENCE_NAME.test(name)) return "evidence";
  return DOCUMENT.test(name) ? "report" : "evidence";
}

export const boardReportGroupRank = (group: BoardReportGroup): number =>
  BOARD_REPORT_GROUPS.indexOf(group);

/**
 * Reports by group, keeping the given order inside each group (the server
 * lists newest first). Stable, and a new array.
 */
export function orderBoardReports<T extends { readonly path: string }>(
  reports: ReadonlyArray<T>,
): T[] {
  return reports
    .map((report, index) => ({
      report,
      index,
      rank: boardReportGroupRank(boardReportGroup(report.path)),
    }))
    .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.report);
}

/**
 * The report the Reports button opens: the first real report, else review,
 * else image, else evidence. Null for none.
 */
export function bestBoardReport<T extends { readonly path: string }>(
  reports: ReadonlyArray<T>,
): T | null {
  return orderBoardReports(reports)[0] ?? null;
}

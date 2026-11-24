/**
 * The increment panel's reports: what a person reads (reports, reviews,
 * screens) by group, and the evidence a task's check left behind folded
 * underneath. Groups come from each file's path (shared/boardReports), so an
 * older server's flat, newest-first list sorts the same way.
 */
import {
  BOARD_REPORT_GROUPS,
  bestBoardReport,
  boardReportGroup,
  boardReportRelative,
  type BoardReportGroup,
  orderBoardReports,
} from "@specweave-studio/shared/boardReports";
import {
  ClipboardCheckIcon,
  FileTextIcon,
  ImageIcon,
  MessageSquareQuoteIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type { BoardViewFile } from "./BoardIncrementView";

const GROUP_LABELS: Readonly<Record<BoardReportGroup, string>> = {
  report: "Reports",
  review: "Reviews",
  image: "Screens and media",
  evidence: "Task evidence",
};

const GROUP_ICONS: Readonly<Record<BoardReportGroup, LucideIcon>> = {
  report: FileTextIcon,
  review: MessageSquareQuoteIcon,
  image: ImageIcon,
  evidence: ClipboardCheckIcon,
};

/** A report with the name the panel shows: its path inside `reports/`. */
const shown = (report: BoardViewFile): BoardViewFile => ({
  path: report.path,
  name: boardReportRelative(report.path) || report.name,
});

/**
 * What the viewer steps through from one report: every file a person reads,
 * or, from a piece of evidence, the evidence alone.
 */
export function boardReportFileSet(
  reports: ReadonlyArray<BoardViewFile>,
  path: string,
): ReadonlyArray<BoardViewFile> {
  const ordered = orderBoardReports(reports).map(shown);
  const evidence = (report: BoardViewFile) => boardReportGroup(report.path) === "evidence";
  const opened = ordered.find((report) => report.path === path);
  if (opened === undefined) return ordered;
  const set = ordered.filter((report) => evidence(report) === evidence(opened));
  return set.length > 0 ? set : ordered;
}

/** The report the Reports button opens, with the files the viewer steps through. */
export function boardReportsOpening(
  reports: ReadonlyArray<BoardViewFile>,
): { readonly files: ReadonlyArray<BoardViewFile>; readonly path: string } | null {
  const best = bestBoardReport(reports);
  return best === null ? null : { files: boardReportFileSet(reports, best.path), path: best.path };
}

export function boardReportsNote(reports: ReadonlyArray<BoardViewFile>): string {
  const evidence = reports.filter((report) => boardReportGroup(report.path) === "evidence").length;
  const read = reports.length - evidence;
  if (read === 0) return `${evidence} task evidence`;
  return evidence === 0 ? String(read) : `${read} · ${evidence} evidence`;
}

export function BoardIncrementReports(props: {
  readonly reports: ReadonlyArray<BoardViewFile>;
  readonly onOpen: (files: ReadonlyArray<BoardViewFile>, path: string) => void;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const ordered = orderBoardReports(props.reports).map(shown);
  const groups = BOARD_REPORT_GROUPS.map((group) => ({
    group,
    files: ordered.filter((report) => boardReportGroup(report.path) === group),
  })).filter((entry) => entry.files.length > 0);
  // Only evidence: nothing to fold it under.
  const onlyEvidence = groups.every((entry) => entry.group === "evidence");
  return (
    <div className="sws-board-view-reports">
      {groups.map(({ group, files }) => {
        const folded = group === "evidence" && !onlyEvidence && !evidenceOpen;
        const Icon = GROUP_ICONS[group];
        return (
          <div className="sws-board-view-report-group" key={group} data-group={group}>
            {group === "evidence" && !onlyEvidence ? (
              <button
                type="button"
                className="sws-board-view-report-heading"
                aria-expanded={!folded}
                onClick={() => setEvidenceOpen((open) => !open)}
              >
                {GROUP_LABELS[group]} ({files.length})
              </button>
            ) : (
              <span className="sws-board-view-report-heading">
                {GROUP_LABELS[group]}
                {groups.length > 1 ? ` (${files.length})` : ""}
              </span>
            )}
            {folded ? null : (
              <ul className="sws-board-view-report-list">
                {files.map((report) => (
                  <li key={report.path}>
                    <button
                      type="button"
                      className="sws-board-view-report"
                      title={report.path}
                      onClick={() =>
                        props.onOpen(boardReportFileSet(props.reports, report.path), report.path)
                      }
                    >
                      <Icon aria-hidden />
                      <span className="sws-board-view-report-name">{report.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

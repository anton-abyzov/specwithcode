/**
 * When a reply reads as a document, shown as a report card, rather than an answer.
 * The rule lives in shared code so the server saves the same reports.
 */
export {
  asksForReport,
  MAX_REPORT_HEADINGS,
  MAX_REPORT_LINES,
  MAX_REPORT_WORDS,
  MIN_REQUESTED_REPORT_WORDS,
  shouldCollapseReport,
} from "@specweave-studio/shared/threadReport";

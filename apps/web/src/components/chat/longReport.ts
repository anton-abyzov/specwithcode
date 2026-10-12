/**
 * When a delegated agent's report is long enough to show as a report card.
 * The rule lives in shared code so the server saves the same reports.
 */
export {
  MAX_REPORT_HEADINGS,
  MAX_REPORT_LENGTH,
  MAX_REPORT_LINES,
  shouldCollapseReport,
} from "@specweave-studio/shared/threadReport";

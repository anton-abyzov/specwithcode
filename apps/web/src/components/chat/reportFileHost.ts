import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { createContext } from "react";

/** A file a report links to, as the report's markdown resolved it. */
export interface ReportFileTarget {
  readonly threadRef: ScopedThreadRef;
  /** The workspace the path is relative to; an absolute host path ignores it. */
  readonly cwd: string;
  readonly path: string;
  readonly line: number | undefined;
}

/**
 * Set by the report reader. The reader is a modal, so a file its links open in
 * the side panel would land behind its backdrop; inside the reader, links open
 * the file beside the report instead.
 */
export const ReportFileHostContext = createContext<{
  readonly open: (target: ReportFileTarget) => void;
} | null>(null);

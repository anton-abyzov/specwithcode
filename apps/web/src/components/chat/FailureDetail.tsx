import type { TimestampFormat } from "@specweave-studio/contracts/settings";
import { formatDisplayDates } from "../../lib/displayDates";

/** Keep persisted/provider diagnostics intact; only the visible prose is formatted. */
export function FailureDetail({
  message,
  timestampFormat,
}: {
  message: string;
  timestampFormat: TimestampFormat;
}) {
  return (
    <p className="ms-7 whitespace-pre-wrap break-words py-1 text-sm leading-relaxed text-foreground/80">
      {formatDisplayDates(message, timestampFormat)}
    </p>
  );
}

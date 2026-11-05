import { useTx } from "../../i18n";
export function UsageWarningLabel({
  resolved,
  resetTime,
}: {
  resolved: boolean;
  resetTime: string | null;
}) {
  const tx = useTx();
  return (
    <span
      className={`text-sm font-medium ${resolved ? "text-muted-foreground" : "text-warning-foreground"}`}
      title={
        resolved
          ? tx(
              "This chat continued. The original provider's included allowance may still be exhausted.",
            )
          : undefined
      }
    >
      {resolved
        ? tx("Usage limit resolved — chat continued.")
        : `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`}
    </span>
  );
}

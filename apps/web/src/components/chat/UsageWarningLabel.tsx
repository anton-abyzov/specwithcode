export function UsageWarningLabel({
  resolved,
  resetTime,
}: {
  resolved: boolean;
  resetTime: string | null;
}) {
  return (
    <span
      className={`text-sm font-medium ${resolved ? "text-muted-foreground" : "text-warning-foreground"}`}
      title={
        resolved
          ? "This chat continued. The original provider's included allowance may still be exhausted."
          : undefined
      }
    >
      {resolved
        ? "Usage limit resolved — chat continued."
        : `Usage limit reached.${resetTime ? ` Retry after ${resetTime}.` : ""}`}
    </span>
  );
}

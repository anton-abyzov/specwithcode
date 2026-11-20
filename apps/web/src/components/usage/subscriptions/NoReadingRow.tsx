import { AccountHeader } from "../AccountHeader";
import type { NoReadingRow as Row } from "./subscriptionRows";

/**
 * An enabled instance that reports no usage: who and where, and why there is
 * nothing to show. Its usage page link comes from the header, where the
 * driver and name resolve one.
 */
export function NoReadingRow({ row }: { readonly row: Row }) {
  return (
    <div
      className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-border/60 px-3 py-3 first:border-t-0 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,1fr)]"
      data-no-reading-row={row.key}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <AccountHeader
          driver={row.driver}
          label={row.name}
          plan={row.plan}
          email={row.email}
          subscription={row.subscription}
        />
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-full border border-border px-1.5">{row.machine}</span>
          {row.offline ? <span>offline</span> : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col justify-center text-xs text-muted-foreground">
        <span data-no-reading-message="">{row.message}</span>
      </div>
      <div className="flex min-w-0 flex-col justify-center text-xs text-muted-foreground">
        <span>A renewal day can be set once this account reports usage</span>
      </div>
    </div>
  );
}

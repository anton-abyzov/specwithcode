import { Fragment } from "react";
import { cn } from "~/lib/utils";
import { FallbackGlyph } from "./FallbackGlyph";
import type { ModelStateHeader } from "./fallbackStatus";

/**
 * The picker's fallback status, read top to bottom: what runs now, what the thread
 * was meant to use and why not, how it gets back, and the fallback order. The one
 * way back sits here; no banner repeats it. It stays a few lines tall so the model
 * list keeps its room below.
 */
export function FallbackStatusCard({ header }: { readonly header: ModelStateHeader }) {
  const structured = header.now != null || header.pick != null;
  const back = header.back ? (
    <button
      type="button"
      className="rounded border border-border bg-background px-1.5 py-0.5 text-foreground hover:bg-accent disabled:opacity-50 disabled:hover:bg-background"
      disabled={header.back.disabledReason !== null}
      title={header.back.disabledReason ?? undefined}
      onClick={header.back.onClick}
    >
      {header.back.label}
    </button>
  ) : null;
  const chain = header.chain && header.chain.length > 1 ? header.chain : null;
  return (
    <div
      role="status"
      // A short window scrolls the status, so the model list below keeps its rows.
      className="max-h-[min(15rem,35dvh)] min-h-16 shrink overflow-y-auto border-b border-warning/30 bg-warning/9 px-2.5 py-2 text-xs leading-snug"
      data-fallback-status="true"
    >
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <FallbackGlyph className="size-3.5 shrink-0 text-warning-foreground" />
        {header.title}
      </p>
      {structured ? (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5">
          {header.now ? (
            <>
              <dt className="text-muted-foreground">Now</dt>
              <dd className="min-w-0 truncate font-medium text-foreground" data-fallback-now>
                {header.now}
              </dd>
            </>
          ) : null}
          {header.pick ? (
            <>
              <dt className="text-muted-foreground">Meant for</dt>
              <dd className="min-w-0" data-fallback-pick>
                <span className="text-foreground">{header.pick.label}</span>
                <span className="text-muted-foreground"> · {header.pick.why}</span>
              </dd>
            </>
          ) : null}
          {header.returns ? (
            <>
              <dt className="text-muted-foreground">Return</dt>
              <dd className="min-w-0" data-fallback-return={header.returns.mode}>
                <span className="mr-1 rounded border border-border px-1 py-px text-3xs font-semibold uppercase leading-none tracking-wide text-foreground">
                  {header.returns.mode === "auto" ? "Automatic" : "By hand"}
                </span>
                <span className="text-muted-foreground">{header.returns.text}</span>
                {back ? <div className="mt-1">{back}</div> : null}
              </dd>
            </>
          ) : null}
          {chain ? (
            <>
              <dt className="text-muted-foreground">Order</dt>
              <dd className="min-w-0">
                <ol
                  className="flex flex-wrap items-center gap-x-1 gap-y-0.5"
                  aria-label="Fallback order"
                >
                  {chain.map((entry, index) => (
                    <Fragment key={`${entry.instanceId}\u0000${entry.model}`}>
                      {index > 0 ? (
                        <li aria-hidden className="text-muted-foreground">
                          ›
                        </li>
                      ) : null}
                      <li
                        className={cn(
                          "inline-flex min-w-0 items-center gap-1",
                          entry.role === "now"
                            ? "font-medium text-warning-foreground"
                            : entry.role === "pick"
                              ? "text-foreground"
                              : "text-muted-foreground",
                        )}
                        data-fallback-chain-role={entry.role ?? "order"}
                        title={entry.note ?? undefined}
                      >
                        {entry.position !== null ? (
                          <span
                            aria-hidden
                            className={cn(
                              "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border text-3xs font-semibold leading-none",
                              entry.role === "now" ? "border-warning/60" : "border-border",
                            )}
                          >
                            {entry.position}
                          </span>
                        ) : null}
                        <span className="truncate">{entry.label}</span>
                        {entry.role === "pick" ? (
                          <span className="text-muted-foreground">(pick)</span>
                        ) : null}
                        {entry.role === "now" ? <span>(now)</span> : null}
                        {entry.note ? (
                          <span className="text-muted-foreground">({entry.note})</span>
                        ) : null}
                      </li>
                    </Fragment>
                  ))}
                </ol>
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <>
          <p className="mt-0.5 text-muted-foreground">{header.detail}</p>
          {back ? <div className="mt-1.5">{back}</div> : null}
        </>
      )}
    </div>
  );
}

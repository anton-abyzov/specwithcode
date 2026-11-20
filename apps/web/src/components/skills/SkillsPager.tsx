import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { useTx } from "../../i18n";
import type { Page } from "~/lib/pagination";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

/**
 * "21–40 of 73" with Previous and Next, for a list that was filtered before it
 * was paged. Renders nothing while everything fits on one page, so a short
 * list looks as it always did.
 */
export function SkillsPager({
  page,
  onPage,
  label,
  pageSizes,
  onPageSize,
  className,
}: {
  page: Pick<Page<unknown>, "page" | "pageCount" | "pageSize" | "total" | "from" | "to">;
  onPage: (page: number) => void;
  /** What is being paged, for the buttons' accessible names: "skills". */
  label: string;
  /** Offered page sizes; left out, the size is fixed. */
  pageSizes?: ReadonlyArray<number>;
  onPageSize?: (size: number) => void;
  className?: string;
}) {
  const tx = useTx();
  const smallest = pageSizes ? Math.min(...pageSizes) : page.pageSize;
  // One page and nothing a larger size would change: no control to show.
  if (page.pageCount <= 1 && page.total <= smallest) return null;
  return (
    <nav
      aria-label={tx("Pages of {label}", { label })}
      data-testid="skills-pager"
      className={cn("flex flex-wrap items-center justify-between gap-2 text-xs", className)}
    >
      <span className="tabular-nums text-muted-foreground" role="status" data-testid="pager-range">
        {tx("{from}–{to} of {total}", { from: page.from, to: page.to, total: page.total })}
      </span>
      <span className="flex items-center gap-1">
        {pageSizes && onPageSize ? (
          <span className="me-1 flex items-center gap-1" role="group" aria-label={tx("Per page")}>
            <span className="text-muted-foreground">{tx("Per page")}</span>
            {pageSizes.map((size) => (
              <Button
                key={size}
                type="button"
                size="micro"
                variant={size === page.pageSize ? "secondary" : "ghost"}
                aria-pressed={size === page.pageSize}
                onClick={() => onPageSize(size)}
              >
                {size}
              </Button>
            ))}
          </span>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={page.page <= 1}
          aria-label={tx("Previous page of {label}", { label })}
          onClick={() => onPage(page.page - 1)}
        >
          <ChevronLeftIcon aria-hidden="true" />
          {tx("Previous")}
        </Button>
        <span className="px-1 tabular-nums text-muted-foreground" data-testid="pager-page">
          {tx("Page {page} of {count}", { page: page.page, count: page.pageCount })}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={page.page >= page.pageCount}
          aria-label={tx("Next page of {label}", { label })}
          onClick={() => onPage(page.page + 1)}
        >
          {tx("Next")}
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </span>
    </nav>
  );
}

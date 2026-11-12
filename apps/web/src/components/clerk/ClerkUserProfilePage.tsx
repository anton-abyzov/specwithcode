import { RefreshIcon } from "~/components/ui/refresh-icon";

import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

export function ClerkUserProfilePage({
  action,
  children,
  className,
  description,
  title,
}: {
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly title: ReactNode;
}) {
  return (
    <div className={cn("w-full min-w-0 text-foreground", className)}>
      {/* The right padding keeps the action clear of the modal's close button. */}
      <header className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:pr-8">
        <div className="min-w-0">
          <h2 className="text-base leading-6 font-semibold">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-[34rem] text-xs leading-4.5 text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>

      {children}
    </div>
  );
}

export function ClerkUserProfileRefreshButton({
  className,
  disabled = false,
  isPending,
  onClick,
}: {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly isPending: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      className={className}
      aria-busy={isPending}
      disabled={disabled || isPending}
      onClick={onClick}
    >
      <RefreshIcon aria-hidden="true" size="sm" refreshing={isPending} />
      Refresh
    </Button>
  );
}

/** Small caption above a list: what the rows are and how many. */
export function ClerkUserProfileListCaption({ children }: { readonly children: ReactNode }) {
  return <p className="pb-2 text-xs leading-4.5 font-medium text-muted-foreground">{children}</p>;
}

/** The rows of an account page, held in one bordered card. */
export function ClerkUserProfileList({
  children,
  label,
}: {
  readonly children: ReactNode;
  /** What the list holds, for screen readers. */
  readonly label: string;
}) {
  return (
    <ul aria-label={label} className="divide-y overflow-hidden rounded-xl border bg-muted/16">
      {children}
    </ul>
  );
}

export function ClerkUserProfileRow({
  children,
  className,
  icon,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly icon: ReactNode;
}) {
  return (
    <li className={cn("px-4 py-3.5", className)}>
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </li>
  );
}

/** Placeholder rows while a list loads for the first time. */
export function ClerkUserProfileListSkeleton({
  label,
  rows = 3,
}: {
  /** Announced to screen readers, e.g. "Loading machines". */
  readonly label: string;
  readonly rows?: number;
}) {
  return (
    <div
      aria-label={label}
      className="divide-y overflow-hidden rounded-xl border bg-muted/16"
      role="status"
    >
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton shape="card" className="size-8 shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-52 max-w-full" />
          </div>
          <Skeleton shape="card" className="hidden h-7 w-20 sm:block" />
        </div>
      ))}
    </div>
  );
}

/** A failed load, with the reason and one way forward. */
export function ClerkUserProfileError({
  detail,
  onRetry,
  retryDisabled = false,
  title,
}: {
  readonly detail: string;
  readonly onRetry: () => void;
  readonly retryDisabled?: boolean;
  readonly title: string;
}) {
  return (
    <div
      className="mb-3 flex flex-col gap-3 rounded-xl border border-destructive/24 bg-destructive/4 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
    >
      <div className="min-w-0">
        <p className="text-sm leading-5 font-medium text-destructive-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-4.5 break-words text-muted-foreground">{detail}</p>
      </div>
      <Button
        className="shrink-0 self-start sm:self-auto"
        size="sm"
        variant="outline"
        disabled={retryDisabled}
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

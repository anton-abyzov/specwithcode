import { cn } from "~/lib/utils";

const numberFormat = new Intl.NumberFormat();

/**
 * "120 / 8,000" under a length-limited field. It counts the way `maxLength`
 * does (UTF-16 code units), so the count stops exactly where typing stops.
 *
 * Give it an `id` and point the field's `aria-describedby` at it: the count is
 * then read as the field's description and kept out of any enclosing label's
 * name. Without an id it reads as plain text.
 */
export function CharacterCount({
  value,
  count: countOverride,
  max,
  className,
  id,
}: {
  readonly value?: string;
  /** A count measured another way, such as a prompt with citations expanded. */
  readonly count?: number;
  readonly max: number;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
}) {
  const count = countOverride ?? value?.length ?? 0;
  return (
    <span
      id={id}
      aria-hidden={id ? true : undefined}
      data-slot="character-count"
      className={cn(
        "block text-end text-[11px] leading-4 font-normal text-muted-foreground tabular-nums",
        count >= max * 0.9 && "text-warning-foreground",
        count > max && "text-destructive-foreground",
        className,
      )}
    >
      <span className="sr-only">Characters used: </span>
      {numberFormat.format(count)} / {numberFormat.format(max)}
    </span>
  );
}

import { ChevronDownIcon, StarIcon } from "lucide-react";
import { memo, type ReactNode, useCallback, useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { ComboboxItem } from "../ui/combobox";
import type { ModelSearchHeader, ModelSearchOlderSection } from "./modelSearchGroups";

/**
 * The heading over one model in search results: its name once, and how many providers
 * offer it. The provider rows below it say which, best first.
 */
export const ModelSearchGroupHeader = memo(function ModelSearchGroupHeader(props: {
  readonly header: ModelSearchHeader;
  readonly familyStar?: ModelSearchFamilyStar;
}) {
  const { header } = props;
  return (
    <div
      className={cn(
        "sws-picker-group flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 px-2 pt-2 pb-0.5",
        header.older && "ps-4",
      )}
      data-model-search-group={header.label}
    >
      <ModelSearchHeading header={header}>
        {header.older || !props.familyStar ? null : (
          <FamilyStarButton header={header} star={props.familyStar} />
        )}
      </ModelSearchHeading>
    </div>
  );
});

/** Starring a whole family ("Claude Opus") rather than one version on one provider. */
export interface ModelSearchFamilyStar {
  readonly familySet: ReadonlySet<string>;
  readonly toggleFamily: (family: string) => void;
}

/**
 * The star on a model's heading: it saves the family, so Favorites lists every version
 * of it and new chats move to its newest version. A star on a row pins that one version.
 */
function FamilyStarButton(props: {
  readonly header: ModelSearchHeader;
  readonly star: ModelSearchFamilyStar;
}) {
  const { header, star } = props;
  const active = star.familySet.has(header.family);
  const family = header.label.replace(/[\s-]*v?\d+(?:\.\d+)*\s*$/u, "") || header.label;
  const label = active
    ? `Remove ${family} from favorites`
    : `Add ${family} to favorites, newest version first`;
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      className="-my-1 shrink-0 self-center"
      onClick={(event) => {
        event.stopPropagation();
        star.toggleFamily(header.family);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-model-search-family-star={header.family}
    >
      <StarIcon
        className={cn("size-3.5 sm:size-3", active && "fill-current text-warning-foreground")}
      />
    </Button>
  );
}

// The name stays whole; on a narrow picker the pills wrap to a line of their own.
function ModelSearchHeading(props: {
  readonly header: ModelSearchHeader;
  readonly children?: ReactNode;
}) {
  const { header } = props;
  return (
    <>
      <span className="flex min-w-0 max-w-full items-baseline gap-1.5">
        <span className="sws-picker-group-name min-w-0 truncate text-sm text-foreground">
          {header.label}
        </span>
        {header.latest ? (
          <span
            className="shrink-0 rounded border border-primary/35 bg-primary/10 px-1 py-px text-3xs font-semibold leading-none text-foreground"
            data-model-search-latest=""
          >
            Latest
          </span>
        ) : null}
      </span>
      <span className="ms-auto flex shrink-0 items-baseline gap-1.5">
        <span
          className="sws-picker-pill tabular-nums text-muted-foreground"
          data-model-search-provider-count={header.providerCount}
        >
          {header.providerCount === 1 ? "1 provider" : `${header.providerCount} providers`}
        </span>
        {props.children}
      </span>
    </>
  );
}

/**
 * The heading of a family that has older versions: the latest model, its providers, and a
 * toggle right on it that opens the older versions beneath ("Claude Opus 5.5 · 3 older").
 */
export function ModelSearchOlderRow(props: {
  readonly index: number;
  readonly value: string;
  readonly section: ModelSearchOlderSection;
  readonly familyStar?: ModelSearchFamilyStar;
}) {
  const { section } = props;
  const count = section.labels.length;
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={props.value}
      aria-expanded={section.isExpanded}
      aria-label={`${section.latest.label}, ${section.isExpanded ? "hide" : "show"} ${count} older ${
        count === 1 ? "version" : "versions"
      }: ${section.labels.join(", ")}`}
      className="group w-full cursor-pointer !py-1"
      data-model-search-older={section.family}
    >
      <div className="sws-picker-group flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-1 pt-1">
        <ModelSearchHeading header={section.latest}>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-px text-2xs leading-none",
              section.isExpanded
                ? "border-primary/35 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground group-data-highlighted:text-foreground",
            )}
            data-model-search-older-toggle=""
            title={section.labels.join(" · ")}
          >
            {section.isExpanded ? "Hide older" : `${count} older`}
            <ChevronDownIcon
              className={cn("size-3 transition-transform", section.isExpanded && "rotate-180")}
            />
          </span>
          {props.familyStar ? (
            <FamilyStarButton header={section.latest} star={props.familyStar} />
          ) : null}
        </ModelSearchHeading>
      </div>
    </ComboboxItem>
  );
}

/** A set of keys each toggled in or out, such as the families showing older versions. */
export function useToggleSet(): readonly [ReadonlySet<string>, (key: string) => void] {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setKeys((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  return [keys, toggle] as const;
}

import { ChevronUpIcon, InfoIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";

// Match the duration-220 exit transition before removing a dismissed notice.
const DISMISS_TRANSITION_MS = 220;

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly priority?: "urgent" | "activity" | "notice";
  readonly compact?: boolean;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  /**
   * "wrap-below" keeps the title and description at least 16rem wide and moves the
   * actions under them whenever they do not fit beside it, for notices with several
   * buttons. The default puts actions in their own column, sized to their content.
   */
  readonly actionsLayout?: "column" | "wrap-below";
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

export type ComposerBannerStackContent = Pick<
  ComposerBannerStackItem,
  "id" | "variant" | "priority"
> & { readonly content: ReactNode };

type ComposerBannerStackEntry = ComposerBannerStackItem | ComposerBannerStackContent;

/**
 * Severity orders the notices: an account change or limit, then errors, then
 * warnings, then running work (a pull request watch, a goal) and the rest. A
 * watcher never hides a limit.
 */
function bannerPriority(item: ComposerBannerStackEntry) {
  if (item.priority === "urgent") return 0;
  if (item.variant === "error") return 1;
  if (item.variant === "warning") return 2;
  if (item.priority === "activity") return 3;
  return 4;
}

/** Notices shown before the rest fold into the "N more notices" button. */
const VISIBLE_NOTICES = 2;

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackEntry>;
  /** Attachments between the notices and the composer's own drawers, such as the queue. */
  readonly attachedAbove?: ReactNode;
}

/**
 * Notices about the thread float above the composer as whole cards, each with
 * its own border, in severity order. The composer's own drawers (content
 * entries, such as the activity row) stay attached to it below the queue.
 */
export function ComposerBannerStack({ className, items, attachedAbove }: ComposerBannerStackProps) {
  const [expandedState, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [requestedExitingItemId, setExitingItemId] = useState<string | null>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitingItemId =
    requestedExitingItemId !== null && items.some((item) => item.id === requestedExitingItemId)
      ? requestedExitingItemId
      : null;
  const notices = items
    .filter((item): item is ComposerBannerStackItem => !("content" in item))
    .toSorted((a, b) => bannerPriority(a) - bannerPriority(b));
  const drawers = items.filter((item): item is ComposerBannerStackContent => "content" in item);
  const folds = notices.length > VISIBLE_NOTICES;
  const expanded = expandedState && folds;

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  const requestDismiss = (item: ComposerBannerStackEntry) => {
    if (!("onDismiss" in item) || !item.onDismiss || exitingItemId) {
      return;
    }
    setExitingItemId(item.id);
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      item.onDismiss?.();
    }, DISMISS_TRANSITION_MS);
  };

  const shown = expanded ? notices : notices.slice(0, VISIBLE_NOTICES);
  const hiddenCount = notices.length - shown.length;

  return (
    <>
      {notices.length > 0 ? (
        <div
          data-composer-notice-stack="true"
          data-chat-composer-collapsed-controls="true"
          className={cn(
            "relative z-20 flex flex-col gap-1.5 pb-2",
            // Last in the dock, the notices clear the 17px the dock tucks under the composer.
            "last:pb-6",
          )}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !expanded) return;
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
            toggleRef.current?.focus({ preventScroll: true });
          }}
        >
          {folds ? (
            <button
              ref={toggleRef}
              type="button"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((current) => !current)}
              className={cn(
                "flex min-h-8 items-center gap-1.5 self-center rounded-full border px-3 text-xs text-muted-foreground shadow-sm outline-none",
                "border-border bg-card dark:bg-(--surface-raised)",
                "transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
              )}
            >
              <ChevronUpIcon
                aria-hidden
                className={cn(
                  "size-3.5 transition-transform motion-reduce:transition-none",
                  expanded && "rotate-180",
                )}
              />
              {expanded
                ? "Show fewer notices"
                : `${hiddenCount} more ${hiddenCount === 1 ? "notice" : "notices"}`}
            </button>
          ) : null}
          <div id={listId} role="group" aria-label="Notices" className="flex flex-col gap-1.5">
            {shown.map((item) => (
              <div
                key={item.id}
                className={cn(
                  "transition-[opacity,translate] duration-220 ease-in motion-reduce:transition-none",
                  exitingItemId === item.id
                    ? "pointer-events-none translate-y-2 opacity-0"
                    : "opacity-100",
                )}
              >
                <ComposerBannerStackAlert
                  item={item}
                  attached={false}
                  exiting={exitingItemId === item.id}
                  onDismissRequest={() => requestDismiss(item)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {attachedAbove}
      {drawers.map((item) => (
        <ComposerBanner.Attachment
          key={item.id}
          className={className}
          data-composer-banner-drawer="true"
          data-chat-composer-collapsed-controls="true"
        >
          <ComposerBannerStackAlert
            item={item}
            attached
            exiting={false}
            onDismissRequest={() => requestDismiss(item)}
          />
        </ComposerBanner.Attachment>
      ))}
    </>
  );
}

/** Keep full descriptions reachable only when their inline copy is clipped. */
function NoticeDescription({
  children,
  compact,
  wrap,
}: {
  children: ReactNode;
  compact?: boolean;
  /** Wrap onto further lines instead of truncating, so the whole text stays visible. */
  wrap?: boolean;
}) {
  const descriptionRef = useRef<HTMLSpanElement>(null);
  const detailsRef = useRef<HTMLButtonElement>(null);
  const [showDetails, setShowDetails] = useState(false);

  useLayoutEffect(() => {
    const description = descriptionRef.current;
    if (!description) return;
    const measure = () => {
      // Ignore the space taken by the details button itself so it cannot
      // sustain its own overflow after the description would otherwise fit.
      const recoveredWidth = detailsRef.current ? detailsRef.current.offsetWidth + 4 : 0;
      const hidden = getComputedStyle(description).position === "absolute";
      setShowDetails(
        hidden ||
          [description, ...description.querySelectorAll("*")].some(
            (element) => element.scrollWidth > element.clientWidth + recoveredWidth,
          ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(description);
    // A child can reveal new text without resizing its clipped box.
    const mutations = new MutationObserver(measure);
    mutations.observe(description, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);

  return (
    <span
      className={
        compact
          ? "contents"
          : wrap
            ? // Content-sized basis: the whole text moves under the title before it wraps.
              "flex min-w-0 flex-[1_1_auto] items-center gap-1"
            : "flex min-w-8 flex-1 items-center gap-1"
      }
    >
      <span
        ref={descriptionRef}
        className={cn(
          "min-w-0 text-muted-foreground",
          wrap ? "whitespace-normal wrap-break-word" : "truncate",
          compact && "shrink-[9999] @max-[400px]:sr-only",
        )}
      >
        {children}
      </span>
      {showDetails ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                ref={detailsRef}
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Show notice details"
                className="flex-none"
              />
            }
          >
            <InfoIcon />
          </PopoverTrigger>
          <PopoverPopup
            aria-label="Notice details"
            tooltipStyle
            side="top"
            className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere [--inline-button-text-align:start] [--inline-button-white-space:normal] [&_[data-slot=inline-button]]:max-w-full"
          >
            <ComposerBanner.Scroll className="max-h-[min(var(--available-height),24rem,40dvh)]">
              {children}
            </ComposerBanner.Scroll>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}

function ComposerBannerStackAlert({
  item,
  attached,
  exiting,
  onDismissRequest,
}: {
  readonly item: ComposerBannerStackEntry;
  readonly attached: boolean;
  readonly exiting: boolean;
  readonly onDismissRequest: () => void;
}) {
  if ("content" in item) {
    return (
      <ComposerBanner.Root
        density="comfortable"
        placement={attached ? "attached" : "floating"}
        variant={item.variant}
      >
        {item.content}
      </ComposerBanner.Root>
    );
  }
  // A wrap-below notice has room under its title, so its description wraps there on
  // narrow widths instead of hiding the end of the text behind a details button.
  const wrapDescription = item.actionsLayout === "wrap-below";
  const content = (
    <ComposerBanner.Content
      className={cn("whitespace-nowrap", wrapDescription && "flex-[1_1_16rem] flex-wrap")}
    >
      <span className="min-w-0 truncate font-medium leading-7 sm:leading-6">{item.title}</span>
      {item.description ? (
        <NoticeDescription compact={item.compact ?? false} wrap={wrapDescription}>
          {item.description}
        </NoticeDescription>
      ) : null}
    </ComposerBanner.Content>
  );
  const dismiss = item.onDismiss ? (
    <ComposerBanner.Dismiss
      aria-label={item.dismissLabel ?? "Dismiss notice"}
      disabled={exiting}
      onClick={onDismissRequest}
    />
  ) : null;
  if (item.actionsLayout === "wrap-below") {
    return (
      <ComposerBanner.Root
        role={bannerPriority(item) <= 2 ? "alert" : "status"}
        placement={attached ? "attached" : "floating"}
        variant={item.variant}
        density="comfortable"
      >
        <ComposerBanner.Row layout="inline">
          <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
            {item.icon}
          </ComposerBanner.Icon>
          {/* The text's 16rem basis decides the wrap; the actions never take that width. */}
          <div
            data-composer-banner-wrap="true"
            className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2"
          >
            {content}
            {item.actions || dismiss ? (
              <span
                data-slot="composer-banner-wrapped-actions"
                className="flex max-w-full min-w-0 flex-[0_1_auto] flex-wrap items-center gap-1"
              >
                {item.actions}
                {dismiss}
              </span>
            ) : null}
          </div>
        </ComposerBanner.Row>
        {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
      </ComposerBanner.Root>
    );
  }
  return (
    <ComposerBanner.Root
      role={bannerPriority(item) <= 2 ? "alert" : "status"}
      placement={attached ? "attached" : "floating"}
      variant={item.variant}
      density="comfortable"
    >
      <ComposerBanner.Row layout={item.compact ? "wrap-actions-narrow" : "wrap-actions"}>
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        {content}
        {item.actions || dismiss ? (
          <ComposerBanner.Actions>
            {item.actions}
            {dismiss}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}

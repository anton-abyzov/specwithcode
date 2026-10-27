/**
 * A PowerPoint deck in the file viewer: the server reads the .pptx with the
 * import's parser (`design.previewDeck`, stored nowhere) and its slides are
 * drawn by the slides renderer. A deck that cannot be previewed, and any file
 * the viewer cannot draw, is a card that says why and opens it in its app.
 */
import type {
  DesignError,
  DesignPreviewDeckResult,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { CopyIcon, ExternalLinkIcon, FileIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useFileContextMenu } from "~/fileContextMenu";
import { cn } from "~/lib/utils";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { design } from "~/studio/design";

import { DesignRenderContextValue } from "../design/canvas/NodeView";
import { SlideThumbnail } from "../design/slides/SlideThumbnail";
import { Button } from "../ui/button";

/** The line above the slides: how many, and what the preview leaves out. */
export function deckSummary(preview: DesignPreviewDeckResult): string {
  const count = preview.pages.length === 1 ? "1 slide" : `${preview.pages.length} slides`;
  const leftOut = preview.notImported.some((slide) => slide.items.length > 0);
  const pictures = preview.imagesOmitted;
  if (!leftOut && pictures === 0) return count;
  const parts = [
    ...(leftOut ? ["charts, tables, media and effects"] : []),
    ...(pictures > 0 ? [pictures === 1 ? "1 large picture" : `${pictures} large pictures`] : []),
  ];
  return `${count}. Not drawn here: ${parts.join(" and ")}. The deck opens complete in its app.`;
}

/** The slides of a read deck, one under another at reading width. */
export function DeckSlides(props: {
  readonly name: string;
  readonly preview: DesignPreviewDeckResult;
}) {
  const { preview } = props;
  const context = useMemo(
    () => ({
      system: null,
      mode: "light",
      assetUrl: (asset: string) => preview.images[asset] ?? "",
    }),
    [preview.images],
  );
  const list = useRef<HTMLOListElement>(null);
  const [current, setCurrent] = useState(0);
  // The rail follows the slide the reader has in view.
  useEffect(() => {
    const slides = list.current?.querySelectorAll<HTMLElement>("[data-deck-slide]");
    if (!slides || slides.length !== preview.pages.length) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const seen = entries.find((entry) => entry.isIntersecting);
        if (seen) setCurrent(Number((seen.target as HTMLElement).dataset.deckSlide) - 1);
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const slide of slides) observer.observe(slide);
    return () => observer.disconnect();
  }, [preview.pages]);
  const show = (index: number) => {
    setCurrent(index);
    list.current
      ?.querySelector(`[data-deck-slide="${index + 1}"]`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <DesignRenderContextValue value={context}>
      <div className="flex min-h-0 flex-1" data-deck-preview={props.name}>
        <nav
          className="hidden w-44 shrink-0 flex-col gap-3 overflow-y-auto border-r bg-background/60 px-3 py-4 sm:flex"
          aria-label="Slides"
        >
          {preview.pages.map((page, index) => (
            <button
              key={page.id}
              type="button"
              className="group flex items-start gap-2 rounded-md p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-current={index === current ? "true" : undefined}
              aria-label={`Slide ${index + 1}`}
              data-deck-thumb={index + 1}
              onClick={() => show(index)}
            >
              <span className="w-4 shrink-0 pt-0.5 text-right text-muted-foreground text-xs tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <SlideThumbnail
                  page={page}
                  width="fill"
                  className={cn(
                    "rounded-sm bg-white ring-1 ring-border transition-shadow",
                    index === current ? "ring-2 ring-primary" : "group-hover:ring-foreground/30",
                    page.skipped && "opacity-50",
                  )}
                />
              </span>
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-deck-scroll="true">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-6">
            <p className="text-muted-foreground text-xs" role="status">
              {deckSummary(preview)}
            </p>
            <ol ref={list} className="flex flex-col gap-6" aria-label={`Slides of ${props.name}`}>
              {preview.pages.map((page, index) => (
                <li
                  key={page.id}
                  className="flex scroll-mt-6 flex-col gap-2"
                  data-deck-slide={index + 1}
                  aria-label={`Slide ${index + 1}`}
                >
                  <div className="flex items-center gap-2 text-muted-foreground text-xs tabular-nums">
                    <span>{index + 1}</span>
                    {page.skipped ? (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5">Hidden slide</span>
                    ) : null}
                  </div>
                  <SlideThumbnail
                    page={page}
                    width="fill"
                    className="rounded-md bg-white shadow-md ring-1 ring-border"
                  />
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </DesignRenderContextValue>
  );
}

/**
 * A file the viewer shows no preview of: its name, why, and the host's own
 * ways to open it, the default app and the file manager.
 */
export function FilePreviewCard(props: {
  readonly environmentId: EnvironmentId;
  /** Absolute host path; null when the file is not on this host. */
  readonly path: string | null;
  readonly name: string;
  readonly reason: string;
  readonly role?: "alert" | "status" | undefined;
}) {
  const files = useFileContextMenu(props.environmentId);
  const target =
    props.path === null
      ? null
      : { environmentId: props.environmentId, filePath: props.path, workspaceRoot: undefined };
  const reveal = target ? files.capabilities.revealLabel : undefined;
  return (
    <div className="m-auto flex w-full max-w-md flex-col items-center gap-4 p-6 text-center">
      <div
        className="flex w-full flex-col items-center gap-3 rounded-xl border bg-background p-6 shadow-sm"
        data-file-preview-card={props.name}
      >
        <span className="grid size-12 place-items-center rounded-lg bg-muted text-muted-foreground">
          <FileIcon aria-hidden className="size-6" />
        </span>
        <p className="break-all font-medium text-sm">{props.name}</p>
        <p className="text-muted-foreground text-sm" role={props.role ?? "status"}>
          {props.reason}
        </p>
        {props.path ? (
          <p className="break-all font-mono text-muted-foreground text-xs">{props.path}</p>
        ) : null}
        <div className="flex flex-wrap justify-center gap-2">
          {target && files.capabilities.canOpenDefault ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void files.activate("open", target)}
            >
              <ExternalLinkIcon aria-hidden />
              Open in default app
            </Button>
          ) : null}
          {target && reveal ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void files.activate("reveal-in-folder", target)}
            >
              <FolderOpenIcon aria-hidden />
              {reveal}
            </Button>
          ) : null}
          {props.path && !(target && (files.capabilities.canOpenDefault || reveal)) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard?.writeText(props.path ?? props.name)}
            >
              <CopyIcon aria-hidden />
              Copy path
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Why a deck has no preview, from the server's refusal. */
export function deckFailureReason(failure: unknown, fallback: string | null): string {
  const error = failure as Partial<DesignError> | null;
  if (error?._tag === "DesignError" && typeof error.detail === "string") {
    if (error.code === "too_large" || error.code === "invalid") {
      return `No preview: ${error.detail}`;
    }
    return error.detail;
  }
  return fallback ?? "The deck could not be read for a preview.";
}

/** A host .pptx as its slides, or a card when the deck has no preview. */
export function HostDeckPreview(props: {
  readonly environmentId: EnvironmentId;
  /** Absolute host path of the deck. */
  readonly path: string;
  readonly name: string;
}) {
  const capabilities = useServerConfigs().get(props.environmentId)?.environment.capabilities;
  const supported = capabilities?.designDeckPreview === true;
  const deck = useEnvironmentQuery(
    supported
      ? design.previewDeck({ environmentId: props.environmentId, input: { path: props.path } })
      : null,
  );
  const card = (reason: string, role?: "alert") => (
    <FilePreviewCard
      environmentId={props.environmentId}
      path={props.path}
      name={props.name}
      reason={reason}
      role={role}
    />
  );
  if (!supported) {
    return card(
      "This machine's SpecWithCode is too old to preview decks. Update it to see slides.",
    );
  }
  if (deck.data) return <DeckSlides name={props.name} preview={deck.data} />;
  if (deck.error !== null) return card(deckFailureReason(deck.failure, deck.error), "alert");
  return (
    <p className="m-auto p-6 text-center text-muted-foreground text-sm" role="status">
      Reading the slides…
    </p>
  );
}

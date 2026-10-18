import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardCopyIcon,
  CopyIcon,
  DownloadIcon,
  FileSearchIcon,
  XIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { Image as ImageGlyph, Text as TextGlyph } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActions, type MediaActionSource, useMediaActions } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "./SnapShotAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ViewerImageStage } from "./ViewerImageStage";
import { ViewerFileActions } from "./ViewerFileActions";
import { MenuItem } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  useKeepViewerFocus,
  useViewerContentKeys,
  useViewerOverlay,
  viewerExtensionBadge,
} from "~/viewerOverlayStore";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
  /**
   * The thread the media was opened from. With it, the media opens in the
   * app's viewer overlay beside that thread, its composer included, so the
   * conversation can go on while the image is open. Without it (a draft's
   * attachment, a page with no thread) it opens as a lightbox.
   */
  threadRef?: ScopedThreadRef | null | undefined;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

/** Where a local file lives on its host, so it can be found outside the app too. */
function MediaFilePath({ path }: { readonly path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/60">
      <span className="truncate select-all font-mono" dir="rtl">
        <bdi>{path}</bdi>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Copy full path"
              size="icon-micro"
              variant="overlay"
              onClick={() => {
                void writeTextToClipboard(path, "file path").then(() => setCopied(true));
              }}
            />
          }
        >
          {copied ? (
            <CheckIcon className="size-3" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3" aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{copied ? "Copied" : "Copy full path"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ExpandedVideo({ item }: { readonly item: ExpandedImageItem }) {
  const asset = item.actionsSource?.asset;
  const assetUrl = useAssetUrlState(asset?.environmentId ?? null, asset?.resource ?? null);
  const refreshAssetUrl = useAssetUrlRefresh(asset?.environmentId ?? null, asset?.resource ?? null);
  const src = asset
    ? assetUrl._tag === "Success"
      ? assetUrl.url + (item.srcFragment ?? "")
      : null
    : item.src;
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={assetUrl._tag === "Failure"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
      videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={asset ? refreshAssetUrl : undefined}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog(
  props: ExpandedImageDialogProps,
) {
  return props.threadRef ? (
    <ExpandedMediaOverlay
      preview={props.preview}
      onClose={props.onClose}
      threadRef={props.threadRef}
    />
  ) : (
    <ExpandedMediaLightbox preview={props.preview} onClose={props.onClose} />
  );
});

/** Runs a media action with the same progress and failure toasts as the media menu. */
async function runMediaAction(
  label: { readonly progress: string; readonly done: string; readonly failed: string },
  action: () => Promise<void>,
) {
  const progressToast = toastManager.add({ type: "loading", title: label.progress });
  try {
    await action();
    toastManager.update(progressToast, { type: "success", title: label.done });
  } catch (error) {
    toastManager.update(
      progressToast,
      stackedThreadToast({
        type: "error",
        title: label.failed,
        description: error instanceof Error ? error.message : "The media action failed.",
      }),
    );
  }
}

/**
 * Media opened from a thread, in the viewer overlay: the image (zoomable,
 * with its toolbar) or video on the left, the live thread and its composer on
 * the right. The overlay's header names it and holds Download, the file
 * actions and Close; Escape closes it as it does every viewer.
 */
function ExpandedMediaOverlay({
  preview,
  onClose,
  threadRef,
}: {
  readonly preview: ExpandedImagePreview;
  readonly onClose: () => void;
  readonly threadRef: ScopedThreadRef;
}) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [accessibilityDetailsSrc, setAccessibilityDetailsSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const imageCount = preview.images.length;
  const index =
    imageCount > 0 ? (((preview.index + imageOffset) % imageCount) + imageCount) % imageCount : 0;
  const item = preview.images[index];
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const { save, copyImage, canReadMedia } = useMediaActions(source);
  const name = item?.name ?? "Image";
  const slots = useViewerOverlay({
    open: item !== undefined,
    title: name,
    kind: item?.type === "video" ? "Video" : "Image",
    badge: viewerExtensionBadge(name),
    threadRef,
    onClose,
  });
  const keepFocus = useKeepViewerFocus(slots?.content ?? null);
  const step = (by: -1 | 1) => {
    keepFocus();
    setImageOffset((current) => current + by);
  };
  const onKeys = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || isContextMenuOpen()) return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      return;
    }
    if (imageCount <= 1) return;
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  };
  useViewerContentKeys(slots?.content ?? null, onKeys);
  if (!item || slots === null) return null;
  const noun = item.type === "video" ? "video" : "image";
  const unavailable = !canReadMedia || (source.src === null && source.asset === undefined);
  const path = source.reference?.kind === "file" ? source.reference.path : null;
  const environmentId = source.asset?.environmentId ?? threadRef.environmentId;
  const openFile = source.onOpenFile;
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const accessibilityDetails = item.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item.src;
  const contentsLabel = showingAccessibilityDetails
    ? "Show screenshot"
    : accessibilityDetails?.format === "json"
      ? "Show accessibility JSON"
      : "Show extracted text";
  const actions = (
    <>
      {accessibilityDetails ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={contentsLabel}
          title={contentsLabel}
          aria-pressed={showingAccessibilityDetails}
          onClick={() => setAccessibilityDetailsSrc(showingAccessibilityDetails ? null : item.src)}
        >
          <MorphIcon
            aria-hidden="true"
            icon={showingAccessibilityDetails ? ImageGlyph : TextGlyph}
          />
        </Button>
      ) : null}
      {imageCount > 1 ? (
        <>
          <span
            className="px-1 text-muted-foreground text-xs tabular-nums"
            data-media-position="true"
          >
            {index + 1} of {imageCount}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Previous media"
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Next media"
            onClick={() => step(1)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </>
      ) : null}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Download ${name}`}
        title={`Download ${name}`}
        disabled={unavailable}
        onClick={() =>
          void runMediaAction(
            {
              progress: `Preparing ${noun} download…`,
              done: "Download started",
              failed: `Could not save ${noun}`,
            },
            save,
          )
        }
      >
        <DownloadIcon aria-hidden />
      </Button>
      <ViewerFileActions
        environmentId={environmentId}
        path={path}
        name={name}
        menuItems={
          <>
            {item.type !== "video" ? (
              <MenuItem
                disabled={unavailable}
                onClick={() =>
                  void runMediaAction(
                    {
                      progress: "Copying image…",
                      done: "Image copied",
                      failed: "Could not copy image",
                    },
                    copyImage,
                  )
                }
              >
                <ClipboardCopyIcon aria-hidden />
                Copy image
              </MenuItem>
            ) : null}
            {openFile ? (
              <MenuItem
                disabled={!canReadMedia}
                onClick={() => {
                  openFile();
                  onClose();
                }}
              >
                <FileSearchIcon aria-hidden />
                Open in file viewer
              </MenuItem>
            ) : null}
          </>
        }
      />
    </>
  );
  return createPortal(
    <div
      className="viewer-overlay-frame"
      data-expanded-media-viewer={item.type === "video" ? "video" : "image"}
      onKeyDown={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLVideoElement)
          return;
        onKeys(event.nativeEvent);
      }}
    >
      {slots.actions ? createPortal(actions, slots.actions) : null}
      <div className="artifact-viewer-stage" data-artifact-stage="true">
        {item.type === "video" ? (
          <div className="viewer-media-video [--media-height:calc(100%-2rem)] [--media-width:calc(100%-2rem)]">
            <ExpandedVideo key={index} item={item} />
          </div>
        ) : showingAccessibilityDetails && accessibilityDetails ? (
          <div className="m-auto flex min-h-0 w-full max-w-3xl flex-1 p-6">
            <SnapShotAccessibilityData
              details={accessibilityDetails}
              className="min-h-0 w-full overflow-auto rounded-lg border border-border/70 bg-background p-4 text-xs leading-5"
            />
          </div>
        ) : item.src === null || failedImageSrc === item.src ? (
          <div className="m-auto p-6">
            <ExpandedMediaFailure>
              <p>
                {openOriginalLink
                  ? "This image could not be loaded."
                  : "Image unavailable. The file may have been moved or deleted."}
              </p>
              {openOriginalLink}
            </ExpandedMediaFailure>
          </div>
        ) : (
          <ViewerImageStage
            ref={zoomableImageRef}
            key={`${index}:${item.src}`}
            src={item.src}
            name={item.name}
            onError={() => setFailedImageSrc(item.src)}
          />
        )}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {item.name}
          {imageCount > 1 ? ` (${index + 1}/${imageCount})` : ""}
        </span>
      </div>
    </div>,
    slots.content,
  );
}

/** Media in a lightbox over everything, for media no thread owns. */
function ExpandedMediaLightbox({ preview, onClose }: ExpandedImageDialogProps) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [accessibilityDetailsSrc, setAccessibilityDetailsSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The offset accumulates without bound, so wrap it into range in both directions:
  // JavaScript `%` keeps the sign of the dividend, and a negative index blanks the dialog.
  const imageCount = preview.images.length;
  const index =
    imageCount > 0 ? (((preview.index + imageOffset) % imageCount) + imageCount) % imageCount : 0;
  const item = preview.images[index];
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const openFile = source.onOpenFile;
  const actionsSource: MediaActionSource = openFile
    ? {
        ...source,
        onOpenFile: () => {
          openFile();
          onClose();
        },
      }
    : source;

  const navigateImage = useCallback((direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  }, []);

  // The element that opened the preview gets focus back on close. Without
  // this a close button click leaves focus on the unmounted dialog, and the
  // composer that owned the opener reads that as a blur and rests.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isContextMenuOpen() || event.target instanceof HTMLVideoElement)
      return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview.images.length <= 1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      navigateImage(-1);
      return;
    }
    if (event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(1);
  };

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || isContextMenuOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose]);

  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const accessibilityDetails = item.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item.src;
  const contentsLabel = showingAccessibilityDetails
    ? "Show screenshot"
    : accessibilityDetails?.format === "json"
      ? "Show accessibility JSON"
      : "Show extracted text";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 max-h-[92vh] w-[92vw] max-w-[92vw] items-center overflow-visible [--media-width:92vw] [--media-height:min(86vh,calc(100vh-160px))] sm:[--media-width:calc(92vw-96px)]"
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded {mediaLabel} preview</DialogTitle>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="left-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous media"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        <MediaActions source={actionsSource}>
          <div className="relative isolate z-10 max-h-[92vh] max-w-[var(--media-width)]">
            <Button
              type="button"
              ref={closeButtonRef}
              size="icon-xs"
              variant="media-close"
              className="absolute right-0 -top-10 z-20"
              onClick={onClose}
              aria-label={`Close ${mediaLabel} preview`}
            >
              <XIcon />
            </Button>
            {item.type === "video" ? (
              <ExpandedVideo key={index} item={item} />
            ) : showingAccessibilityDetails ? (
              accessibilityDetails ? (
                <SnapShotAccessibilityData
                  details={accessibilityDetails}
                  className="h-[min(var(--media-height),40rem)] w-[min(var(--media-width),42rem)] transition-opacity duration-140 ease-out starting:opacity-0 rounded-lg border border-border/70 bg-background p-4 text-xs leading-5 shadow-2xl motion-reduce:transition-none"
                />
              ) : null
            ) : item.src === null || failedImageSrc === item.src ? (
              <ExpandedMediaFailure>
                <p>
                  {openOriginalLink
                    ? "This image could not be loaded."
                    : "Image unavailable. The file may have been moved or deleted."}
                </p>
                {openOriginalLink}
              </ExpandedMediaFailure>
            ) : (
              <ZoomableImage
                ref={zoomableImageRef}
                key={`${index}:${item.src}`}
                src={item.src}
                name={item.name}
                onError={() => setFailedImageSrc(item.src)}
              />
            )}
            <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80">
              <span className="truncate" aria-live="polite" aria-atomic="true">
                {item.name}
                {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
              </span>
              {accessibilityDetails && item.source ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label={contentsLabel}
                        aria-pressed={showingAccessibilityDetails}
                        onClick={() =>
                          setAccessibilityDetailsSrc(showingAccessibilityDetails ? null : item.src)
                        }
                        size="icon-micro"
                        variant="overlay"
                      />
                    }
                  >
                    <MorphIcon
                      className="size-3"
                      aria-hidden="true"
                      icon={showingAccessibilityDetails ? ImageGlyph : TextGlyph}
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
                </Tooltip>
              ) : item.source ? (
                <SnapShotContentsButton source={item.source} side="top" />
              ) : null}
            </div>
            {source.reference?.kind === "file" ? (
              <MediaFilePath key={source.reference.path} path={source.reference.path} />
            ) : null}
          </div>
        </MediaActions>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="right-0 top-auto -bottom-12 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Next media"
            onClick={() => navigateImage(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        )}
      </DialogPopup>
    </Dialog>
  );
}

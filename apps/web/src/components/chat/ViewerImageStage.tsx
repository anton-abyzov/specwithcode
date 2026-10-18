import { MaximizeIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useViewerOverlayStore } from "~/viewerOverlayStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  MAX_ZOOM,
  ZoomableImage,
  type ZoomableImageBounds,
  type ZoomableImageHandle,
} from "./ZoomableImage";

/** Room kept around the image, and above the toolbar, inside the stage. */
const STAGE_INSET = 24;
const TOOLBAR_ROOM = 64;

/** Closes whatever the viewer overlay shows, as its header's Close does. */
function closeViewer() {
  const { active, close } = useViewerOverlayStore.getState();
  if (active) close(active.key);
}

function ToolbarButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: ReactNode;
  readonly close?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            {...(props.close ? { "data-viewer-image-close": "true" } : {})}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * An image on the viewer overlay's stage: fitted to the room the viewer has
 * (not the window, since the thread sits beside it), zoomable by pointer,
 * wheel and keys, with a floating toolbar at the bottom to zoom out, zoom in,
 * fit and close the viewer, as the header's Close does.
 */
export function ViewerImageStage(props: {
  readonly src: string;
  readonly name: string;
  readonly onError: () => void;
  readonly ref?: Ref<ZoomableImageHandle>;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<ZoomableImageHandle>(null);
  const [bounds, setBounds] = useState<ZoomableImageBounds | null>(null);
  const [zoom, setZoom] = useState(1);
  useImperativeHandle(
    props.ref,
    () => ({
      pan: (key) => imageRef.current?.pan(key) ?? false,
      zoomIn: () => imageRef.current?.zoomIn(),
      zoomOut: () => imageRef.current?.zoomOut(),
      fit: () => imageRef.current?.fit(),
    }),
    [],
  );
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const width = Math.max(1, Math.floor(stage.clientWidth - STAGE_INSET * 2));
      const height = Math.max(1, Math.floor(stage.clientHeight - STAGE_INSET - TOOLBAR_ROOM));
      setBounds((current) =>
        current?.width === width && current.height === height ? current : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={stageRef} className="viewer-image-stage" data-viewer-image-stage="true">
      <div className="viewer-image-frame">
        {bounds ? (
          <ZoomableImage
            ref={imageRef}
            src={props.src}
            name={props.name}
            onError={props.onError}
            bounds={bounds}
            onZoomChange={setZoom}
          />
        ) : null}
      </div>
      <div className="viewer-image-toolbar" role="toolbar" aria-label="Image controls">
        <ToolbarButton
          label="Zoom out"
          disabled={zoom <= 1}
          onClick={() => imageRef.current?.zoomOut()}
        >
          <MinusIcon aria-hidden />
        </ToolbarButton>
        <span className="viewer-image-zoom" aria-hidden>
          {Math.round(zoom * 100)}%
        </span>
        <ToolbarButton
          label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => imageRef.current?.zoomIn()}
        >
          <PlusIcon aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label="Fit to view"
          disabled={zoom <= 1}
          onClick={() => imageRef.current?.fit()}
        >
          <MaximizeIcon aria-hidden />
        </ToolbarButton>
        <span className="viewer-image-toolbar-rule" aria-hidden />
        <ToolbarButton label="Close" onClick={closeViewer} close>
          <XIcon aria-hidden />
        </ToolbarButton>
      </div>
    </div>
  );
}

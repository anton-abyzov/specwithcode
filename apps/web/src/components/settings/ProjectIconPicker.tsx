import type { ProjectIconOverride } from "@specweave-studio/contracts";
import {
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// The panel pulls in the full Lucide name list, so it loads on first open.
const ProjectIconPickerPanel = lazy(() =>
  import("./ProjectIconPickerPanel").then((module) => ({
    default: module.ProjectIconPickerPanel,
  })),
);

/**
 * A compact icon picker anchored to `trigger`, usually the project's icon shown
 * beside its name. Picks save as they happen; the popover stays open so icon and
 * color can be tried in any order.
 */
export function ProjectIconPicker({
  trigger,
  tooltip,
  current,
  customized,
  projectName,
  disabled = false,
  onSelect,
  onReset,
  onChooseImage,
}: {
  readonly trigger: ReactElement;
  /** Hover and focus label for a trigger that shows only the icon. */
  readonly tooltip?: string | undefined;
  readonly current: ProjectIconOverride | null;
  readonly customized: boolean;
  readonly projectName: string;
  readonly disabled?: boolean;
  /** May return the save: it settles once every queued pick ran, false if the latest failed. */
  readonly onSelect: (icon: ProjectIconOverride) => void | Promise<unknown>;
  readonly onReset: () => void | Promise<unknown>;
  /** Opens the image chooser; the popover closes first. */
  readonly onChooseImage?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  // A lock closes the picker for good; it must not pop back open when lifted.
  if (disabled && open) setOpen(false);
  // The image chooser opens once the popover has closed and handed focus back to
  // the trigger, so closing the chooser returns focus there too.
  const imageRequestedRef = useRef(false);
  const popoverTrigger = <PopoverTrigger render={trigger} disabled={disabled} />;
  return (
    <Popover
      open={open && !disabled}
      onOpenChange={setOpen}
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen || !imageRequestedRef.current) return;
        imageRequestedRef.current = false;
        onChooseImage?.();
      }}
    >
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={popoverTrigger} />
          <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
        </Tooltip>
      ) : (
        popoverTrigger
      )}
      <PopoverPopup align="start" padding="compact" className="w-[19rem] max-w-[calc(100vw-2rem)]">
        <Suspense fallback={<div className="h-[22rem]" aria-busy="true" />}>
          <ProjectIconPickerPanel
            current={current}
            customized={customized}
            projectName={projectName}
            disabled={disabled}
            onSelect={onSelect}
            onReset={onReset}
            onChooseImage={
              onChooseImage
                ? () => {
                    imageRequestedRef.current = true;
                    setOpen(false);
                  }
                : undefined
            }
          />
        </Suspense>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Runs icon saves one at a time, last write wins. Picks made while one is in
 * flight collapse to the latest, so quick clicks through the grid end on the last
 * choice and never on one in between. Every call resolves once the queue is empty:
 * true when the latest pick saved, false when its save threw or returned false.
 */
export function useLatestIconSave<T>(save: (change: T) => Promise<boolean | void>) {
  const saveRef = useRef(save);
  useLayoutEffect(() => {
    saveRef.current = save;
  });
  const pendingRef = useRef<{ change: T } | null>(null);
  const drainRef = useRef<Promise<boolean> | null>(null);
  return useCallback((change: T): Promise<boolean> => {
    pendingRef.current = { change };
    if (drainRef.current) return drainRef.current;
    const drain = (async () => {
      let saved = true;
      try {
        for (let next = pendingRef.current; next; next = pendingRef.current) {
          pendingRef.current = null;
          try {
            saved = (await saveRef.current(next.change)) !== false;
          } catch (error) {
            // A failed save must not strand the pick queued behind it.
            saved = false;
            console.error("Project icon save failed", error);
          }
        }
      } finally {
        drainRef.current = null;
      }
      return saved;
    })();
    drainRef.current = drain;
    return drain;
  }, []);
}

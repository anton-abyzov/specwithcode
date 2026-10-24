import { createContext, use, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The popups of a page that can be hidden under an `<Activity>` (a project page
 * left for another). A hidden page's effects stop, so a popup there never
 * finishes closing (Base UI unmounts it from an effect once its exit animation
 * ends, and syncs a controlled `open` from a layout effect), and its portal sits
 * outside the hidden DOM: it would stay on screen over the next page. The page's
 * owner closes them while the page is still shown, and hides the page only after
 * that has committed.
 */
export interface PagePopups {
  register(popup: PagePopup): () => void;
  /** True while a popup is open or still animating closed. */
  mounted(): boolean;
  /** Closes every open popup. A controlled popup takes one more commit to sync. */
  closeAll(): void;
  /** Removes every popup still mounted, skipping exit animations. */
  unmountAll(): void;
}

interface PagePopup {
  mounted(): boolean;
  close(): void;
  unmount(): void;
}

export function createPagePopups(): PagePopups {
  const popups = new Set<PagePopup>();
  return {
    register(popup) {
      popups.add(popup);
      return () => popups.delete(popup);
    },
    mounted: () => [...popups].some((popup) => popup.mounted()),
    closeAll() {
      for (const popup of popups) popup.close();
    },
    unmountAll() {
      for (const popup of popups) if (popup.mounted()) popup.unmount();
    },
  };
}

export const PagePopupsContext = createContext<PagePopups | null>(null);

interface PopupActions {
  close: () => void;
  unmount: () => void;
}

interface PopupRootProps {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  actionsRef?: RefObject<PopupActions | null> | undefined;
  onOpenChange?: ((open: boolean, details: never) => void) | undefined;
  onOpenChangeComplete?: ((open: boolean) => void) | undefined;
}

/**
 * Props for a Base UI popup root that registers with its page's popups, so the
 * page can close it before it hides. Outside such a page the props pass through.
 */
export function usePagePopup<Props extends PopupRootProps>(props: Props): Props {
  const popups = use(PagePopupsContext);
  const localActionsRef = useRef<PopupActions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  const initiallyOpen = props.open ?? props.defaultOpen ?? false;
  // `mounted` stays true while the popup animates closed.
  const popup = useRef({
    open: initiallyOpen,
    mounted: initiallyOpen,
    controlled: props.open !== undefined,
    actionsRef,
  });
  const controlledOpen = props.open;
  useLayoutEffect(() => {
    popup.current.actionsRef = actionsRef;
    popup.current.controlled = controlledOpen !== undefined;
    if (controlledOpen === undefined) return;
    popup.current.open = controlledOpen;
    if (controlledOpen) popup.current.mounted = true;
  }, [actionsRef, controlledOpen]);
  useLayoutEffect(() => {
    if (!popups) return;
    const state = popup.current;
    return popups.register({
      mounted: () => state.mounted,
      close() {
        if (state.open) state.actionsRef.current?.close();
      },
      // Unmounting in the commit that closes a controlled popup would mount it
      // again: its root reads the stale `open` until a layout effect syncs it.
      // A controlled popup whose owner kept it open (a busy dialog) is left alone.
      unmount() {
        if (state.controlled && state.open) return;
        state.actionsRef.current?.unmount();
      },
    });
  }, [popups]);
  if (!popups) return props;
  return {
    ...props,
    actionsRef,
    onOpenChange: (open: boolean, details: { isCanceled: boolean }) => {
      (props.onOpenChange as ((open: boolean, details: unknown) => void) | undefined)?.(
        open,
        details,
      );
      if (details.isCanceled) return;
      // A controlled popup's owner decides; its `open` prop syncs in the layout effect.
      if (popup.current.controlled) return;
      popup.current.open = open;
      if (open) popup.current.mounted = true;
    },
    onOpenChangeComplete: (open: boolean) => {
      props.onOpenChangeComplete?.(open);
      if (!open) popup.current.mounted = false;
    },
  };
}

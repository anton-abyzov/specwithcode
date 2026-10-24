import { Activity, type ReactElement, useLayoutEffect, useRef, useState } from "react";

import { createPagePopups, type PagePopups, PagePopupsContext } from "../ui/pagePopups";

/** Recently visited project pages stay mounted, hidden, so switching back only shows them. */
export const KEPT_PROJECT_PAGES = 3;
type KeptPage = { key: string; page: ReactElement };

/**
 * The project page shown now, plus the last few left for another project. A page
 * left stays mounted under a hidden Activity: its effects and subscriptions stop,
 * its DOM and state stay, so coming back shows it without rendering its
 * conversation again. The conversation puts its reader back itself
 * (useConversationFollow).
 */
export function KeptProjectPages({
  pageKey,
  page,
  isLive,
}: {
  pageKey: string;
  page: ReactElement;
  /** False for a page whose project is gone, which is dropped. */
  isLive: (key: string) => boolean;
}) {
  const [kept, setKept] = useState<readonly KeptPage[]>([]);
  // A hidden page's popups cannot finish closing (see PagePopups), so a page left
  // with one open stays shown for two more commits before paint: the first closes
  // its popups, the second unmounts them, and only then does it hide.
  const [leaving, setLeaving] = useState<{ key: string; step: 0 | 1 | 2 } | null>(null);
  const [pagePopups] = useState(() => new Map<string, PagePopups>());
  // The element the shown page last committed with. A page being left is held and
  // kept with it, not with the element it was entered with: that one carries stale
  // props (an earlier selection, a navigation bound to that moment), and rendering
  // it would run the page's effects with them. The same element lets React skip
  // the page entirely.
  const lastShown = useRef<KeptPage | null>(null);
  useLayoutEffect(() => {
    if (leaving === null || leaving.step === 2) return;
    const popups = pagePopups.get(leaving.key);
    if (leaving.step === 0) popups?.closeAll();
    else popups?.unmountAll();
    // oxlint-disable-next-line react/set-state-in-effect -- Each step must commit before the next.
    setLeaving({ key: leaving.key, step: leaving.step === 0 ? 1 : 2 });
  }, [leaving, pagePopups]);
  const shownKey = kept[0]?.key;
  const switching = shownKey !== undefined && shownKey !== pageKey;
  const holding =
    switching &&
    (leaving?.key === shownKey ? leaving.step < 2 : pagePopups.get(shownKey)?.mounted() === true);
  if (holding && leaving?.key !== shownKey) setLeaving({ key: shownKey, step: 0 });
  if (!switching && leaving !== null) setLeaving(null);
  const latest = (entry: KeptPage) =>
    lastShown.current?.key === entry.key ? lastShown.current : entry;
  if (kept[0]?.key !== pageKey && !holding)
    setKept(
      [{ key: pageKey, page }, ...kept.filter((entry) => entry.key !== pageKey).map(latest)].slice(
        0,
        KEPT_PROJECT_PAGES,
      ),
    );
  const shown = holding && kept[0] ? latest(kept[0]) : { key: pageKey, page };
  useLayoutEffect(() => {
    lastShown.current = shown;
  });
  const hidden = kept.filter((entry) => entry.key !== shown.key && isLive(entry.key));
  const popupsOf = (key: string) => {
    let popups = pagePopups.get(key);
    if (!popups) pagePopups.set(key, (popups = createPagePopups()));
    return popups;
  };
  // One keyed list, so a page keeps its instance as it moves between shown and
  // hidden. The shown page comes first, so lookups by ID such as the composer's
  // `#project-prompt` find it before a hidden page's copy.
  return [shown, ...hidden].map((entry) => (
    <Activity key={entry.key} mode={entry === shown ? "visible" : "hidden"}>
      <PagePopupsContext value={popupsOf(entry.key)}>{entry.page}</PagePopupsContext>
    </Activity>
  ));
}

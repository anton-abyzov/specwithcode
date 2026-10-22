import type { DesignPage } from "@specweave-studio/contracts";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const OPEN_KEY = "specwithcode.design.notesOpen";
const SAVE_AFTER_MS = 600;

/**
 * Speaker notes for the current slide, stored on the page (`DesignPage.notes`).
 * Typing saves after a short pause and on blur; a live update (the agent, an
 * undo) replaces the text only while the field is not being edited.
 */
export function SpeakerNotes({
  page,
  readOnly,
  onSave,
}: {
  page: DesignPage;
  readOnly: boolean;
  /** Gets the page the text was typed on, which may no longer be the one shown. */
  onSave: (pageId: string, notes: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(() => readOpen());
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ pageId: string; text: string } | null>(null);
  const saveRef = useRef(onSave);
  useLayoutEffect(() => {
    saveRef.current = onSave;
  });
  const value = page.notes ?? "";

  const flush = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next !== null) saveRef.current(next.pageId, next.text);
  }, []);

  // The editor remounts this per slide (keyed by page), so unmounting saves what was typed.
  useEffect(() => flush, [flush]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // Storage can be unavailable; the panel still toggles for this view.
    }
  };

  return (
    <section
      aria-label="Speaker notes"
      data-testid="speaker-notes"
      className="shrink-0 border-t border-border/70 bg-background"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-notes`}
        onClick={toggle}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronUpIcon className="size-3.5" />}
        Speaker notes
        {!open && value !== "" && (
          <span className="ml-1 truncate text-muted-foreground">{value.split("\n")[0]}</span>
        )}
      </button>
      {open && (
        <textarea
          id={`${id}-notes`}
          aria-label="Speaker notes for this slide"
          data-testid="speaker-notes-field"
          readOnly={readOnly}
          value={draft ?? value}
          maxLength={100_000}
          placeholder={readOnly ? "No notes for this slide." : "What to say on this slide"}
          onFocus={() => setDraft((current) => current ?? value)}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDraft(text);
            pending.current = { pageId: page.id, text };
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(flush, SAVE_AFTER_MS);
          }}
          onBlur={() => {
            flush();
            setDraft(null);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="block h-24 w-full resize-none bg-transparent px-3 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
      )}
    </section>
  );
}

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

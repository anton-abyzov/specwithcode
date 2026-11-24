import {
  type WhiteboardFile,
  mergeWhiteboardSave,
  parseWhiteboard,
  whiteboardRevision,
} from "@specweave-studio/shared/officeWhiteboard";
import { DownloadIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTx } from "../../../i18n";
import { Button } from "../../ui/button";
import {
  WHITEBOARD_HOST_PROPERTY,
  type WhiteboardFrameApi,
  type WhiteboardFrameElement,
  type WhiteboardFrameHost,
  type WhiteboardTheme,
  whiteboardFrameUrl,
} from "./bridge";

/** How long drawing must pause before the whiteboard saves. */
export const WHITEBOARD_AUTOSAVE_MS = 800;

export type WhiteboardSaveOutcome = boolean | "conflict";

type Status = "saved" | "dirty" | "saving" | "error";

/**
 * Edits a closed editor could not save (a conflict was open, or a save was on
 * its way), kept for this session so reopening the same file brings them back.
 */
interface WhiteboardDraft {
  readonly contents: string;
  /** The revision the edits build on, and the ones this editor wrote. */
  readonly base: string;
  readonly own: ReadonlyArray<string>;
  /** The editor that left it; only that editor's own late save may move its base. */
  readonly owner: symbol;
}
const drafts = new Map<string, WhiteboardDraft>();
/**
 * Kept edits too large to open, held apart so no later close or save replaces
 * them: they leave only when downloaded.
 */
const strandedDrafts = new Map<string, ReadonlyArray<WhiteboardDraft>>();

/** The kept draft for a file, if any (tests). */
export function whiteboardDraft(key: string): WhiteboardDraft | undefined {
  return drafts.get(key);
}

function download(data: Blob | string, filename: string, type: string): void {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * A whiteboard (`.excalidraw` file) in the embedded Excalidraw editor. Edits
 * save on their own after a short pause, each write checked against the
 * revision it builds on; a change on disk while editing shows the same
 * Reload latest / Keep my edits banner as a sheet. A change on disk with no
 * edits waiting simply shows up.
 */
export function WhiteboardView(props: {
  readonly text: string;
  readonly name: string;
  readonly mode: WhiteboardTheme;
  /** Writes the file; resolves false on failure or "conflict" when the revision moved. */
  readonly onSave?:
    | ((contents: string, expectedRevision: string) => Promise<WhiteboardSaveOutcome>)
    | undefined;
  /** Fetches the file again from disk (on conflict and Reload latest). */
  readonly onReload?: (() => void | Promise<void>) | undefined;
  /** Where whiteboard.html is served; the app's own copy by default. */
  readonly frameUrl?: string | undefined;
  /** Identifies the file, so unsaved edits survive closing and reopening it. */
  readonly draftKey?: string | undefined;
}): ReactNode {
  const tx = useTx();
  const incomingRevision = useMemo(() => whiteboardRevision(props.text), [props.text]);
  const parsed = useMemo(() => parseWhiteboard(props.text), [props.text]);
  const apiRef = useRef<WhiteboardFrameApi | null>(null);
  const frameRef = useRef<WhiteboardFrameElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Edits left by an earlier editor of this file; they win over the file on disk
  // when it is still the one they build on, and raise the banner when it is not.
  // A view-only editor never takes them: it could not save them, and would drop them.
  const [token] = useState(() => Symbol("whiteboard editor"));
  const [kept] = useState(() =>
    props.draftKey === undefined || props.onSave === undefined
      ? undefined
      : drafts.get(props.draftKey),
  );
  // Edits the editor could not hold (over the element limit) are offered as a file
  // instead of replacing the board; the draft stays until they are downloaded.
  // Every such draft is kept, oldest first, until downloaded.
  const [oversized] = useState(() =>
    kept !== undefined && !parseWhiteboard(kept.contents).ok ? kept : undefined,
  );
  const [stranded, setStranded] = useState<ReadonlyArray<WhiteboardDraft>>(() => {
    if (props.draftKey === undefined || props.onSave === undefined) return [];
    const earlier = strandedDrafts.get(props.draftKey) ?? [];
    return oversized === undefined || earlier.includes(oversized)
      ? earlier
      : [...earlier, oversized];
  });
  // Move an oversized draft out of the way of later closes, into its own store.
  useEffect(() => {
    const key = props.draftKey;
    if (key === undefined || oversized === undefined) return;
    const earlier = strandedDrafts.get(key) ?? [];
    if (!earlier.includes(oversized)) strandedDrafts.set(key, [...earlier, oversized]);
    if (drafts.get(key) === oversized) drafts.delete(key);
  }, [props.draftKey, oversized]);
  const [draft] = useState(() =>
    kept !== undefined && parseWhiteboard(kept.contents).ok ? kept : undefined,
  );
  const followed =
    draft === undefined || draft.base === incomingRevision || draft.own.includes(incomingRevision);
  // What the editor shows and what the next write is checked against.
  const state = useRef({
    base: draft === undefined || followed ? incomingRevision : draft.base,
    loaded: parsed.ok ? parsed.file : (null as WhiteboardFile | null),
    // Only revisions this editor wrote: a revision it merely loaded is not its own.
    own: new Set<string>(draft?.own ?? []),
    dirty: draft !== undefined,
    saving: false,
    conflict: !followed,
  });
  const alive = useRef(true);
  const [status, setStatus] = useState<Status>(draft === undefined ? "saved" : "dirty");
  const [conflict, setConflict] = useState(!followed);
  const [error, setError] = useState<string | null>(
    draft !== undefined && !parsed.ok ? parsed.error : null,
  );
  const [ready, setReady] = useState(false);
  const [baseRevision, setBaseRevision] = useState(state.current.base);
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  const flush = useCallback(
    async (options?: { readonly force?: string }): Promise<void> => {
      const current = state.current;
      const api = apiRef.current;
      const onSave = propsRef.current.onSave;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (api === null || onSave === undefined || current.saving) return;
      if (current.conflict && options?.force === undefined) return;
      if (!current.dirty && options?.force === undefined) return;
      let contents: string;
      try {
        contents = mergeWhiteboardSave(api.serialize(), current.loaded);
      } catch (cause) {
        setStatus("error");
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      // Never write a file the editor would refuse to open again (too many elements).
      const checked = parseWhiteboard(contents);
      if (!checked.ok) {
        setStatus("error");
        setError(checked.error);
        return;
      }
      const revision = whiteboardRevision(contents);
      const expected = options?.force ?? current.base;
      current.dirty = false;
      if (revision === current.base && options?.force === undefined) {
        setStatus("saved");
        return;
      }
      current.saving = true;
      current.own.add(revision);
      setStatus("saving");
      let outcome: WhiteboardSaveOutcome;
      try {
        outcome = await onSave(contents, expected);
      } catch {
        outcome = false;
      }
      current.saving = false;
      // Closed meanwhile: the closing editor kept the drawing as a draft. A save
      // that landed moves the draft's base; one that did not leaves it to reopen.
      if (!alive.current) {
        const key = propsRef.current.draftKey;
        const left = key === undefined ? undefined : drafts.get(key);
        if (key !== undefined && left !== undefined && left.owner === token && outcome === true) {
          if (left.contents === contents) drafts.delete(key);
          else drafts.set(key, { ...left, base: revision });
        }
        return;
      }
      if (outcome === "conflict") {
        current.conflict = true;
        current.dirty = true;
        setConflict(true);
        setStatus("dirty");
        void propsRef.current.onReload?.();
        return;
      }
      if (!outcome) {
        current.dirty = true;
        setStatus("error");
        setError(tx("The whiteboard could not be saved."));
        return;
      }
      current.base = revision;
      setBaseRevision(revision);
      current.loaded = checked.file;
      current.conflict = false;
      setConflict(false);
      setError(null);
      // An edit made while this one was on its way saves next.
      if (current.dirty) {
        setStatus("dirty");
        timer.current = setTimeout(() => void flushRef.current(), WHITEBOARD_AUTOSAVE_MS);
      } else {
        setStatus("saved");
      }
    },
    [tx],
  );

  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  // One frame per mounted view: later text arrives through load().
  const [host] = useState<WhiteboardFrameHost>(() => ({
    text: draft?.contents ?? props.text,
    theme: props.mode,
    viewOnly: props.onSave === undefined,
    onReady: (api) => {
      apiRef.current = api;
      setReady(true);
      api.focus();
      // The editor now holds the kept edits; until then the draft stays put.
      const key = propsRef.current.draftKey;
      if (key !== undefined && draft !== undefined && drafts.get(key) === draft) drafts.delete(key);
      // Kept edits on the file they build on save as soon as the editor is up.
      if (state.current.dirty && !state.current.conflict) {
        timer.current = setTimeout(() => void flushRef.current(), WHITEBOARD_AUTOSAVE_MS);
      }
    },
    onEdit: () => {
      if (propsRef.current.onSave === undefined) return;
      state.current.dirty = true;
      setStatus("dirty");
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flushRef.current(), WHITEBOARD_AUTOSAVE_MS);
    },
    onError: (message) => setError(message),
  }));

  const attachFrame = useCallback(
    (element: WhiteboardFrameElement | null) => {
      frameRef.current = element;
      if (element !== null) element[WHITEBOARD_HOST_PROPERTY] = host;
    },
    [host],
  );

  // The file on disk moved: follow it when nothing is waiting, otherwise ask.
  useEffect(() => {
    const current = state.current;
    if (current.own.has(incomingRevision) || incomingRevision === current.base) return;
    // A file the editor cannot open never replaces the drawing: ask, and say why.
    if (!parsed.ok) {
      current.conflict = true;
      setConflict(true);
      setError(parsed.error);
      return;
    }
    if (current.dirty || current.saving || current.conflict) {
      current.conflict = true;
      setConflict(true);
      return;
    }
    const api = apiRef.current;
    if (api === null) return;
    api.load(props.text);
    current.base = incomingRevision;
    setBaseRevision(incomingRevision);
    current.loaded = parsed.file;
    current.own = new Set<string>();
  }, [incomingRevision, parsed, props.text]);

  useEffect(() => {
    apiRef.current?.setTheme(props.mode);
  }, [props.mode, ready]);

  useEffect(() => {
    apiRef.current?.setViewOnly(props.onSave === undefined);
  }, [props.onSave, ready]);

  // Leaving the editor: read the drawing while the frame is still there, keep it
  // as a draft, and save it from that copy when nothing stands in the way.
  useLayoutEffect(() => {
    // StrictMode replays effects: the editor is alive again after a replayed cleanup.
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      const current = state.current;
      const api = apiRef.current;
      const { draftKey, onSave } = propsRef.current;
      // Unsaved edits, or a save still on its way that may yet be refused.
      if ((!current.dirty && !current.saving) || api === null) return;
      let contents: string;
      try {
        contents = mergeWhiteboardSave(api.serialize(), current.loaded);
      } catch {
        return;
      }
      if (draftKey !== undefined) {
        drafts.set(draftKey, {
          contents,
          base: current.base,
          own: [...current.own],
          owner: token,
        });
      }
      if (current.conflict || current.saving || onSave === undefined) return;
      if (!parseWhiteboard(contents).ok) return;
      void onSave(contents, current.base)
        .then((outcome) => {
          if (
            outcome === true &&
            draftKey !== undefined &&
            drafts.get(draftKey)?.contents === contents
          ) {
            drafts.delete(draftKey);
          }
        })
        .catch(() => undefined);
    };
  }, [token]);

  const reloadLatest = () => {
    const current = state.current;
    if (!parsed.ok) {
      // Nothing to load: the drawing and its edits stay until the file is fixed.
      setError(parsed.error);
      void props.onReload?.();
      return;
    }
    current.conflict = false;
    current.dirty = false;
    setConflict(false);
    setError(null);
    setStatus("saved");
    if (parsed.ok && apiRef.current !== null) {
      apiRef.current.load(props.text);
      current.base = incomingRevision;
      setBaseRevision(incomingRevision);
      current.loaded = parsed.file;
      current.own = new Set<string>();
    }
    void props.onReload?.();
  };

  const keepMine = () => {
    // Overwrite exactly the revision now on disk, never an unchecked write.
    void flush({ force: incomingRevision });
  };

  const exportAs = async (kind: "png" | "svg" | "excalidraw") => {
    const api = apiRef.current;
    if (api === null) return;
    setError(null);
    try {
      if (kind === "png") download(await api.exportPng(), `${props.name}.png`, "image/png");
      else if (kind === "svg")
        download(await api.exportSvg(), `${props.name}.svg`, "image/svg+xml");
      else
        download(
          mergeWhiteboardSave(api.serialize(), state.current.loaded),
          `${props.name}.excalidraw`,
          "application/vnd.excalidraw+json",
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tx("Export failed."));
    }
  };

  // A file the editor cannot open shows why, unless kept edits are waiting for it.
  const strandedBanner =
    stranded.length === 0 ? null : (
      <div
        className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs"
        role="alert"
        data-whiteboard-stranded
      >
        <span>
          {tx(
            "Unsaved edits from before hold more than a whiteboard can open. This is the saved board.",
          )}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            // One file per click: a browser may block a second automatic download.
            const [first, ...rest] = stranded;
            if (first === undefined) return;
            download(
              first.contents,
              `${props.name}-unsaved${stranded.length > 1 ? `-${Date.now()}` : ""}.excalidraw`,
              "application/vnd.excalidraw+json",
            );
            const key = props.draftKey;
            if (key !== undefined) {
              const left = (strandedDrafts.get(key) ?? []).filter((each) => each !== first);
              if (left.length > 0) strandedDrafts.set(key, left);
              else strandedDrafts.delete(key);
            }
            setStranded(rest);
          }}
          data-whiteboard-stranded-download
        >
          <DownloadIcon aria-hidden />
          {stranded.length > 1
            ? tx("Download unsaved edits ({count} left)", { count: stranded.length })
            : tx("Download unsaved edits")}
        </Button>
      </div>
    );

  if (!parsed.ok && !ready && draft === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-office="whiteboard">
        {strandedBanner}
        <p className="m-auto p-6 text-center text-muted-foreground text-sm" role="alert">
          {parsed.error}
        </p>
      </div>
    );
  }

  const statusText =
    props.onSave === undefined
      ? tx("View only")
      : status === "saving"
        ? tx("Saving…")
        : status === "dirty"
          ? tx("Unsaved changes")
          : status === "error"
            ? tx("Not saved")
            : tx("Saved");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-office="whiteboard">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          role="status"
          data-whiteboard-status={props.onSave === undefined ? "view-only" : status}
        >
          {statusText}
        </span>
        {(["png", "svg", "excalidraw"] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            size="sm"
            variant="outline"
            disabled={!ready}
            onClick={() => void exportAs(kind)}
            data-whiteboard-export={kind}
          >
            <DownloadIcon aria-hidden />
            {kind === "png" ? "PNG" : kind === "svg" ? "SVG" : ".excalidraw"}
          </Button>
        ))}
      </div>
      {conflict ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs"
          role="alert"
          data-whiteboard-conflict
        >
          <span>{tx("This whiteboard changed on disk while you were editing.")}</span>
          <div className="inline-flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={reloadLatest}
              data-whiteboard-conflict-reload
            >
              {tx("Reload latest")}
            </Button>
            {props.onSave ? (
              <Button
                type="button"
                size="sm"
                disabled={status === "saving" || incomingRevision === baseRevision}
                onClick={keepMine}
                data-whiteboard-conflict-keep
              >
                {incomingRevision === baseRevision
                  ? tx("Refreshing latest...")
                  : tx("Keep my edits")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {strandedBanner}
      {error !== null ? (
        <p
          className="shrink-0 border-b px-3 py-1.5 text-destructive-foreground text-xs"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <iframe
        ref={attachFrame}
        src={props.frameUrl ?? whiteboardFrameUrl()}
        title={tx("Whiteboard editor")}
        className="min-h-0 w-full flex-1 border-0"
        allow="clipboard-read; clipboard-write"
        data-whiteboard-frame
      />
    </div>
  );
}

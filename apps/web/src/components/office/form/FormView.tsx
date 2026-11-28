/**
 * A form artifact: Edit (the editor), Fill in (answering it) and Responses
 * (its responses Sheet). Edits save on their own, by revision, so a change made
 * on disk since the form was read is never overwritten.
 */
import {
  type FormAnswers,
  type FormDocument,
  formRevision,
  parseForm,
  serializeForm,
  validateFormDocument,
} from "@specweave-studio/shared/officeForm";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";

import { useTx } from "../../../i18n";
import { FormEditor } from "./FormEditor";
import { FormFill, type FormSubmitOutcome } from "./FormFill";

export type FormSaveOutcome = boolean | "conflict";
export type FormTab = "edit" | "fill" | "responses";

/** How long typing pauses before the form is saved. */
export const FORM_SAVE_DELAY_MS = 600;

type SaveState =
  | { readonly kind: "saved" }
  | { readonly kind: "saving" }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "failed" }
  | { readonly kind: "conflict" };

export function FormView(props: {
  readonly text: string;
  /** Absent where this person may not change files here: the form opens to Fill in, read-only. */
  readonly onSave:
    | ((contents: string, expectedRevision: string) => Promise<FormSaveOutcome>)
    | undefined;
  readonly onSubmit:
    | ((document: FormDocument, answers: FormAnswers) => Promise<FormSubmitOutcome>)
    | undefined;
  readonly onReload: () => void;
  readonly responseCount: number | null;
  /** The Responses tab's content: the responses Sheet in the Sheet editor. */
  readonly responses: ReactNode;
  readonly initialTab?: FormTab;
}): ReactNode {
  const tx = useTx();
  const parsed = useMemo(() => parseForm(props.text), [props.text]);
  const incomingRevision = useMemo(() => formRevision(props.text), [props.text]);
  const [draft, setDraft] = useState<FormDocument | null>(parsed.ok ? parsed.document : null);
  const [tab, setTab] = useState<FormTab>(props.initialTab ?? (props.onSave ? "edit" : "fill"));
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const savedRevision = useRef(incomingRevision);
  /** Counts edits, so a save that finishes after a newer edit does not mark the form saved. */
  const edits = useRef(0);
  const savedEdits = useRef(0);
  const inFlight = useRef(false);
  /** Sends the edit waiting for its timer; run when the view closes, so it is not lost. */
  const pendingSave = useRef<(() => void) | null>(null);
  const queued = useRef<{ readonly document: FormDocument; readonly at: number } | null>(null);

  // A change on disk is taken in while nothing here is unsaved.
  useEffect(() => {
    if (incomingRevision === savedRevision.current || !parsed.ok) return;
    if (edits.current === savedEdits.current) {
      savedRevision.current = incomingRevision;
      setDraft(parsed.document);
      setSave({ kind: "saved" });
    }
  }, [incomingRevision, parsed]);

  const { onSave } = props;
  useEffect(() => {
    if (draft === null || onSave === undefined || edits.current === savedEdits.current) return;
    const checked = validateFormDocument(draft);
    if (!checked.ok) {
      pendingSave.current = null;
      setSave({ kind: "invalid", error: checked.error });
      return;
    }
    // One save at a time: a save sent while another is out would carry the
    // revision from before it and be refused as a change on disk. The newest
    // edit waits and goes out by the revision the first save wrote.
    const send = (document: FormDocument, at: number) => {
      if (inFlight.current) {
        queued.current = { document, at };
        return;
      }
      inFlight.current = true;
      const contents = serializeForm(document);
      setSave({ kind: "saving" });
      void onSave(contents, savedRevision.current).then((outcome) => {
        inFlight.current = false;
        const next = queued.current;
        queued.current = null;
        if (outcome !== true) {
          setSave({ kind: outcome === "conflict" ? "conflict" : "failed" });
          return;
        }
        savedRevision.current = formRevision(contents);
        savedEdits.current = Math.max(savedEdits.current, at);
        if (next !== null && next.at > savedEdits.current) send(next.document, next.at);
        else setSave(edits.current === at ? { kind: "saved" } : { kind: "saving" });
      });
    };
    const at = edits.current;
    const flush = () => {
      pendingSave.current = null;
      // Only an edit still unsaved and not let go goes out.
      if (savedEdits.current >= at || edits.current !== at) return;
      send(draft, at);
    };
    pendingSave.current = flush;
    const timer = setTimeout(flush, FORM_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, onSave]);
  // Closing the form, or switching to another file, saves an edit still waiting for its timer.
  useEffect(() => () => pendingSave.current?.(), []);

  if (!parsed.ok && draft === null) {
    return (
      <div className="m-auto flex flex-col items-center gap-3 p-6 text-center text-sm" role="alert">
        <p>{tx("This form cannot be opened: {error}", { error: parsed.error })}</p>
        <Button variant="outline" size="sm" onClick={props.onReload}>
          {tx("Reload")}
        </Button>
      </div>
    );
  }
  const document = draft!;
  const saved = parsed.ok ? parsed.document : null;
  const change = (next: FormDocument) => {
    edits.current += 1;
    setDraft(next);
    setSave({ kind: "saving" });
  };
  const tabs: ReadonlyArray<{ readonly id: FormTab; readonly label: string }> = [
    ...(props.onSave ? [{ id: "edit" as const, label: tx("Edit") }] : []),
    { id: "fill", label: tx("Fill in") },
    {
      id: "responses",
      label:
        props.responseCount === null
          ? tx("Responses")
          : tx("Responses ({count})", { count: props.responseCount }),
    },
  ];
  const status =
    props.onSave === undefined
      ? tx("Read only")
      : save.kind === "saving"
        ? tx("Saving…")
        : save.kind === "invalid"
          ? tx("Not saved: {error}", { error: save.error })
          : save.kind === "failed"
            ? tx("Not saved. Edit again to retry.")
            : save.kind === "conflict"
              ? tx("This form changed on disk.")
              : tx("Saved");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div role="tablist" aria-label={tx("Form")} className="flex gap-1">
          {tabs.map((each) => (
            <Button
              key={each.id}
              role="tab"
              size="sm"
              variant={tab === each.id ? "secondary" : "ghost"}
              aria-selected={tab === each.id}
              onClick={() => setTab(each.id)}
            >
              {each.label}
            </Button>
          ))}
        </div>
        <span
          className={
            save.kind === "invalid" || save.kind === "conflict" || save.kind === "failed"
              ? "ms-auto text-destructive-foreground text-xs"
              : "ms-auto text-muted-foreground text-xs"
          }
          role="status"
        >
          {status}
        </span>
        {save.kind === "conflict" ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              // The file on disk wins; what was typed here since is let go, saves waiting included.
              savedEdits.current = edits.current;
              pendingSave.current = null;
              queued.current = null;
              if (parsed.ok) {
                savedRevision.current = incomingRevision;
                setDraft(parsed.document);
              }
              setSave({ kind: "saved" });
              props.onReload();
            }}
          >
            {tx("Load the saved form")}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
        {tab === "edit" && props.onSave ? (
          <FormEditor document={document} onChange={change} />
        ) : tab === "fill" ? (
          <>
            {props.onSave && save.kind !== "saved" && saved !== null ? (
              <p className="mx-auto max-w-2xl px-4 pt-4 text-muted-foreground text-xs" role="note">
                {tx(
                  "Fill in shows the saved form. Your latest edits appear here once they are saved.",
                )}
              </p>
            ) : null}
            <FormFill
              // A form changed since is a new form to fill in.
              key={serializeForm(saved ?? document)}
              document={saved ?? document}
              // Answers go only to the form as saved, never to a draft that may not save.
              onSubmit={
                props.onSubmit && saved !== null
                  ? (answers) => props.onSubmit!(saved, answers)
                  : undefined
              }
            />
          </>
        ) : (
          props.responses
        )}
      </div>
    </div>
  );
}

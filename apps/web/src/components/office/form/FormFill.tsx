/**
 * Filling a form in: one page per section, answers checked against the form
 * before anything is sent, and a confirmation once the row is in the
 * responses Sheet.
 */
import {
  FORM_LIMITS,
  type FormAnswer,
  type FormAnswerProblem,
  type FormAnswers,
  type FormDocument,
  type FormItem,
  isFormQuestion,
  validateFormAnswers,
} from "@specweave-studio/shared/officeForm";
import { type ReactNode, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import { useTx } from "../../../i18n";
import { nativeSelectClass } from "./FormEditor";

export type FormSubmitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** The form's items split into pages: a section starts a new one. */
export function formPages(document: FormDocument): ReadonlyArray<ReadonlyArray<FormItem>> {
  const pages: FormItem[][] = [[]];
  for (const item of document.items) {
    if (item.type === "section" && pages[pages.length - 1]!.length > 0) pages.push([]);
    pages[pages.length - 1]!.push(item);
  }
  return pages;
}

/** What the person picked, with "Other" kept apart until the answers are put together. */
export interface FillState {
  readonly values: Readonly<Record<string, FormAnswer>>;
  readonly other: Readonly<Record<string, { readonly on: boolean; readonly text: string }>>;
}

const EMPTY: FillState = { values: {}, other: {} };

/** The answers to send: "Other" text in place of the choice, or last among the picks. */
export function fillAnswers(document: FormDocument, state: FillState): FormAnswers {
  const answers: Record<string, FormAnswer> = {};
  for (const item of document.items) {
    if (!isFormQuestion(item)) continue;
    const value = state.values[item.id] ?? null;
    const other = state.other[item.id];
    if (item.type === "choice" && other?.on === true) answers[item.id] = other.text;
    else if (item.type === "checkboxes") {
      const picked = Array.isArray(value) ? (value as ReadonlyArray<string>) : [];
      answers[item.id] =
        other?.on === true && other.text.trim().length > 0 ? [...picked, other.text] : picked;
    } else answers[item.id] = value;
  }
  return answers;
}

function Question(props: {
  readonly item: FormItem;
  readonly state: FillState;
  readonly problem: string | undefined;
  readonly onChange: (state: FillState) => void;
}): ReactNode {
  const tx = useTx();
  const { item, state } = props;
  const value = state.values[item.id] ?? null;
  const other = state.other[item.id] ?? { on: false, text: "" };
  const labelId = `form-q-${item.id}`;
  const set = (next: FormAnswer) =>
    props.onChange({ ...state, values: { ...state.values, [item.id]: next } });
  const setOther = (next: { on: boolean; text: string }) =>
    props.onChange({ ...state, other: { ...state.other, [item.id]: next } });
  const invalid = props.problem !== undefined || undefined;
  let control: ReactNode = null;
  switch (item.type) {
    case "short":
      control = (
        <Input
          aria-labelledby={labelId}
          aria-invalid={invalid}
          maxLength={FORM_LIMITS.answerChars}
          value={typeof value === "string" ? value : ""}
          placeholder={tx("Your answer")}
          onChange={(event) => set(event.currentTarget.value)}
        />
      );
      break;
    case "paragraph":
      control = (
        <Textarea
          rows={3}
          aria-labelledby={labelId}
          aria-invalid={invalid}
          maxLength={FORM_LIMITS.answerChars}
          value={typeof value === "string" ? value : ""}
          placeholder={tx("Your answer")}
          onChange={(event) => set(event.currentTarget.value)}
        />
      );
      break;
    case "choice":
      control = (
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-invalid={invalid}
          className="flex flex-col gap-2"
        >
          {(item.options ?? []).map((option) => (
            <label key={option} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                className="size-4 accent-primary"
                name={labelId}
                checked={!other.on && value === option}
                onChange={() => {
                  props.onChange({
                    values: { ...state.values, [item.id]: option },
                    other: { ...state.other, [item.id]: { ...other, on: false } },
                  });
                }}
              />
              {option}
            </label>
          ))}
          {item.other === true ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                className="size-4 accent-primary"
                name={labelId}
                checked={other.on}
                onChange={() => setOther({ ...other, on: true })}
              />
              {tx("Other:")}
              <Input
                size="sm"
                aria-label={tx("Other answer")}
                maxLength={FORM_LIMITS.answerChars}
                value={other.text}
                onChange={(event) => setOther({ on: true, text: event.currentTarget.value })}
              />
            </label>
          ) : null}
        </div>
      );
      break;
    case "checkboxes": {
      const picked = Array.isArray(value) ? (value as ReadonlyArray<string>) : [];
      control = (
        <div
          role="group"
          aria-labelledby={labelId}
          aria-invalid={invalid}
          className="flex flex-col gap-2"
        >
          {(item.options ?? []).map((option) => (
            <label key={option} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={picked.includes(option)}
                onChange={(event) =>
                  set(
                    event.currentTarget.checked
                      ? [...picked, option]
                      : picked.filter((each) => each !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
          {item.other === true ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={other.on}
                onChange={(event) => setOther({ ...other, on: event.currentTarget.checked })}
              />
              {tx("Other:")}
              <Input
                size="sm"
                aria-label={tx("Other answer")}
                maxLength={FORM_LIMITS.answerChars}
                value={other.text}
                onChange={(event) => setOther({ on: true, text: event.currentTarget.value })}
              />
            </label>
          ) : null}
        </div>
      );
      break;
    }
    case "dropdown":
      control = (
        <select
          className={`${nativeSelectClass} max-w-xs`}
          aria-labelledby={labelId}
          aria-invalid={invalid}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => set(event.currentTarget.value || null)}
        >
          <option value="">{tx("Choose")}</option>
          {(item.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      break;
    case "scale": {
      const scale = item.scale ?? { min: 1, max: 5 };
      const steps = Array.from(
        { length: scale.max - scale.min + 1 },
        (_, index) => index + scale.min,
      );
      control = (
        <div
          className="flex flex-wrap items-end gap-3"
          role="radiogroup"
          aria-labelledby={labelId}
          aria-invalid={invalid}
        >
          {scale.minLabel ? (
            <span className="pb-1 text-muted-foreground text-sm">{scale.minLabel}</span>
          ) : null}
          {steps.map((step) => (
            <label key={step} className="flex cursor-pointer flex-col items-center gap-1 text-sm">
              {step}
              <input
                type="radio"
                className="size-4 accent-primary"
                name={labelId}
                checked={value === step}
                onChange={() => set(step)}
              />
            </label>
          ))}
          {scale.maxLabel ? (
            <span className="pb-1 text-muted-foreground text-sm">{scale.maxLabel}</span>
          ) : null}
        </div>
      );
      break;
    }
    case "date":
    case "time":
      control = (
        <Input
          type={item.type}
          className="max-w-48"
          aria-labelledby={labelId}
          aria-invalid={invalid}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => set(event.currentTarget.value || null)}
        />
      );
      break;
    default:
      break;
  }
  return (
    <li className="flex flex-col gap-3 rounded-xl border bg-card p-4" data-invalid={invalid}>
      <div className="flex flex-col gap-1">
        <p id={labelId} className="font-medium text-sm">
          {item.title || tx("Untitled question")}
          {item.required === true ? (
            <span className="ms-1 text-destructive-foreground" aria-label={tx("required")}>
              *
            </span>
          ) : null}
        </p>
        {item.description ? (
          <p className="whitespace-pre-wrap text-muted-foreground text-sm">{item.description}</p>
        ) : null}
      </div>
      {control}
      {props.problem !== undefined ? (
        <p className="text-destructive-foreground text-sm" role="alert">
          {tx(props.problem)}
        </p>
      ) : null}
    </li>
  );
}

export function FormFill(props: {
  readonly document: FormDocument;
  /** Absent where this person may not add rows to the responses Sheet. */
  readonly onSubmit: ((answers: FormAnswers) => Promise<FormSubmitOutcome>) | undefined;
}): ReactNode {
  const tx = useTx();
  const { document } = props;
  const pages = useMemo(() => formPages(document), [document]);
  const [page, setPage] = useState(0);
  const [state, setState] = useState<FillState>(EMPTY);
  const [problems, setProblems] = useState<ReadonlyArray<FormAnswerProblem>>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const current = pages[Math.min(page, pages.length - 1)] ?? [];
  const last = page >= pages.length - 1;
  const problemOf = new Map(problems.map((problem) => [problem.itemId, problem.message]));

  /** The problems on this page; nothing is sent, and Next stays here, while there are any. */
  const check = (items: ReadonlyArray<FormItem>) => {
    const ids = new Set(items.map((item) => item.id));
    const found = validateFormAnswers(document, fillAnswers(document, state)).filter((problem) =>
      ids.has(problem.itemId),
    );
    setProblems(found);
    return found.length === 0;
  };

  if (sent) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
        <div
          className="flex flex-col gap-3 rounded-xl border border-primary border-t-8 bg-card p-6"
          role="status"
        >
          <h2 className="font-semibold text-lg">{document.title || tx("Untitled form")}</h2>
          <p className="text-sm">
            {document.confirmation?.trim() || tx("Your response has been recorded.")}
          </p>
          <div>
            <Button
              variant="link"
              size="sm"
              onClick={() => {
                setState(EMPTY);
                setProblems([]);
                setPage(0);
                setSent(false);
              }}
            >
              {tx("Submit another response")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4"
      aria-label={document.title || tx("Untitled form")}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!last) {
          if (check(current)) setPage(page + 1);
          return;
        }
        if (!check(document.items) || props.onSubmit === undefined) return;
        setSending(true);
        setError(null);
        const outcome = await props.onSubmit(fillAnswers(document, state));
        setSending(false);
        if (outcome.ok) setSent(true);
        else setError(outcome.error);
      }}
    >
      {page === 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-primary border-t-8 bg-card p-4">
          <h2 className="font-semibold text-xl">{document.title || tx("Untitled form")}</h2>
          {document.description ? (
            <p className="whitespace-pre-wrap text-muted-foreground text-sm">
              {document.description}
            </p>
          ) : null}
          {document.items.some((item) => item.required === true) ? (
            <p className="text-destructive-foreground text-xs">{tx("* Required")}</p>
          ) : null}
        </div>
      ) : null}
      <ol className="flex flex-col gap-3">
        {current.map((item) =>
          isFormQuestion(item) ? (
            <Question
              key={item.id}
              item={item}
              state={state}
              problem={problemOf.get(item.id)}
              onChange={(next) => {
                setState(next);
                // An answer being changed is no longer the one that was refused.
                if (problemOf.has(item.id)) {
                  setProblems(problems.filter((problem) => problem.itemId !== item.id));
                }
              }}
            />
          ) : (
            <li
              key={item.id}
              className={
                item.type === "section"
                  ? "flex flex-col gap-1 rounded-xl border border-primary/40 border-t-4 bg-card p-4"
                  : "flex flex-col gap-1 rounded-xl border bg-card p-4"
              }
            >
              <h3 className="font-semibold">{item.title}</h3>
              {item.description ? (
                <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                  {item.description}
                </p>
              ) : null}
            </li>
          ),
        )}
      </ol>
      {error !== null ? (
        <p className="text-destructive-foreground text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {page > 0 ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setPage(page - 1)}>
            {tx("Back")}
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          disabled={sending || (last && props.onSubmit === undefined)}
        >
          {last ? (sending ? tx("Sending…") : tx("Submit")) : tx("Next")}
        </Button>
        {pages.length > 1 ? (
          <span className="text-muted-foreground text-xs">
            {tx("Page {page} of {pages}", { page: page + 1, pages: pages.length })}
          </span>
        ) : null}
        {last && props.onSubmit === undefined ? (
          <span className="text-muted-foreground text-xs">
            {tx("This window cannot add answers to the project.")}
          </span>
        ) : null}
      </div>
    </form>
  );
}

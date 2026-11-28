/**
 * The form editor: the form's title and description, then one card per item.
 * Every change hands a whole new FormDocument up; fields the editor does not
 * know stay on each item, because items are only ever spread and changed.
 */
import {
  FORM_ITEM_TYPE_LABELS,
  FORM_LIMITS,
  FORM_SCALE,
  type FormDocument,
  type FormItem,
  type FormItemType,
  type FormScale,
  hasOptions,
  isFormQuestion,
  newFormItem,
} from "@specweave-studio/shared/officeForm";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";

import { useTx } from "../../../i18n";

const TYPE_ORDER: ReadonlyArray<FormItemType> = [
  "short",
  "paragraph",
  "choice",
  "checkboxes",
  "dropdown",
  "scale",
  "date",
  "time",
  "section",
  "text",
];

export const nativeSelectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32";

/** An item changed to another type: what carries over does, what does not fit is dropped. */
export function changeItemType(item: FormItem, type: FormItemType): FormItem {
  const {
    options: _options,
    other: _other,
    scale: _scale,
    required: _required,
    ...rest
  } = item as FormItem & Record<string, unknown>;
  const next: Record<string, unknown> = { ...rest, type };
  if (isFormQuestion({ type }) && item.required !== undefined) next.required = item.required;
  if (hasOptions(type))
    next.options = item.options && item.options.length > 0 ? item.options : ["Option 1"];
  if ((type === "choice" || type === "checkboxes") && item.other === true) next.other = true;
  if (type === "scale") next.scale = item.scale ?? { min: 1, max: 5 };
  return next as unknown as FormItem;
}

/** A copy of an item under a new id, placed right after it. */
export function duplicateItem(document: FormDocument, index: number): FormDocument {
  const item = document.items[index];
  if (item === undefined || document.items.length >= FORM_LIMITS.items) return document;
  const id = newFormItem(
    "short",
    document.items.map((each) => each.id),
  ).id;
  const items = [...document.items];
  items.splice(index + 1, 0, { ...item, id });
  return { ...document, items };
}

export function moveItem(document: FormDocument, index: number, by: -1 | 1): FormDocument {
  const target = index + by;
  if (target < 0 || target >= document.items.length) return document;
  const items = [...document.items];
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item!);
  return { ...document, items };
}

function uniqueOption(options: ReadonlyArray<string>): string {
  for (let n = options.length + 1; ; n += 1) {
    const candidate = `Option ${n}`;
    if (!options.includes(candidate)) return candidate;
  }
}

function OptionsEditor(props: {
  readonly item: FormItem;
  readonly onChange: (item: FormItem) => void;
}): ReactNode {
  const tx = useTx();
  const { item } = props;
  const options = item.options ?? [];
  const duplicates = new Set(options.filter((option, index) => options.indexOf(option) !== index));
  const mark = item.type === "checkboxes" ? "☐" : item.type === "choice" ? "○" : "";
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <span aria-hidden className="w-4 text-center text-muted-foreground text-sm">
            {mark || `${index + 1}.`}
          </span>
          <Input
            size="sm"
            value={option}
            maxLength={FORM_LIMITS.optionChars}
            aria-label={tx("Option {n}", { n: index + 1 })}
            aria-invalid={option.trim().length === 0 || duplicates.has(option) || undefined}
            onChange={(event) => {
              const next = [...options];
              next[index] = event.currentTarget.value;
              props.onChange({ ...item, options: next });
            }}
          />
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={tx("Remove option {n}", { n: index + 1 })}
            disabled={options.length <= 1}
            onClick={() =>
              props.onChange({ ...item, options: options.filter((_, at) => at !== index) })
            }
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      {item.other === true ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <span aria-hidden className="w-4 text-center">
            {mark}
          </span>
          <span className="flex-1">{tx("Other…")}</span>
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={tx("Remove Other")}
            onClick={() => {
              const { other: _other, ...rest } = item;
              props.onChange(rest as FormItem);
            }}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ) : null}
      <div className="flex gap-2 ps-6">
        <Button
          size="xs"
          variant="ghost"
          disabled={options.length >= FORM_LIMITS.options}
          onClick={() => props.onChange({ ...item, options: [...options, uniqueOption(options)] })}
        >
          <PlusIcon aria-hidden />
          {tx("Add option")}
        </Button>
        {(item.type === "choice" || item.type === "checkboxes") && item.other !== true ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => props.onChange({ ...item, other: true })}
          >
            {tx("Add “Other”")}
          </Button>
        ) : null}
      </div>
      {duplicates.size > 0 ? (
        <p className="text-destructive-foreground text-xs" role="alert">
          {tx("Each option can be listed only once.")}
        </p>
      ) : null}
    </div>
  );
}

function ScaleEditor(props: {
  readonly item: FormItem;
  readonly onChange: (item: FormItem) => void;
}): ReactNode {
  const tx = useTx();
  const scale = props.item.scale ?? { min: 1 as const, max: 5 };
  const set = (patch: { readonly [K in keyof FormScale]?: FormScale[K] | undefined }) => {
    // An emptied label leaves the file, rather than staying as "".
    const merged: Record<string, unknown> = { ...scale, ...patch };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    props.onChange({ ...props.item, scale: merged as unknown as FormScale });
  };
  const highs = Array.from(
    { length: FORM_SCALE.highMax - FORM_SCALE.highMin + 1 },
    (_, index) => index + FORM_SCALE.highMin,
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <select
          className={nativeSelectClass}
          aria-label={tx("Scale starts at")}
          value={scale.min}
          onChange={(event) => set({ min: Number(event.currentTarget.value) as 0 | 1 })}
        >
          {FORM_SCALE.lows.map((low) => (
            <option key={low} value={low}>
              {low}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">{tx("to")}</span>
        <select
          className={nativeSelectClass}
          aria-label={tx("Scale ends at")}
          value={scale.max}
          onChange={(event) => set({ max: Number(event.currentTarget.value) })}
        >
          {highs.map((high) => (
            <option key={high} value={high}>
              {high}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input
          size="sm"
          placeholder={tx("Label for {n} (optional)", { n: scale.min })}
          aria-label={tx("Label for the low end")}
          maxLength={FORM_LIMITS.optionChars}
          value={scale.minLabel ?? ""}
          onChange={(event) => set({ minLabel: event.currentTarget.value || undefined })}
        />
        <Input
          size="sm"
          placeholder={tx("Label for {n} (optional)", { n: scale.max })}
          aria-label={tx("Label for the high end")}
          maxLength={FORM_LIMITS.optionChars}
          value={scale.maxLabel ?? ""}
          onChange={(event) => set({ maxLabel: event.currentTarget.value || undefined })}
        />
      </div>
    </div>
  );
}

function ItemCard(props: {
  readonly item: FormItem;
  readonly index: number;
  readonly count: number;
  readonly onChange: (item: FormItem) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const tx = useTx();
  const { item } = props;
  const question = isFormQuestion(item);
  const layout = item.type === "section";
  return (
    <li
      className={
        layout
          ? "flex flex-col gap-3 rounded-xl border border-primary/40 border-t-4 bg-card p-4"
          : "flex flex-col gap-3 rounded-xl border bg-card p-4"
      }
      aria-label={tx("Item {n}: {title}", {
        n: props.index + 1,
        title: item.title || tx("Untitled"),
      })}
    >
      {layout ? (
        <p className="text-muted-foreground text-xs">
          {tx("Section: answers continue on a new page")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-start gap-2">
        <Input
          className="min-w-48 flex-1"
          value={item.title}
          maxLength={FORM_LIMITS.titleChars}
          aria-label={question ? tx("Question") : tx("Title")}
          placeholder={question ? tx("Question") : tx("Title")}
          onChange={(event) => props.onChange({ ...item, title: event.currentTarget.value })}
        />
        <select
          className={nativeSelectClass}
          aria-label={tx("Item type")}
          value={item.type}
          onChange={(event) =>
            props.onChange(changeItemType(item, event.currentTarget.value as FormItemType))
          }
        >
          {TYPE_ORDER.map((type) => (
            <option key={type} value={type}>
              {tx(FORM_ITEM_TYPE_LABELS[type])}
            </option>
          ))}
        </select>
      </div>
      <Textarea
        size="sm"
        rows={1}
        value={item.description ?? ""}
        maxLength={FORM_LIMITS.descriptionChars}
        aria-label={tx("Description")}
        placeholder={tx("Description (optional)")}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value.length > 0) props.onChange({ ...item, description: value });
          else {
            const { description: _description, ...rest } = item;
            props.onChange(rest as FormItem);
          }
        }}
      />
      {hasOptions(item.type) ? <OptionsEditor item={item} onChange={props.onChange} /> : null}
      {item.type === "scale" ? <ScaleEditor item={item} onChange={props.onChange} /> : null}
      {item.type === "short" ||
      item.type === "paragraph" ||
      item.type === "date" ||
      item.type === "time" ? (
        <p className="border-b border-dashed pb-1 text-muted-foreground text-sm">
          {item.type === "short"
            ? tx("Short answer text")
            : item.type === "paragraph"
              ? tx("Long answer text")
              : item.type === "date"
                ? tx("Day, month, year")
                : tx("Time")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-1 border-t pt-2">
        {question ? (
          <label className="me-auto flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={item.required === true}
              onChange={(event) => {
                if (event.currentTarget.checked) props.onChange({ ...item, required: true });
                else {
                  const { required: _required, ...rest } = item;
                  props.onChange(rest as FormItem);
                }
              }}
            />
            {tx("Required")}
          </label>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={tx("Move up")}
          disabled={props.index === 0}
          onClick={() => props.onMove(-1)}
        >
          <ArrowUpIcon aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={tx("Move down")}
          disabled={props.index === props.count - 1}
          onClick={() => props.onMove(1)}
        >
          <ArrowDownIcon aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={tx("Duplicate")}
          onClick={props.onDuplicate}
        >
          <CopyIcon aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-destructive"
          aria-label={tx("Delete")}
          onClick={props.onDelete}
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
    </li>
  );
}

export function FormEditor(props: {
  readonly document: FormDocument;
  readonly onChange: (document: FormDocument) => void;
}): ReactNode {
  const tx = useTx();
  const { document, onChange } = props;
  const full = document.items.length >= FORM_LIMITS.items;
  const add = (type: FormItemType) =>
    onChange({
      ...document,
      items: [
        ...document.items,
        newFormItem(
          type,
          document.items.map((item) => item.id),
        ),
      ],
    });
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
      <div className="flex flex-col gap-2 rounded-xl border border-primary border-t-8 bg-card p-4">
        <Input
          size="lg"
          value={document.title}
          maxLength={FORM_LIMITS.titleChars}
          aria-label={tx("Form title")}
          placeholder={tx("Form title")}
          onChange={(event) => onChange({ ...document, title: event.currentTarget.value })}
        />
        <Textarea
          size="sm"
          rows={2}
          value={document.description ?? ""}
          maxLength={FORM_LIMITS.descriptionChars}
          aria-label={tx("Form description")}
          placeholder={tx("Form description")}
          onChange={(event) => onChange({ ...document, description: event.currentTarget.value })}
        />
      </div>
      <ol className="flex flex-col gap-3">
        {document.items.map((item, index) => (
          <ItemCard
            key={item.id}
            item={item}
            index={index}
            count={document.items.length}
            onChange={(next) =>
              onChange({
                ...document,
                items: document.items.map((each, at) => (at === index ? next : each)),
              })
            }
            onMove={(by) => onChange(moveItem(document, index, by))}
            onDuplicate={() => onChange(duplicateItem(document, index))}
            onDelete={() =>
              onChange({ ...document, items: document.items.filter((_, at) => at !== index) })
            }
          />
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={full} onClick={() => add("short")}>
          <PlusIcon aria-hidden />
          {tx("Add question")}
        </Button>
        <Button variant="outline" size="sm" disabled={full} onClick={() => add("text")}>
          {tx("Add title and text")}
        </Button>
        <Button variant="outline" size="sm" disabled={full} onClick={() => add("section")}>
          {tx("Add section")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {tx(
          "Answers go to the responses Sheet, one column per question by its title. Renaming a question that already has answers starts a new column.",
        )}
      </p>
    </div>
  );
}

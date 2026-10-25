import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleMinusIcon,
  CircleXIcon,
  InfoIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  formatSeconds,
  humanizeKey,
  isPlainObject,
  isScalar,
  isSecondsKey,
  isoDateTime,
  parseJsonData,
  parseKeyValueBlock,
  parseStatusBlock,
  pathBreakSegments,
  tableColumns,
  type JsonData,
  type KeyValueGroup,
  type StatusBlock,
  type StatusState,
} from "./structuredBlocks.logic";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const datedYearFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** A time from another year says which year. */
function formatDateTime(date: Date): string {
  return date.getFullYear() === new Date().getFullYear()
    ? dateTimeFormatter.format(date)
    : datedYearFormatter.format(date);
}

/** Nested objects deeper than this show as compact JSON instead of more indentation. */
const MAX_DEPTH = 3;
const MAX_TABLE_ROWS = 200;

/**
 * A field grid: keys take their own width between 7rem and 16rem and wrap at their spaces
 * and separators, inside a word only when nothing else fits. On a card under 22rem wide
 * each key sits above its value; the card around a grid is the `kv` container.
 */
const FIELD_GRID_CLASS_NAME =
  "grid grid-cols-[minmax(7rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm @max-[22rem]/kv:grid-cols-1 @max-[22rem]/kv:gap-y-0";
const FIELD_KEY_CLASS_NAME =
  "max-w-[16rem] break-words [word-break:normal] text-muted-foreground hyphens-none";
/** A stacked key after the first leaves room above it, so each pair reads as one. */
const FIELD_KEY_AFTER_FIRST_CLASS_NAME = "@max-[22rem]/kv:mt-1.5";
/**
 * A card that holds field grids. An inline-size container is sized as if empty inside a
 * bubble or popover that fits its content, so it claims 32rem there instead of nothing.
 */
const FIELD_CARD_CLASS_NAME = "@container/kv [contain-intrinsic-inline-size:32rem]";

/**
 * Text that may wrap after path and ID separators, as `<wbr>`: copying, `textContent` and
 * screen readers see the original text, with no zero-width characters added. A segment
 * wider than its column still breaks where it must.
 */
function BreakableText({ text }: { text: string }) {
  const segments = pathBreakSegments(text);
  if (segments.length === 1) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {segment}
        </Fragment>
      ))}
    </>
  );
}

function ScalarValue({ value, name }: { value: unknown; name?: string | undefined }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? (
      <span className="text-success-foreground">Yes</span>
    ) : (
      <span className="text-muted-foreground">No</span>
    );
  }
  if (typeof value === "number") {
    if (name !== undefined && isSecondsKey(name) && value >= 60) {
      return <span className="tabular-nums">{formatSeconds(value)}</span>;
    }
    // Exact digits: IDs, ports and years must not gain separators or lose decimals.
    return <span className="tabular-nums">{String(value)}</span>;
  }
  const date = isoDateTime(value);
  if (date !== null) {
    return <time dateTime={String(value)}>{formatDateTime(date)}</time>;
  }
  const text = String(value);
  return text.length === 0 ? (
    <span className="text-muted-foreground">empty</span>
  ) : (
    <span className="break-words whitespace-pre-wrap" data-path-wrap="">
      <BreakableText text={text} />
    </span>
  );
}

function CompactValue({ value, name }: { value: unknown; name?: string | undefined }) {
  if (isScalar(value)) return <ScalarValue value={value} name={name} />;
  if (Array.isArray(value) && value.every(isScalar)) {
    if (value.length === 0) return <span className="text-muted-foreground">none</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((entry, index) => (
          <span key={index} className="rounded bg-secondary px-1.5 py-px text-xs">
            <ScalarValue value={entry} />
          </span>
        ))}
      </span>
    );
  }
  return <code className="font-mono text-xs break-all">{JSON.stringify(value)}</code>;
}

function DataTable({
  rows,
  columns,
}: {
  rows: ReadonlyArray<unknown>;
  columns: ReadonlyArray<string>;
}) {
  const shown = rows.slice(0, MAX_TABLE_ROWS) as ReadonlyArray<Record<string, unknown>>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-structured-table="">
        <thead>
          <tr className="border-b border-border/60 text-left text-muted-foreground">
            {columns.map((column) => (
              <th key={column} scope="col" className="px-2 py-1.5 font-medium whitespace-nowrap">
                {humanizeKey(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, index) => (
            <tr key={index} className="border-b border-border/40 last:border-b-0">
              {columns.map((column) => (
                <td key={column} className="px-2 py-1.5 align-top">
                  <CompactValue value={row[column]} name={column} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length ? (
        <p className="px-2 pt-1 text-2xs text-muted-foreground">
          {rows.length - shown.length} more rows in the raw view
        </p>
      ) : null}
    </div>
  );
}

function ObjectGrid({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value);
  return (
    <dl className={FIELD_GRID_CLASS_NAME}>
      {entries.map(([key, entry], entryIndex) => {
        const nested = isPlainObject(entry) && depth < MAX_DEPTH && Object.keys(entry).length > 0;
        const columns = Array.isArray(entry) && depth < MAX_DEPTH ? tableColumns(entry) : null;
        if (nested || columns !== null) {
          return (
            <div key={key} className="col-span-full mt-1.5 first:mt-0" data-structured-group={key}>
              <dt className="mb-1 text-xs font-medium text-muted-foreground">{humanizeKey(key)}</dt>
              <dd className="border-s border-border/70 ps-3">
                {columns !== null ? (
                  <DataTable rows={entry as ReadonlyArray<unknown>} columns={columns} />
                ) : (
                  <ObjectGrid value={entry as Record<string, unknown>} depth={depth + 1} />
                )}
              </dd>
            </div>
          );
        }
        return (
          <div key={key} className="contents">
            <dt
              className={cn(
                FIELD_KEY_CLASS_NAME,
                entryIndex > 0 && FIELD_KEY_AFTER_FIRST_CLASS_NAME,
              )}
            >
              {humanizeKey(key)}
            </dt>
            <dd className="min-w-0">
              <CompactValue value={entry} name={key} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** JSON data as a grid of fields, or a table for a list of records. */
export function JsonDataView({ data }: { data: JsonData }) {
  if (Array.isArray(data)) {
    const columns = tableColumns(data);
    if (columns !== null) return <DataTable rows={data} columns={columns} />;
    if (data.every(isScalar)) return <CompactValue value={data} />;
    return (
      <div className={cn(FIELD_CARD_CLASS_NAME, "flex flex-col gap-2")}>
        {data.slice(0, MAX_TABLE_ROWS).map((entry, index) => (
          <div key={index} className="border-s border-border/70 ps-3">
            {isPlainObject(entry) ? (
              <ObjectGrid value={entry} depth={1} />
            ) : (
              <CompactValue value={entry} />
            )}
          </div>
        ))}
        {data.length > MAX_TABLE_ROWS ? (
          <p className="text-2xs text-muted-foreground">
            {data.length - MAX_TABLE_ROWS} more entries in the raw view
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className={FIELD_CARD_CLASS_NAME}>
      <ObjectGrid value={data as Record<string, unknown>} depth={0} />
    </div>
  );
}

const STATUS_PRESENTATION: Record<StatusState, { icon: ReactNode; label: string }> = {
  ok: { icon: <CircleCheckIcon className="size-4 text-success-foreground" />, label: "Done" },
  warn: { icon: <CircleAlertIcon className="size-4 text-warning-foreground" />, label: "Warning" },
  fail: { icon: <CircleXIcon className="size-4 text-destructive-foreground" />, label: "Failed" },
  info: { icon: <InfoIcon className="size-4 text-info-foreground" />, label: "Info" },
  running: {
    icon: <CircleDashedIcon className="size-4 text-muted-foreground" />,
    label: "In progress",
  },
  skip: { icon: <CircleMinusIcon className="size-4 text-muted-foreground" />, label: "Skipped" },
};

export function StatusBlockCard({ block }: { block: StatusBlock }) {
  return (
    <div
      className="rounded-lg border border-border/70 bg-card/40 px-3 py-2"
      data-structured-status=""
    >
      {block.title ? (
        <p className="mb-1.5 text-sm font-medium text-foreground">{block.title}</p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {block.items.map((item, index) => {
          const presentation = STATUS_PRESENTATION[item.state];
          return (
            <li
              key={index}
              className="flex items-start gap-2 text-sm"
              data-status-state={item.state}
            >
              <span className="mt-0.5 shrink-0" role="img" aria-label={presentation.label}>
                {presentation.icon}
              </span>
              <span className="min-w-0">
                <span className={cn(item.state === "skip" && "text-muted-foreground")}>
                  {item.label}
                </span>
                {item.detail ? (
                  <span className="text-muted-foreground"> · {item.detail}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function KeyValueBlockCard({ groups }: { groups: ReadonlyArray<KeyValueGroup> }) {
  return (
    <div
      className={cn(
        FIELD_CARD_CLASS_NAME,
        "flex flex-col gap-2.5 rounded-lg border border-border/70 bg-card/40 px-3 py-2",
      )}
      data-structured-kv=""
    >
      {groups.map((group, index) => (
        <div key={index}>
          {group.heading ? (
            <p className="mb-1 text-xs font-medium text-muted-foreground">{group.heading}</p>
          ) : null}
          <dl className={FIELD_GRID_CLASS_NAME}>
            {group.entries.map((entry, entryIndex) => (
              <div key={entryIndex} className="contents">
                <dt
                  className={cn(
                    FIELD_KEY_CLASS_NAME,
                    entryIndex > 0 && FIELD_KEY_AFTER_FIRST_CLASS_NAME,
                  )}
                >
                  <BreakableText text={entry.key} />
                </dt>
                <dd className="min-w-0 break-words" data-path-wrap="">
                  {entry.value ? (
                    <BreakableText text={entry.value} />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

/**
 * The structured view of a fence, or null when its text is not one this language
 * understands, so the caller keeps the code view.
 */
export function structuredFenceView(language: string, code: string): ReactNode | null {
  if (language === "status") {
    const block = parseStatusBlock(code);
    return block === null ? null : <StatusBlockCard block={block} />;
  }
  if (language === "kv") {
    const groups = parseKeyValueBlock(code);
    return groups === null ? null : <KeyValueBlockCard groups={groups} />;
  }
  const data = parseJsonData(code);
  return data === null ? null : (
    <div
      className="rounded-lg border border-border/70 bg-card/40 px-3 py-2"
      data-structured-json=""
    >
      <JsonDataView data={data} />
    </div>
  );
}

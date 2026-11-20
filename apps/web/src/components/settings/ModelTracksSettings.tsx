import { projectThreadModel } from "@specweave-studio/shared/projectSettings";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  MAX_LANE_MODELS,
  MODEL_TRACK_LABELS,
  type ModelLanes,
  type ModelSelection,
  type ModelTrack,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  describeReviewRule,
  REVIEWER_SKIP_NOTES,
  type ReviewRuleLine,
  usageNeverRead,
} from "@specweave-studio/shared/adversarialReview";
import { MODEL_FAMILY_LABELS, type ModelFamily } from "@specweave-studio/shared/fallbackOptions";
import { createModelSelection } from "@specweave-studio/shared/model";
import {
  findEffortDescriptor,
  modelSelectionEffortValue,
  withEffortSelection,
} from "@specweave-studio/shared/effortLevel";
import { describeModel } from "@specweave-studio/shared/modelIdentity";
import {
  addTrackEntry,
  describeSources,
  describeTrack,
  moveSource,
  moveTrackEntry,
  singleReviewFamily,
  type SourceMoveRefusal,
  type SourceRow,
  type SourceStatus,
  type TrackEntryRefusal,
  trackEntryRefusal,
  type TrackRow,
  type TrackSource,
} from "@specweave-studio/shared/modelTrackRules";
import { TRACK_LANES } from "@specweave-studio/shared/modelTracks";
import { modelFamily } from "@specweave-studio/shared/modelVendor";
import type { UsageUnknownReason } from "@specweave-studio/shared/providerFallback";
import { GripVerticalIcon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useTx } from "../../i18n";
import { cn } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { savedModelTracks } from "../../onboarding/firstRunModels.logic";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { clock } from "./FallbackOrderList";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  PolicyTooltip,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ADVERSARIAL_REVIEW_TIME_NOTE, SLOWER_WORK_NOTE_LABEL } from "./slowerWorkNotes";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

type Tx = ReturnType<typeof useTx>;

const TRACK_HINTS: Record<ModelTrack, string> = {
  daily: "Routine work, and where a limited thread continues",
  complex: "Hard, open-ended work. Never drops to a free model.",
  review: "A different model family checks finished work",
};

export const TRACK_ENTRY_REFUSALS: Record<TrackEntryRefusal, string> = {
  duplicate: "That model is already in this list.",
  full: "This list is full. Remove a model first.",
  "free-in-hard-track": "Free models only close Daily. Hard work and reviews wait for a reset.",
  "free-not-last":
    "A free model stays last on Daily, so it is only used when nothing else has room.",
  "per-token":
    "That source is billed per use, so a track never starts work on it. Pick it for one thread instead.",
  "unknown-billing":
    "That source does not say how it bills, so a track never starts work on it. Pick it for one thread instead.",
};

/** What a source billed per use, or with unknown billing, does for a row. */
function holdNote(source: TrackSource, track: ModelTrack, tx: Tx): string | null {
  if (source.hold === null) return null;
  const billing = source.hold === "per-token" ? tx("Billed per use") : tx("Billing unknown");
  if (source.used) return billing;
  return track === "review"
    ? `${billing}, ${tx("never reviews")}`
    : `${billing}, ${tx("never automatic")}`;
}

const SOURCE_REFUSALS: Record<SourceMoveRefusal, string> = {
  "held-source": "Billed per use or with unknown billing, so it is never picked on its own.",
  "into-held": "Sources picked automatically stay above the ones that are not.",
};

function statusChip(
  status: SourceStatus,
  tx: Tx,
): { readonly label: string; readonly variant: "success" | "warning" | "outline" } {
  switch (status.state) {
    case "ready":
      return { label: tx("Ready"), variant: "success" };
    case "limited":
      return {
        label:
          status.until === null
            ? tx("Limit reached")
            : `${tx("Limit until")} ${clock(status.until)}`,
        variant: "warning",
      };
    case "sign-in":
      return { label: tx("Sign in"), variant: "warning" };
    case "not-installed":
      return { label: tx("Not installed"), variant: "outline" };
    case "not-ready":
      return { label: tx("Not ready"), variant: "outline" };
  }
}

/** What the top entry of each track is for; the entries under it are its fallbacks. */
const TRACK_FIRST: Record<ModelTrack, string> = {
  daily: "New threads start here",
  complex: "Hard work starts here",
  review: "Reviews first",
};

/**
 * The reasoning effort one track entry starts at, from the levels its source
 * offers. Hidden for a model with no effort setting. Unset shows the model's
 * own default; a pick is saved on the entry and every launch from it.
 */
function EffortSelect(props: {
  readonly selection: ModelSelection;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const descriptor = findEffortDescriptor(
    props.providers
      .find((provider) => provider.instanceId === props.selection.instanceId)
      ?.models.find((model) => model.slug === props.selection.model)?.capabilities
      ?.optionDescriptors,
  );
  if (descriptor === undefined) return null;
  const value =
    modelSelectionEffortValue(props.selection) ??
    descriptor.options.find((choice) => choice.isDefault)?.id ??
    null;
  return (
    <Select
      value={value}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === value) return;
        props.onChange({
          ...props.selection,
          options: withEffortSelection(props.selection.options, {
            optionId: descriptor.id,
            value: next,
          }),
        });
      }}
    >
      <SelectTrigger size="xs" className="w-auto min-w-0" aria-label={props.label}>
        <SelectValue>
          {descriptor.options.find((choice) => choice.id === value)?.label ?? value ?? ""}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {descriptor.options.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Why a Review source's usage is unknown, as a clause. */
function usageReasonText(reason: UsageUnknownReason, nowMs: number, tx: Tx): string {
  switch (reason.kind) {
    case "cannot-report":
      return tx("this sign-in does not report usage (an API key or a cloud account)");
    case "check-failed":
      return reason.message === null
        ? tx("the last usage check failed")
        : `${tx("the last usage check failed")}: ${reason.message}`;
    case "stale":
      return reason.readAt === null
        ? tx("no usage reading yet")
        : `${tx("last usage reading")} ${Math.max(1, Math.round((nowMs - reason.readAt) / 60_000))} ${tx("min ago; a review needs one from the last 5 minutes")}`;
    case "no-model-window":
      return tx("the last check returned no usage window for this model");
    case "refused":
      return tx("a turn was refused after the last usage reading");
    case "reset-passed":
      return tx("a limit reset passed since the last usage reading");
    case "sign-in-unconfirmed":
      return tx("the sign-in is not confirmed yet");
  }
}

/** "Claude Opus 5.5 or Claude Fable 5.2"; "A, B or C". */
function orList(names: ReadonlyArray<string>, tx: Tx): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${tx("or")} ${names[names.length - 1]}`;
}

/** A grip, a position and the row's content; the grip also reorders by keyboard. */
function SortableRow(props: {
  readonly id: string;
  readonly position: number;
  readonly label: string;
  readonly locked?: boolean;
  readonly children: ReactNode;
}) {
  const tx = useTx();
  const sortable = useSortable({ id: props.id, disabled: props.locked === true });
  return (
    <li
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "flex items-center gap-2 border-b border-border/70 px-3 py-2 last:border-b-0",
        sortable.isDragging && "relative z-10 rounded-md bg-background shadow-md",
      )}
    >
      <button
        type="button"
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        {...sortable.listeners}
        disabled={props.locked === true}
        aria-label={`${tx("Reorder")} ${props.label}, ${tx("position")} ${props.position}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-40"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">
        {props.position}
      </span>
      {props.children}
    </li>
  );
}

function SortableList(props: {
  readonly label: string;
  readonly ids: ReadonlyArray<string>;
  readonly onMove: (from: number, to: number) => void;
  readonly children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (event: DragEndEvent) => {
    const from = props.ids.indexOf(String(event.active.id));
    const to = event.over === null ? -1 : props.ids.indexOf(String(event.over.id));
    if (from !== -1 && to !== -1 && from !== to) props.onMove(from, to);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={[...props.ids]} strategy={verticalListSortingStrategy}>
        <ol aria-label={props.label} className="flex flex-col">
          {props.children}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function Card(props: {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly control?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={props.id}
      aria-label={props.title}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2.5">
        <h3 className="text-sm font-semibold">{props.title}</h3>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{props.hint}</p>
        {props.control}
      </header>
      {props.children}
    </section>
  );
}

const Note = (props: { readonly tone?: "warning"; readonly children: ReactNode }) => (
  <p
    role={props.tone === "warning" ? "alert" : undefined}
    className={cn(
      "border-t border-border/70 px-3 py-2 text-xs",
      props.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
    )}
  >
    {props.children}
  </p>
);

function TrackCard(props: {
  readonly track: ModelTrack;
  readonly saved: ReadonlyArray<ModelSelection>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sourceOrder: ReadonlyArray<ProviderInstanceId>;
  readonly sourceName: (provider: ServerProvider) => string;
  readonly nowMs: number;
  readonly mixed: boolean;
  readonly picker: (onPick: (selection: ModelSelection) => void, disabled: boolean) => ReactNode;
  readonly control?: ReactNode;
  /** A line under the list, such as when the track applies. */
  readonly note?: ReactNode;
  /** Review: the families whose work this list reviews here; their own rows are skipped. */
  readonly authorFamilies?: ReadonlySet<ModelFamily>;
  /** Review: who reviews each author family's work now. */
  readonly rule?: ReactNode;
  /** Review: read a source's usage again. */
  readonly onCheckUsage?: (provider: ServerProvider) => void;
  readonly onSave: (models: ReadonlyArray<ModelSelection>) => void;
}) {
  const tx = useTx();
  const { track, saved, providers } = props;
  const [refusal, setRefusal] = useState<TrackEntryRefusal | null>(null);
  const rows = describeTrack({
    track,
    saved,
    providers,
    sourceOrder: props.sourceOrder,
    nowMs: props.nowMs,
  });
  const title = MODEL_TRACK_LABELS[track];
  // Reordering or removing a built-in row saves the list as the person's own.
  const current = rows.flatMap((row) => (row.selection === null ? [] : [row.selection]));
  const key = (row: TrackRow) => `${row.selection?.instanceId ?? "none"}:${row.model}`;
  const movable = rows.filter((row) => row.selection !== null);
  const sameFamily = track === "review" ? singleReviewFamily(rows) : null;

  const add = (selection: ModelSelection) => {
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    const reason = trackEntryRefusal({
      track,
      model: describeModel(provider, selection.model),
      existing: current,
      providers,
      instanceId: selection.instanceId,
    });
    setRefusal(reason);
    if (reason === null)
      props.onSave(addTrackEntry({ track, entries: current, providers, entry: selection }));
  };
  const move = (from: number, to: number) => {
    const result = moveTrackEntry({ track, entries: current, providers, from, to });
    if ("refused" in result) return setRefusal(result.refused);
    setRefusal(null);
    props.onSave(result.entries);
  };
  const unlisted = rows.filter((row) => row.selection === null);

  return (
    <Card
      id={`model-track-${track}`}
      title={tx(title)}
      hint={tx(TRACK_HINTS[track])}
      control={props.control}
    >
      <SortableList label={`${title} ${tx("order")}`} ids={movable.map(key)} onMove={move}>
        {rows.map((row, index) => (
          <SortableRow
            key={key(row)}
            id={key(row)}
            position={index + 1}
            label={row.name}
            locked={row.selection === null}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-sm font-medium">{row.name}</span>
                {row.selection !== null &&
                rows.findIndex((entry) => entry.selection !== null) === index &&
                // A Review row skipped for the work done here does not review it first.
                !(
                  track === "review" &&
                  props.authorFamilies?.has(modelFamily({ slug: row.model, name: row.name }))
                ) ? (
                  <Badge variant="outline" size="sm">
                    {tx(TRACK_FIRST[track])}
                  </Badge>
                ) : null}
                {track === "review" ? (
                  <ReviewFamilyBadges
                    family={modelFamily({ slug: row.model, name: row.name })}
                    authorFamilies={props.authorFamilies}
                  />
                ) : null}
                {row.free ? (
                  <Badge variant="info" size="sm">
                    {tx("Free, used last")}
                  </Badge>
                ) : null}
                {row.misplaced ? (
                  <Badge variant="warning" size="sm">
                    {tx("Free model: remove it, hard work waits for a reset")}
                  </Badge>
                ) : null}
                {row.follows !== null ? (
                  <Badge variant="outline" size="sm">
                    {tx("Follows newest")}
                  </Badge>
                ) : null}
              </div>
              <ul
                aria-label={`${tx("Sources for")} ${row.name}`}
                className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
              >
                {row.sources.length === 0 ? (
                  <li>
                    <Badge variant="outline" size="sm">
                      {tx("Not installed")}
                    </Badge>{" "}
                    {tx("No source on this machine lists it.")}
                  </li>
                ) : (
                  row.sources.map((source, at) => {
                    const chip = statusChip(source.status, tx);
                    const hold = holdNote(source, track, tx);
                    return (
                      <li key={source.provider.instanceId} className="flex items-center gap-1">
                        {at > 0 && source.used ? <span aria-hidden>{tx("then")}</span> : null}
                        <span className="text-foreground">{props.sourceName(source.provider)}</span>
                        {source.used ? (
                          source.usage !== null && source.status.state === "ready" ? (
                            <Badge variant="info" size="sm">
                              {tx("Usage unknown")}
                            </Badge>
                          ) : (
                            <Badge variant={chip.variant} size="sm">
                              {chip.label}
                            </Badge>
                          )
                        ) : null}
                        {hold !== null ? (
                          <Badge variant="warning" size="sm">
                            {hold}
                          </Badge>
                        ) : null}
                      </li>
                    );
                  })
                )}
              </ul>
              <UsageUnknownNote
                sources={row.sources}
                nowMs={props.nowMs}
                sourceName={props.sourceName}
                onCheckUsage={props.onCheckUsage}
              />
            </div>
            {row.selection !== null ? (
              <EffortSelect
                selection={row.selection}
                providers={providers}
                label={`${tx("Effort for")} ${row.name}`}
                disabled={props.mixed}
                onChange={(selection) =>
                  props.onSave(
                    current.map((entry, at) => (at === movable.indexOf(row) ? selection : entry)),
                  )
                }
              />
            ) : null}
            {row.selection !== null ? (
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`${tx("Remove")} ${row.name}`}
                onClick={() => props.onSave(current.filter((_, at) => at !== movable.indexOf(row)))}
              >
                <XIcon className="size-3" />
              </Button>
            ) : null}
          </SortableRow>
        ))}
      </SortableList>
      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2">
        {props.picker(add, props.mixed || current.length >= MAX_LANE_MODELS)}
        {saved.length > 0 ? (
          <Button type="button" size="xs" variant="outline" onClick={() => props.onSave([])}>
            {tx("Use the built-in order")}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {tx("Built-in order. Drag to make it yours.")}
          </span>
        )}
      </div>
      {refusal !== null ? <Note tone="warning">{tx(TRACK_ENTRY_REFUSALS[refusal])}</Note> : null}
      {saved.length === 0 && unlisted.length > 0 ? (
        <Note>
          {`${tx("Changing this list saves it as yours without")} ${unlisted
            .map((row) => row.name)
            .join(", ")}${tx(
            ': nothing here runs it yet. "Use the built-in order" brings it back.',
          )}`}
        </Note>
      ) : null}
      {props.rule ?? null}
      {props.note ?? null}
      {sameFamily !== null ? (
        <Note tone="warning">
          {tx(
            "Every reviewer here is from one model family, so work by that family gets no review.",
          )}
        </Note>
      ) : null}
    </Card>
  );
}

/** A Review row's family, and that it is skipped for its own family's work. */
function ReviewFamilyBadges(props: {
  readonly family: ModelFamily;
  readonly authorFamilies: ReadonlySet<ModelFamily> | undefined;
}) {
  const tx = useTx();
  const label = MODEL_FAMILY_LABELS[props.family];
  return (
    <>
      <Badge variant="outline" size="sm">
        {props.family === "other" ? tx("Other family") : `${label} ${tx("family")}`}
      </Badge>
      {props.family !== "other" && props.authorFamilies?.has(props.family) ? (
        <Badge variant="warning" size="sm">
          {`${tx("Skipped for")} ${label} ${tx("work")}`}
        </Badge>
      ) : null}
    </>
  );
}

/** Why each used source of a Review row has no usage reading, and how to get one. */
function UsageUnknownNote(props: {
  readonly sources: ReadonlyArray<TrackSource>;
  readonly nowMs: number;
  readonly sourceName: (provider: ServerProvider) => string;
  readonly onCheckUsage: ((provider: ServerProvider) => void) | undefined;
}) {
  const tx = useTx();
  return props.sources.map((source) => {
    if (!source.used || source.usage === null || source.status.state !== "ready") return null;
    const canCheck = source.usage.kind !== "cannot-report" && props.onCheckUsage !== undefined;
    const effect = usageNeverRead(source.provider)
      ? tx("A review still uses it in this place.")
      : tx("A review tries a ready model below first.");
    return (
      <p key={source.provider.instanceId} className="mt-1 text-xs text-muted-foreground" data-usage-unknown={source.usage.kind}>
        {`${tx("Usage unknown on")} ${props.sourceName(source.provider)}: ${usageReasonText(source.usage, props.nowMs, tx)}. ${effect}`}
        {canCheck ? (
          <>
            {" "}
            <button
              type="button"
              className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
              onClick={() => props.onCheckUsage?.(source.provider)}
            >
              {tx("Check now")}
            </button>
          </>
        ) : null}
      </p>
    );
  });
}

/** "Who reviews now": one line per family whose work this list reviews. */
function ReviewRuleNote(props: {
  readonly lines: ReadonlyArray<ReviewRuleLine>;
  readonly modelName: (selection: ModelSelection) => string;
  /** The model alone, without its source: a skipped model is skipped on every source. */
  readonly shortName: (selection: ModelSelection) => string;
}) {
  const tx = useTx();
  if (props.lines.length === 0) return null;
  return (
    <div
      className="border-t border-border/70 px-3 py-2 text-xs"
      aria-label={tx("Who reviews now")}
      data-review-rule
    >
      <p className="mb-1 font-medium text-muted-foreground">{tx("Who reviews now")}</p>
      <ul className="flex flex-col gap-0.5">
        {props.lines.map((line) => {
          const skipped = line.sameFamily.map(props.shortName);
          const unique = skipped.filter((name, at) => skipped.indexOf(name) === at);
          const blocker = line.skipped.find((skip) => skip.reason !== "same-family");
          return (
            <li key={`${line.family}:${line.authors.join(",")}`}>
              <span className="text-muted-foreground">{`${tx("Work by")} ${orList(line.authors, tx)}`}</span>
              <span aria-hidden className="px-1 text-muted-foreground">
                →
              </span>
              {line.reviewer === null ? (
                <span className="text-warning-foreground">
                  {blocker !== undefined
                    ? `${tx("no reviewer can run now")} (${props.modelName(blocker.selection)}: ${REVIEWER_SKIP_NOTES[blocker.reason]})`
                    : line.skipped.length > 0 && line.family !== "other"
                      ? `${tx("no reviewer: every model here is")} ${MODEL_FAMILY_LABELS[line.family]}`
                      : tx("no reviewer can run now")}
                </span>
              ) : (
                <span className="font-medium text-foreground">
                  {props.modelName(line.reviewer)}
                </span>
              )}
              {unique.length > 0 && line.reviewer !== null ? (
                <span className="text-muted-foreground">
                  {` · ${orList(unique, tx)} ${tx("skipped: same family")}`}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function sourceKind(row: SourceRow, tx: Tx): string {
  if (row.hold === "per-token") return tx("Billed per use, never automatic");
  if (row.hold === "unknown-billing") return tx("Billing unknown, never automatic");
  if (row.free) return tx("Free plan");
  return row.home === null ? tx("Subscription") : tx("Harness");
}

function SourcesCard(props: {
  readonly rows: ReadonlyArray<SourceRow>;
  readonly order: ReadonlyArray<ProviderInstanceId>;
  readonly saved: boolean;
  readonly sourceName: (provider: ServerProvider) => string;
  readonly onSave: (order: ReadonlyArray<ProviderInstanceId>) => void;
}) {
  const tx = useTx();
  const [refusal, setRefusal] = useState<SourceMoveRefusal | null>(null);
  const { rows } = props;
  const move = (from: number, to: number) => {
    const result = moveSource(rows, from, to, props.order);
    if ("refused" in result) return setRefusal(result.refused);
    setRefusal(null);
    props.onSave(result.order);
  };
  return (
    <Card
      id="model-sources"
      title={tx("Sources")}
      hint={tx("Where a model runs, first to last. A model's own harness comes first.")}
    >
      <SortableList
        label={tx("Sources order")}
        ids={rows.map((row) => row.provider.instanceId)}
        onMove={move}
      >
        {rows.map((row, index) => {
          const chip = statusChip(row.status, tx);
          const name = props.sourceName(row.provider);
          return (
            <SortableRow
              key={row.provider.instanceId}
              id={row.provider.instanceId}
              position={index + 1}
              label={name}
              locked={row.hold !== null}
            >
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{name}</span>
                <p className="text-xs text-muted-foreground">{sourceKind(row, tx)}</p>
              </div>
              <Badge variant={chip.variant} size="sm">
                {chip.label}
              </Badge>
            </SortableRow>
          );
        })}
      </SortableList>
      {props.saved ? (
        <div className="border-t border-border/70 px-3 py-2">
          <Button type="button" size="xs" variant="outline" onClick={() => props.onSave([])}>
            {tx("Use the built-in order")}
          </Button>
        </div>
      ) : null}
      {refusal !== null ? <Note tone="warning">{tx(SOURCE_REFUSALS[refusal])}</Note> : null}
    </Card>
  );
}

/**
 * The three model tracks and the Sources order: which model does routine
 * work, hard work and reviews, and which harness or subscription each model
 * runs on first. Lists reorder by drag and by keyboard; a move that cannot
 * work is refused with its reason. `sources={false}` leaves the Sources order
 * out, for a project dialog: that order is one list for the whole machine.
 */
export function ModelTracksSettings(
  props: {
    /** Whether the Sources order shows; a project dialog leaves it out. */
    readonly sources?: boolean;
    /** The tracks to show; Project settings shows only Review. Sources shows with all three. */
    readonly tracks?: ReadonlyArray<ModelTrack>;
    /** Whether the Review card carries the "Review finished features" switch. */
    readonly reviewSwitch?: boolean;
  } = {},
) {
  const tx = useTx();
  const tracks = props.tracks ?? (["daily", "complex", "review"] as const);
  const { scope, target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const hostConfig = environments.find(
    (environment) => environment.environmentId === target?.environmentId,
  )?.serverConfig;
  const providers = hostConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  // Limit chips follow the clock, so a reset that passes while the page is open shows.
  const nowMs = useRelativeTimeTick(60_000);
  const mixedLanes = useScopedSettingsMixed(["modelLanes"]);
  const mixedReview = useScopedSettingsMixed(["adversarialReview"]);

  const review = settings.adversarialReview;
  const sourceOrder = settings.defaultModelProviders ?? [];
  // The same lists the first-run Models block reads (`modelTrackLists` fits them).
  const saved = savedModelTracks(settings);
  const save = (track: ModelTrack, models: ReadonlyArray<ModelSelection>) =>
    track === "review"
      ? updateSettings({ adversarialReview: { reviewers: [...models] } })
      : // Only the edited lane: every machine and project keeps its own other lane.
        updateSettings({
          modelLanes: { [TRACK_LANES[track]]: [...models] } as unknown as ModelLanes,
        });

  const sourceName = (provider: ServerProvider) =>
    entries.find((entry) => entry.instanceId === provider.instanceId)?.displayName ??
    provider.displayName ??
    provider.instanceId;
  // Whose work a review reads: the first model of Daily and of Complex, the
  // ones a new thread starts on. Their families' rows are skipped for it.
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const project = projectScope
    ? scope.members.find(
        (member) => member.environmentId === target?.environmentId && member.id === target?.projectId,
      )
    : undefined;
  const projectModel =
    (project && hostConfig?.settings
      ? projectThreadModel(hostConfig.settings, project.id, project)
      : null) ?? settings.defaultModelSelection;
  const authors =
    projectScope && settings.threadModelMode !== "tracks"
      ? projectModel ? [projectModel] : []
      : (["daily", "complex"] as const).flatMap((track) => {
          const first = describeTrack({
            track,
            saved: saved[track],
            providers,
            sourceOrder,
            nowMs,
          }).find((row) => row.selection !== null)?.selection;
          return first === undefined || first === null ? [] : [first];
        });
  const ruleLines = describeReviewRule({
    providers,
    authors,
    reviewers: review.reviewers,
    tier: review.tier,
    tiers: settings.modelTiers,
    sourceOrder,
    excludedModels: settings.providerLimitExcludedModels,
    nowMs,
  });
  const authorFamilies = new Set(
    ruleLines.flatMap((line) => (line.family === "other" ? [] : [line.family])),
  );
  const shortName = (selection: ModelSelection) =>
    describeModel(
      providers.find((entry) => entry.instanceId === selection.instanceId),
      selection.model,
    ).name ?? selection.model;
  const modelName = (selection: ModelSelection) => {
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    return provider === undefined
      ? shortName(selection)
      : `${shortName(selection)} ${tx("on")} ${sourceName(provider)}`;
  };
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const checkUsage = (provider: ServerProvider) => {
    if (target?.environmentId === undefined) return;
    void refreshProviders({
      environmentId: target.environmentId,
      input: { instanceId: provider.instanceId, fresh: true },
    });
  };
  const pickerSelection = resolveDefaultProviderModelSelection(providers, saved.daily[0] ?? null);
  const picker =
    (track: ModelTrack) => (onPick: (selection: ModelSelection) => void, disabled: boolean) =>
      pickerSelection ? (
        <ProviderModelPicker
          activeInstanceId={pickerSelection.instanceId}
          model={pickerSelection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={getCustomModelOptionsByInstance(
            settings,
            providers,
            pickerSelection.instanceId,
            pickerSelection.model,
          )}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerLabel="Add model"
          triggerAriaLabel={`${tx("Add model to")} ${MODEL_TRACK_LABELS[track]}`}
          disabled={disabled}
          onInstanceModelChange={(instanceId, model) =>
            onPick(createModelSelection(instanceId, model))
          }
        />
      ) : null;

  return (
    <div className="flex flex-col gap-4">
      {tracks.map((track) => (
        <TrackCard
          key={track}
          track={track}
          saved={saved[track]}
          providers={providers}
          sourceOrder={sourceOrder}
          sourceName={sourceName}
          nowMs={nowMs}
          mixed={track === "review" ? mixedReview : mixedLanes}
          picker={picker(track)}
          onSave={(models) => save(track, models)}
          {...(track === "review"
            ? {
                authorFamilies,
                rule: (
                  <ReviewRuleNote lines={ruleLines} modelName={modelName} shortName={shortName} />
                ),
                onCheckUsage: checkUsage,
              }
            : {})}
          note={
            track === "review" && review.tier === "frontier" ? (
              <Note>
                {tx(
                  "Review depth is set to Frontier, so a review uses each source's strongest model while this list is the built-in one. A list you save here is used as it is.",
                )}
              </Note>
            ) : null
          }
          control={
            track === "review" && props.reviewSwitch !== false ? (
              // The note sits outside the label: a button inside it would take the label's click.
              <span className="flex items-center gap-1">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  {tx("Review finished features")}
                  <Switch
                    size="sm"
                    mixed={mixedReview}
                    checked={review.autoOnFeatureComplete}
                    aria-label={tx("Review finished features automatically")}
                    onCheckedChange={(checked) =>
                      updateSettings({ adversarialReview: { autoOnFeatureComplete: checked } })
                    }
                  />
                </label>
                <PolicyTooltip
                  label={tx(SLOWER_WORK_NOTE_LABEL, {
                    setting: tx("Review finished features automatically"),
                  })}
                >
                  {tx(ADVERSARIAL_REVIEW_TIME_NOTE)}
                </PolicyTooltip>
              </span>
            ) : undefined
          }
        />
      ))}
      {props.sources === false || tracks.length < 3 ? null : (
        <SourcesCard
          rows={describeSources({ providers, order: sourceOrder, nowMs })}
          order={sourceOrder}
          saved={sourceOrder.length > 0}
          sourceName={sourceName}
          onSave={(order) => updateSettings({ defaultModelProviders: [...order] })}
        />
      )}
    </div>
  );
}

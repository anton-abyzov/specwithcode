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
import { createModelSelection } from "@specweave-studio/shared/model";
import {
  effortLabel,
  isEffortId,
  findEffortDescriptor,
  resolveEffort,
  withEffortSelection,
} from "@specweave-studio/shared/effortLevel";
import { describeModel } from "@specweave-studio/shared/modelIdentity";
import {
  addTrackEntry,
  describeSources,
  describeTrack,
  moveSource,
  moveTrackEntry,
  savedBuiltInTrack,
  singleReviewFamily,
  type SourceMoveRefusal,
  type SourceRow,
  type SourceStatus,
  type TrackEntryRefusal,
  trackEntryRefusal,
  type TrackRow,
  type TrackSource,
} from "@specweave-studio/shared/modelTrackRules";
import { TRACK_LANES, trackEntryEffort } from "@specweave-studio/shared/modelTracks";
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
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
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
 * The reasoning effort one track entry runs at, from the levels its source
 * offers: the saved level, else the start level (`TrackRow.effort`, Medium
 * unless the built-in order names one), matched to the nearest level, which
 * is also what a launch from the entry uses. When the entry's own source does
 * not list the model, the levels come from the first source that does, where
 * it runs. A model no source offers effort for shows none, and a model no
 * source here lists shows its start level read-only. Never an empty picker.
 */
export function TrackEffortSelect(props: {
  readonly selection: ModelSelection | null;
  /** The row's start level (`TrackRow.effort`), shown read-only while nothing lists the model. */
  readonly effort: string | null;
  /** Where the row runs, first tried first (`TrackRow.sources`). */
  readonly sources?: ReadonlyArray<{ readonly provider: ServerProvider; readonly slug: string }>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const tx = useTx();
  const { selection } = props;
  const listedOn = (provider: ServerProvider | undefined, slug: string) =>
    provider?.models.find((model) => model.slug === slug);
  const own =
    selection === null
      ? undefined
      : listedOn(
          props.providers.find((provider) => provider.instanceId === selection.instanceId),
          selection.model,
        );
  const candidates = [
    ...(selection === null ? [] : [{ instanceId: selection.instanceId, listed: own }]),
    ...(props.sources ?? []).map((source) => ({
      instanceId: source.provider.instanceId,
      listed: listedOn(source.provider, source.slug),
    })),
  ];
  const target = candidates.find(
    (candidate) =>
      findEffortDescriptor(candidate.listed?.capabilities?.optionDescriptors) !== undefined,
  );
  const descriptor = findEffortDescriptor(target?.listed?.capabilities?.optionDescriptors);
  const effort =
    selection === null || target?.listed === undefined
      ? null
      : trackEntryEffort(
          { ...selection, instanceId: target.instanceId, model: target.listed.slug },
          [...props.providers, ...(props.sources ?? []).map((source) => source.provider)].filter(
            (provider) => provider.instanceId === target.instanceId,
          ),
          props.effort ?? undefined,
        );
  if (selection === null || descriptor === undefined || effort === null) {
    const listedSomewhere = candidates.some((candidate) => candidate.listed !== undefined);
    if (listedSomewhere || props.effort === null) return null;
    return (
      <Badge
        variant="outline"
        size="sm"
        aria-label={`${props.label}: ${effortLabel(props.effort)}, ${tx("set once a source lists it")}`}
        title={tx("Set once a source on this machine lists it")}
      >
        {effortLabel(props.effort)}
      </Badge>
    );
  }
  const value = effort.value;
  return (
    <Select
      value={value}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === value) return;
        // Saved under the option id the entry's own source reads, at its nearest
        // level; the levels shown may come from another source that lists the model.
        // A source that no longer lists the model still names its option id on its other models.
        const ownProvider = props.providers.find(
          (provider) => provider.instanceId === selection.instanceId,
        );
        const ownDescriptors =
          own?.capabilities?.optionDescriptors ??
          ownProvider?.models.find(
            (model) => findEffortDescriptor(model.capabilities?.optionDescriptors) !== undefined,
          )?.capabilities?.optionDescriptors;
        const ownLevel = resolveEffort(next, ownDescriptors);
        props.onChange({
          ...selection,
          options: withEffortSelection(
            (selection.options ?? []).filter((option) => !isEffortId(option.id)),
            ownLevel.ok ? ownLevel : { optionId: descriptor.id, value: next },
          ),
        });
      }}
    >
      <SelectTrigger size="xs" className="w-auto min-w-0" aria-label={props.label}>
        <SelectValue>
          {descriptor.options.find((choice) => choice.id === value)?.label ?? effortLabel(value)}
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

/** The newer release a row runs on, as the source that lists it names it (GPT-6.2 Sol). */
function followsName(row: TrackRow, providers: ReadonlyArray<ServerProvider>): string {
  const slug = row.follows ?? row.model;
  const source = providers.find((provider) => provider.instanceId === row.selection?.instanceId);
  return describeModel(source, slug).name ?? slug;
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
                rows.findIndex((entry) => entry.selection !== null) === index ? (
                  <Badge variant="outline" size="sm">
                    {tx(TRACK_FIRST[track])}
                  </Badge>
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
                    {`${tx("Follows newest")}: ${followsName(row, providers)}`}
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
                          <Badge variant={chip.variant} size="sm">
                            {chip.label}
                          </Badge>
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
            </div>
            <TrackEffortSelect
              selection={row.selection}
              effort={row.effort}
              sources={row.sources}
              providers={providers}
              label={`${tx("Effort for")} ${row.name}`}
              disabled={props.mixed}
              onChange={(selection) =>
                props.onSave(
                  // A built-in track saves every built-in entry as it is, this row's level changed.
                  row.builtIn
                    ? savedBuiltInTrack({ rows, at: index, selection })
                    : current.map((entry, at) => (at === movable.indexOf(row) ? selection : entry)),
                )
              }
            />
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
export function ModelTracksSettings({ sources = true }: { readonly sources?: boolean } = {}) {
  const tx = useTx();
  const { target } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environments } = useEnvironments();
  const providers =
    environments.find((environment) => environment.environmentId === target?.environmentId)
      ?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
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
      {(["daily", "complex", "review"] as const).map((track) => (
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
            track === "review" ? (
              // The note sits outside the label: a button inside it would take the label's click.
              <span className="flex items-center gap-1">
                <label
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                  title={tx(
                    "When a thread you started finishes and every task of its increment is done or skipped, a model from another family reviews the work in a new thread, once per increment. Applies to this machine's projects unless a project overrides it. Reviews you or an agent ask for, and the review at increment close, run either way.",
                  )}
                >
                  {tx("Review each finished increment")}
                  <Switch
                    size="sm"
                    mixed={mixedReview}
                    checked={review.autoOnFeatureComplete}
                    aria-label={tx("Review each finished increment automatically")}
                    onCheckedChange={(checked) =>
                      updateSettings({ adversarialReview: { autoOnFeatureComplete: checked } })
                    }
                  />
                </label>
                <PolicyTooltip
                  label={tx(SLOWER_WORK_NOTE_LABEL, {
                    setting: tx("Review each finished increment automatically"),
                  })}
                >
                  {tx(ADVERSARIAL_REVIEW_TIME_NOTE)}
                </PolicyTooltip>
              </span>
            ) : undefined
          }
        />
      ))}
      {sources ? (
        <SourcesCard
          rows={describeSources({ providers, order: sourceOrder, nowMs })}
          order={sourceOrder}
          saved={sourceOrder.length > 0}
          sourceName={sourceName}
          onSave={(order) => updateSettings({ defaultModelProviders: [...order] })}
        />
      ) : null}
    </div>
  );
}

import {
  type EnvironmentId,
  MAX_LANE_MODELS,
  MODEL_TRACK_LABELS,
  type ModelLanes,
  type ModelRoute,
  type ModelRoutes,
  type ModelSelection,
  type ModelTrack,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { listedSources } from "@specweave-studio/shared/modelSources";
import { createModelSelection } from "@specweave-studio/shared/model";
import {
  effortLabel,
  isEffortId,
  findEffortDescriptor,
  withEffortSelection,
} from "@specweave-studio/shared/effortLevel";
import { describeModel } from "@specweave-studio/shared/modelIdentity";
import { withModelRoute } from "@specweave-studio/shared/modelRoutes";
import {
  addTrackEntry,
  describeTrack,
  moveTrackEntry,
  singleReviewFamily,
  type TrackEntryRefusal,
  trackEntryRefusal,
  type TrackRow,
  type TrackSource,
} from "@specweave-studio/shared/modelTrackRules";
import { TRACK_LANES, trackEntryEffort } from "@specweave-studio/shared/modelTracks";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { useTx } from "../../i18n";
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
import { Card, Note, SortableList, SortableRow, statusChip } from "./ModelListParts";
import { ModelRoutePanel } from "./ModelRouteCard";
import { MissingTrackSource, SourcesCard } from "./ModelSourcesCard";
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
        props.onChange({
          ...selection,
          options: withEffortSelection(
            (selection.options ?? []).filter((option) => !isEffortId(option.id)),
            { optionId: descriptor.id, value: next },
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

function TrackCard(props: {
  readonly environmentId: EnvironmentId | null;
  /** Registry agents with an entry on this machine, by registry id. */
  readonly configuredAgents: ReadonlySet<string>;
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
  /** Per-model routes, kept for the whole machine; null where this page cannot change them. */
  readonly routes?: ModelRoutes | undefined;
  readonly onSaveRoute?: ((row: TrackRow, route: ModelRoute) => void) | undefined;
}) {
  const tx = useTx();
  const { track, saved, providers } = props;
  const [refusal, setRefusal] = useState<TrackEntryRefusal | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const rows = describeTrack({
    track,
    saved,
    providers,
    sourceOrder: props.sourceOrder,
    nowMs: props.nowMs,
    routes: props.routes,
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
          <Fragment key={key(row)}>
            <SortableRow
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
                  {row.route !== null ? (
                    <Badge variant="outline" size="sm">
                      {tx("Your route")}
                    </Badge>
                  ) : null}
                </div>
                <ul
                  aria-label={`${tx("Sources for")} ${row.name}`}
                  className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
                >
                  {row.sources.length === 0 ? (
                    props.environmentId === null ? (
                      <li>
                        <Badge variant="outline" size="sm">
                          {tx("Not installed")}
                        </Badge>{" "}
                        {tx("No source on this machine lists it.")}
                      </li>
                    ) : (
                      <MissingTrackSource
                        environmentId={props.environmentId}
                        providers={providers}
                        model={row.model}
                        pinned={row.selection?.instanceId ?? null}
                        nowMs={props.nowMs}
                        sourceName={props.sourceName}
                        configuredAgents={props.configuredAgents}
                      />
                    )
                  ) : (
                    row.sources.map((source, at) => {
                      const chip = statusChip(source.status, tx);
                      const hold = holdNote(source, track, tx);
                      return (
                        <li key={source.provider.instanceId} className="flex items-center gap-1">
                          {at > 0 && source.used ? <span aria-hidden>{tx("then")}</span> : null}
                          <span className="text-foreground">
                            {props.sourceName(source.provider)}
                          </span>
                          {source.ask ? (
                            <Badge variant="warning" size="sm">
                              {tx("Asks first")}
                            </Badge>
                          ) : source.used ? (
                            <Badge variant={chip.variant} size="sm">
                              {chip.label}
                            </Badge>
                          ) : null}
                          {hold !== null && !source.ask ? (
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
                    current.map((entry, at) => (at === movable.indexOf(row) ? selection : entry)),
                  )
                }
              />
              {props.onSaveRoute !== undefined ? (
                <Button
                  type="button"
                  size="xs"
                  variant={opened === key(row) ? "default" : "outline"}
                  aria-expanded={opened === key(row)}
                  aria-label={`${tx("Route for")} ${row.name}`}
                  onClick={() => setOpened(opened === key(row) ? null : key(row))}
                >
                  {tx("Route")}
                  {opened === key(row) ? (
                    <ChevronUpIcon className="size-3" />
                  ) : (
                    <ChevronDownIcon className="size-3" />
                  )}
                </Button>
              ) : null}
              {row.selection !== null ? (
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`${tx("Remove")} ${row.name}`}
                  onClick={() =>
                    props.onSave(current.filter((_, at) => at !== movable.indexOf(row)))
                  }
                >
                  <XIcon className="size-3" />
                </Button>
              ) : null}
            </SortableRow>
            {opened === key(row) && props.onSaveRoute !== undefined ? (
              <li className="border-b border-border/70 last:border-b-0">
                <ModelRoutePanel
                  environmentId={props.environmentId}
                  row={row}
                  providers={providers}
                  nowMs={props.nowMs}
                  sourceName={props.sourceName}
                  onSave={(route) => props.onSaveRoute?.(row, route)}
                />
              </li>
            ) : null}
          </Fragment>
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

/**
 * The three model tracks and the Sources order: which model does routine
 * work, hard work and reviews, and which harness or subscription each model
 * runs on first. Lists reorder by drag and by keyboard; a move that cannot
 * work is refused with its reason. `sources={false}` leaves the Sources order
 * out, for a project dialog: that order is one list for the whole machine.
 */
export function ModelTracksSettings({ sources = true }: { readonly sources?: boolean } = {}) {
  const tx = useTx();
  const { target, scope } = useSettingsScope();
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

  const configuredAgents = new Set(
    entries.flatMap((entry) =>
      entry.driverKind === "acpRegistry" && entry.acpRegistryAgentId !== undefined
        ? [entry.acpRegistryAgentId]
        : [],
    ),
  );
  const sourceName = (provider: ServerProvider) =>
    entries.find((entry) => entry.instanceId === provider.instanceId)?.displayName ??
    provider.displayName ??
    provider.instanceId;
  // Routes are kept for the whole machine, so they change only where the machine's settings do.
  const machineScope = scope.kind === "environment" || scope.kind === "all";
  const routes = settings.modelRoutes ?? {};
  const saveRoute = (row: TrackRow, route: ModelRoute) =>
    updateSettings({
      modelRoutes: withModelRoute(routes, { slug: row.model, name: row.name }, route),
    });
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
          routes={routes}
          onSaveRoute={machineScope ? saveRoute : undefined}
          environmentId={target?.environmentId ?? null}
          configuredAgents={configuredAgents}
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
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
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
      {sources && target?.environmentId ? (
        <SourcesCard
          environmentId={target.environmentId}
          rows={listedSources({ providers, order: sourceOrder, nowMs })}
          providers={providers}
          order={sourceOrder}
          nowMs={nowMs}
          sourceName={sourceName}
          configuredAgents={configuredAgents}
          onSave={(order) => updateSettings({ defaultModelProviders: [...order] })}
        />
      ) : null}
    </div>
  );
}

/**
 * The coordinator model a project starts on when nobody has chosen one, shared
 * by the project view (what the picker shows) and the server (what the first
 * message launches on) so both name the same model.
 *
 * @module coordinatorDefault
 */
import {
  isProviderAvailable,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@specweave-studio/contracts";

import { effortRank, findEffortDescriptor } from "./effortLevel.ts";
import { canTakeTurn, isClaudeApiKeyProvider, isPerTokenProvider } from "./providerFallback.ts";
import { providerSetupProblem } from "./providerSetup.ts";

/** Opus 5.5 under any of the spellings a catalog uses for it. */
const PREFERRED_MODEL = /opus[\s._-]*5[\s._-]*5(?!\d)/i;

function selectable(model: ServerProviderModel): boolean {
  return (
    !model.isCustom &&
    model.isLegacy !== true &&
    model.toolCalls !== false &&
    model.billing !== "api" &&
    model.billing !== "paid-router"
  );
}

/** Mixed supplier catalogs cannot imply free billing from an absent API key. */
function automaticModels(provider: ServerProvider): ServerProvider {
  return {
    ...provider,
    models: provider.models.filter(
      (model) =>
        selectable(model) &&
        (provider.auth.status === "authenticated" || model.billing === "local") &&
        (!(provider.driver === "opencode" || provider.driver === "pi") ||
          model.billing === "local" ||
          model.billing === "subscription"),
    ),
  };
}

/**
 * Explicit choices may be paid, but must still support coordinator tools.
 * An unreported sign-in is accepted once the provider's status check passed:
 * ACP providers such as Copilot never report one, yet take turns as workers.
 */
export function coordinatorSelectionProblem(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): "provider_unavailable" | "coordinator_tools_required" | null {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (providerSetupProblem(provider, selection.model) !== null) return "provider_unavailable";
  const model = provider?.models.find(
    (candidate) =>
      candidate.slug === selection.model || candidate.aliases?.includes(selection.model),
  );
  if (model?.toolCalls === false) return "coordinator_tools_required";
  return null;
}

/**
 * The `provider_unavailable` message for one selection: the provider and model
 * by name, its own reason (`ACP Registry agent 'github-copilot-cli' has not
 * been prepared on this environment.`), the way to fix it, and whether any
 * other provider could have taken the turn instead.
 */
export function coordinatorUnavailableDetail(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  input: { readonly nothingElseHasRoom: boolean },
): string {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const providerName = provider?.displayName ?? selection.instanceId;
  const modelName =
    provider?.models.find(
      (candidate) =>
        candidate.slug === selection.model || candidate.aliases?.includes(selection.model),
    )?.name ?? selection.model;
  const label = `${providerName} · ${modelName}`;
  const why = providerSetupProblem(provider, selection.model);
  const sentence = (text: string) => text.replace(/\.?$/, ".");
  // Our own reasons are fragments (`is not signed in`); a provider's status message is a sentence.
  const first =
    why === null
      ? `${label} cannot run the coordinator on this machine.`
      : /^[a-z]/.test(why)
        ? sentence(`${label} ${why}`)
        : `${label} cannot run on this machine: ${sentence(why)}`;
  const fix =
    provider?.driver === "acpRegistry" && provider.enabled && !provider.installed
      ? `Open Settings > Providers > ${providerName} on that machine and choose Install / update agent, or choose another coordinator model.`
      : `Fix it under Settings > Providers > ${providerName} on that machine, or choose another coordinator model.`;
  return [
    first,
    input.nothingElseHasRoom ? "No other provider has room to run the coordinator instead." : null,
    fix,
  ]
    .filter(Boolean)
    .join(" ");
}

function builtInDefault(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && selectable(model))?.slug ??
    provider.models.find(selectable)?.slug
  );
}

function preferredModel(provider: ServerProvider): string | undefined {
  return provider.models.find(
    (model) =>
      selectable(model) && (PREFERRED_MODEL.test(model.slug) || PREFERRED_MODEL.test(model.name)),
  )?.slug;
}

/** Installed with a known sign-in, or a catalog-proven local model. */
function usable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    (provider.auth.status === "authenticated" ||
      provider.models.some((model) => model.billing === "local"))
  );
}

/**
 * Opus 5.5 on a Claude subscription when this host has it, then that
 * subscription's own default, then the default of the first other provider
 * that can take a turn now, then of one that is merely not broken. A Claude
 * instance billed per token is never chosen: its turns cost money, so it is
 * only ever a model the person picked.
 */
export function defaultCoordinatorModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const free = providers
    .filter((provider) => !isPerTokenProvider(provider) && usable(provider))
    .map(automaticModels);
  const ready = free.filter(canTakeTurn);
  const claude = ready.filter((provider) => provider.driver === "claudeAgent");
  for (const provider of claude) {
    const model = preferredModel(provider);
    if (model) return { instanceId: provider.instanceId, model };
  }
  for (const provider of [...claude, ...ready, ...free.filter(usable)]) {
    const model =
      (provider.driver === "claudeAgent" ? preferredModel(provider) : undefined) ??
      builtInDefault(provider);
    if (model) return { instanceId: provider.instanceId, model };
  }
  return null;
}

/** Any driver signed in with an API key bills each turn to that key. */
function billedPerToken(provider: ServerProvider): boolean {
  return isPerTokenProvider(provider);
}

/**
 * The model a coordinator's worker starts on when neither the coordinator nor
 * the project names one: the coordinator default, but only among providers
 * that can take a turn now and are not billed per token. Workers spend far
 * more than the coordinator, so a limited or paid-per-token provider is only
 * ever one the person chose; with none left the coordinator is asked to pick.
 */
export function defaultWorkerModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  return defaultCoordinatorModelSelection(
    providers.filter(
      (provider) =>
        !billedPerToken(provider) &&
        usable(provider) &&
        provider.usageLimits?.ordinaryUsageAllowed !== false,
    ),
  );
}

/**
 * The provider still shows the placeholder it starts with before its first
 * check in this session: enabled, nothing found yet, sign-in unknown.
 */
function awaitingFirstCheck(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    !provider.installed &&
    provider.version === null &&
    provider.status === "warning" &&
    provider.auth.status === "unknown"
  );
}

/**
 * Some enabled provider still shows its pre-check placeholder, so the host
 * default may still change when that check finishes. A provider cache read at
 * boot does not count as unchecked, so this is a display hint, never a reason
 * to save a model.
 */
export function providersChecking(providers: ReadonlyArray<ServerProvider>): boolean {
  return providers.some(awaitingFirstCheck);
}

/**
 * Every enabled provider has been checked at least once (or restored from the
 * last session's cache), so the host default will not change just because a
 * slower check finishes.
 */
export function providersSettled(providers: ReadonlyArray<ServerProvider>): boolean {
  return providers.length > 0 && !providersChecking(providers);
}

/**
 * The model a project's coordinator runs on, in one order everywhere: the
 * saved choice, then the model its coordinator thread already runs on, then
 * the project's default worker model, then the default model of Settings >
 * Defaults for that project, then this host's default. Without providers
 * (still loading, or the caller is not ready to use them) there is no host
 * default, and `null` means nothing names a model yet.
 */
export function resolveCoordinatorModelSelection(input: {
  readonly saved?: ModelSelection | null | undefined;
  readonly coordinatorThreadModel?: ModelSelection | null | undefined;
  readonly projectDefault?: ModelSelection | null | undefined;
  readonly scopedDefault?: ModelSelection | null | undefined;
  readonly providers?: ReadonlyArray<ServerProvider> | null | undefined;
}): ModelSelection | null {
  return (
    input.saved ??
    input.coordinatorThreadModel ??
    input.projectDefault ??
    input.scopedDefault ??
    (input.providers ? defaultCoordinatorModelSelection(input.providers) : null)
  );
}

function hasOption(model: ServerProviderModel, id: string, value?: string): boolean {
  return (model.capabilities?.optionDescriptors ?? []).some(
    (descriptor) =>
      descriptor.id === id &&
      (value === undefined ||
        (descriptor.type === "select" && descriptor.options.some((option) => option.id === value))),
  );
}

/**
 * The options a coordinator or a worker runs with when nobody chose them:
 * Thinking on (adaptive thinking, which the Claude adapter already asks for
 * while the option is unset, now saved so the picker says so) and, for a
 * coordinator on any model that lists it, Medium effort: it routes and replies,
 * and the hard work goes to threads. Only options the model offers are named,
 * and an option already in `chosen` is never touched; a model without Medium
 * keeps its provider default.
 */
export function defaultModelOptions(
  model: ServerProviderModel | undefined,
  role: "coordinator" | "worker",
  chosen: ReadonlyArray<{ readonly id: string }> = [],
): Array<{ id: string; value: string | boolean }> {
  if (!model) return [];
  const has = (id: string) => chosen.some((option) => option.id === id);
  const effort = findEffortDescriptor(model.capabilities?.optionDescriptors);
  const medium = effort?.options.find((option) => effortRank(option.id) === MEDIUM_RANK);
  return [
    ...(role === "coordinator" && effort && medium && !has(effort.id)
      ? [{ id: effort.id, value: medium.id }]
      : []),
    ...(!has("thinking") && hasOption(model, "thinking") ? [{ id: "thinking", value: true }] : []),
  ];
}

const MEDIUM_RANK = 3;
/** The highest effort a coordinator runs at: High on the shared ladder. */
const COORDINATOR_EFFORT_CAP_RANK = 4;
export const COORDINATOR_EFFORT_CAP_LABEL = "High";

/** An effort value's place on the ladder; a value off it (Ultracode, Ultrathink) is above the cap. */
const coordinatorEffortRank = (option: { readonly id: string; readonly label?: string }) =>
  effortRank(option.id) ?? (option.label ? effortRank(option.label) : undefined) ?? Infinity;

/**
 * A model as the coordinator may run it: its effort choices stop at High. The
 * settings control offers these, so nobody can pick what would be capped.
 */
export function coordinatorEffortModel(model: ServerProviderModel): ServerProviderModel {
  const descriptors = model.capabilities?.optionDescriptors;
  const effort = findEffortDescriptor(descriptors);
  if (!descriptors || !effort) return model;
  const options = effort.options.filter(
    (option) => coordinatorEffortRank(option) <= COORDINATOR_EFFORT_CAP_RANK,
  );
  if (options.length === effort.options.length || options.length === 0) return model;
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      optionDescriptors: descriptors.map((descriptor) =>
        descriptor === effort ? { ...effort, options } : descriptor,
      ),
    },
  };
}

/**
 * The selection a coordinator turn runs on: a saved effort above High runs at
 * High (or the highest level under it the model lists). Applied when a turn
 * picks its model, never to the saved settings, so lifting the cap later needs
 * no migration. Returns the same object when nothing is above the cap.
 */
export function capCoordinatorEffort(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const effort = findEffortDescriptor(
    findModel(providers, selection)?.capabilities?.optionDescriptors,
  );
  if (!effort) return selection;
  const chosen = selectedOptions(selection).find((option) => option.id === effort.id);
  if (!chosen || typeof chosen.value !== "string") return selection;
  const chosenOption = effort.options.find((option) => option.id === chosen.value);
  const rank = coordinatorEffortRank(chosenOption ?? { id: chosen.value });
  if (rank <= COORDINATOR_EFFORT_CAP_RANK) return selection;
  const allowed = effort.options
    .filter((option) => coordinatorEffortRank(option) <= COORDINATOR_EFFORT_CAP_RANK)
    .sort((a, b) => coordinatorEffortRank(b) - coordinatorEffortRank(a))[0];
  // A model whose every level is above High keeps what was chosen.
  if (!allowed) return selection;
  return {
    ...selection,
    options: selectedOptions(selection).map((option) =>
      option.id === effort.id ? { ...option, value: allowed.id } : option,
    ),
  };
}

/**
 * The selection a coordinator turn runs on: the coordinator defaults for every
 * option nobody chose (Medium effort, Thinking), then the cap. A model picked a
 * moment ago has no saved effort yet, and its provider default can be above
 * High, so the default is applied here and not only when the server starts.
 */
export function coordinatorRunSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  return capCoordinatorEffort(
    withDefaultModelOptions(selection, providers, "coordinator"),
    providers,
  );
}

/** Whether a saved coordinator effort is above the cap, so the popover can say so once. */
export function coordinatorEffortIsCapped(
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  return selection != null && capCoordinatorEffort(selection, providers) !== selection;
}

function findModel(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): ServerProviderModel | undefined {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.models.find(
    (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
  );
}

function selectedOptions(
  selection: ModelSelection,
): ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> {
  return selection.options ?? [];
}

/**
 * The selection with the role's default options added for every option nobody
 * chose. Returns the same object when there is nothing to add, so a caller can
 * tell that no write is needed.
 */
export function withDefaultModelOptions(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  role: "coordinator" | "worker",
): ModelSelection {
  const chosen = selectedOptions(selection);
  const added = defaultModelOptions(findModel(providers, selection), role, chosen);
  if (added.length === 0) return selection;
  return { ...selection, options: [...chosen, ...added] };
}

/**
 * The default model a project's threads and workers start on: Opus 5.5 on this
 * host's Claude subscription (never an instance billed per token), with Thinking
 * on. Null when this host has no such instance signed in, so a project is never
 * pinned to whatever else happened to be ready. A usage limit does not count:
 * it passes, and a run started while it lasts moves to another provider the
 * way any run on a chosen model does (see `providerFallback`).
 */
export function defaultProjectModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  for (const provider of providers) {
    if (provider.driver !== "claudeAgent" || isClaudeApiKeyProvider(provider)) continue;
    if (!usable(provider)) continue;
    const slug = preferredModel(provider);
    if (!slug) continue;
    return withDefaultModelOptions(
      { instanceId: provider.instanceId, model: slug },
      providers,
      "worker",
    );
  }
  return null;
}

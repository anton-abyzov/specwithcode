/**
 * A project's saved models are the person's choice: the model new threads start
 * on and the model its coordinator runs on, each with its options (effort,
 * Ultracode, context window). An agent that wants another one asks, and these
 * helpers say what the approval card names and when two choices are the same.
 *
 * Pure, so the card text and the comparison are tested without services.
 *
 * @module projectModelChange
 */
import type {
  ModelSelection,
  Project,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProvider,
  ServerSettings,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Schema from "effect/Schema";

export const ProjectModelRole = Schema.Literals(["threads", "coordinator"]);
/** `threads`: the model new threads start on. `coordinator`: the coordinator's own model. */
export type ProjectModelRole = typeof ProjectModelRole.Type;

type Providers = ReadonlyArray<ServerProvider>;

const optionsOf = (selection: ModelSelection): ReadonlyArray<ProviderOptionSelection> =>
  selection.options ?? [];

/** The option ids a selection names more than once. A model has one value per option. */
export function duplicateOptionIds(selection: ModelSelection): ReadonlyArray<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const option of optionsOf(selection)) (seen.has(option.id) ? repeated : seen).add(option.id);
  return [...repeated];
}

/**
 * The same provider, model and options, whatever order the options are in. A
 * choice with no options is not the same as one with an option switched off:
 * the first follows the model's default, the second is a decision. Options are
 * compared one id to one value, so a selection that repeats an id is the same
 * only as its exact copy.
 */
export function sameModelSelection(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const a = optionsOf(left);
  const b = optionsOf(right);
  if (a.length !== b.length) return false;
  if (duplicateOptionIds(left).length > 0 || duplicateOptionIds(right).length > 0)
    return a.every(
      (option, index) => b[index]?.id === option.id && b[index]?.value === option.value,
    );
  const values = new Map(b.map((option) => [option.id, option.value]));
  return a.every((option) => values.has(option.id) && values.get(option.id) === option.value);
}

/**
 * The thread model a person saved for a project, and whether they saved one.
 * A Project settings override (Settings scoped to the project) outranks the
 * project's own field and counts even when it says "no model": both are the
 * person's, and a write to the field removes the override.
 */
export function savedProjectModel(
  project: Pick<Project, "id" | "defaultModelSelection" | "workspaceSettings">,
  role: ProjectModelRole,
  settings?: ServerSettings | null,
): { readonly model: ModelSelection | null; readonly saved: boolean } {
  if (role === "coordinator") {
    const model = project.workspaceSettings?.coordinatorModelSelection ?? null;
    return { model, saved: model !== null };
  }
  const overrides = settings?.projectSettingsOverrides[project.id];
  if (overrides !== undefined && Object.hasOwn(overrides, "defaultModelSelection"))
    return { model: overrides.defaultModelSelection ?? null, saved: true };
  return { model: project.defaultModelSelection, saved: project.defaultModelSelection !== null };
}

/** New threads of the project start from its model tracks, so no one saved model applies. */
export function projectThreadsUseTracks(
  project: Pick<Project, "id" | "defaultModelSelection">,
  settings: ServerSettings | null | undefined,
): boolean {
  return (
    settings != null &&
    resolveProjectSettings(settings, project.id, project).settings.threadModelMode === "tracks"
  );
}

function findProvider(selection: ModelSelection, providers: Providers) {
  return providers.find((provider) => provider.instanceId === selection.instanceId);
}

function findModel(selection: ModelSelection, providers: Providers) {
  return findProvider(selection, providers)?.models.find(
    (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
  );
}

/**
 * Why this machine cannot save the selection, or null when it lists the model
 * and offers every option named. A card is a promise the person approves, so
 * anything the catalog cannot confirm is refused before they are asked: an
 * unknown provider or model, an option the model does not offer, a value it
 * does not list, an option named twice, or a catalog that is not loaded yet.
 */
export function modelSelectionProblem(
  selection: ModelSelection,
  providers: Providers,
): string | null {
  if (providers.length === 0)
    return "This machine's model list is not loaded yet, so the change cannot be checked. Ask again in a moment.";
  const provider = findProvider(selection, providers);
  if (provider === undefined)
    return `This machine has no provider ${selection.instanceId}. orchestrator_capabilities lists the providers and their models.`;
  const model = findModel(selection, providers);
  const providerName = provider.displayName ?? selection.instanceId;
  if (model === undefined)
    return `${providerName} does not list the model ${selection.model} on this machine. orchestrator_capabilities lists its models.`;
  const repeated = duplicateOptionIds(selection);
  if (repeated.length > 0) return `Name each option once; ${repeated.join(", ")} is repeated.`;
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const offered = descriptors.map((descriptor) => descriptor.id).join(", ") || "no options";
  for (const option of optionsOf(selection)) {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);
    if (descriptor === undefined)
      return `${model.name ?? selection.model} has no option ${JSON.stringify(option.id)}; it offers: ${offered}. Leave it out, and the card tells the user it is left off.`;
    if (descriptor.type === "boolean") {
      if (typeof option.value !== "boolean")
        return `The option ${descriptor.id} of ${model.name ?? selection.model} is on or off: pass true or false.`;
    } else if (!descriptor.options.some((choice) => choice.id === option.value)) {
      return `The option ${descriptor.id} of ${model.name ?? selection.model} takes one of: ${descriptor.options.map((choice) => choice.id).join(", ")}.`;
    }
  }
  return null;
}

/** "contextWindow" → "Context window", for an option the catalog does not describe. */
function optionIdLabel(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function optionText(
  option: ProviderOptionSelection,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): string {
  const descriptor = descriptors?.find((candidate) => candidate.id === option.id);
  const label = descriptor?.label ?? optionIdLabel(option.id);
  if (typeof option.value === "boolean") return `${label} ${option.value ? "on" : "off"}`;
  const choice =
    descriptor?.type === "select"
      ? descriptor.options.find((candidate) => candidate.id === option.value)?.label
      : undefined;
  return `${label} ${choice ?? option.value}`;
}

/**
 * One line a person can check a choice against: the model by the name its
 * provider lists, the provider, and every option with its value. Options are
 * named by the catalog's labels when this machine lists the model, by their ids
 * otherwise, so nothing is left unsaid when a provider is signed out.
 */
export function describeModelSelection(
  selection: ModelSelection | null | undefined,
  providers: Providers,
): string {
  if (selection == null) return "none saved";
  const provider = findProvider(selection, providers);
  const model = findModel(selection, providers);
  const name = model?.name ?? selection.model;
  const on = provider?.displayName ?? selection.instanceId;
  const descriptors = model?.capabilities?.optionDescriptors;
  const options = optionsOf(selection).map((option) => optionText(option, descriptors));
  return `${name} on ${on}${options.length > 0 ? ` (${options.join(", ")})` : " (no options set: the model's defaults)"}`;
}

/**
 * What the person chose on the current model that the new choice does not
 * name: an option that is on or set now and absent from the new selection.
 * These are the settings a quiet model change loses.
 */
export function optionsLeftOff(
  from: ModelSelection | null | undefined,
  to: ModelSelection,
  providers: Providers,
): ReadonlyArray<string> {
  if (from == null) return [];
  const descriptors = findModel(from, providers)?.capabilities?.optionDescriptors;
  const named = new Set(optionsOf(to).map((option) => option.id));
  return optionsOf(from)
    .filter((option) => option.value !== false && !named.has(option.id))
    .map((option) => optionText(option, descriptors));
}

function joinAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The approval card: what changes, from what to what, what is lost, and why the agent asked. */
export function modelChangeCardText(input: {
  readonly projectTitle: string;
  readonly role: ProjectModelRole;
  readonly from: ModelSelection | null | undefined;
  readonly to: ModelSelection;
  readonly providers: Providers;
  readonly reason: string;
}): string {
  // One paragraph each: an agent's reason cannot add lines that read as the card's own.
  const reason = input.reason.replace(/\s+/g, " ").trim();
  const name = `"${input.projectTitle}"`;
  const headline =
    input.role === "coordinator"
      ? `Change the coordinator model of the project ${name}?`
      : `Change the model new threads start on in the project ${name}?`;
  const leftOff = optionsLeftOff(input.from, input.to, input.providers);
  const effect =
    input.role === "coordinator"
      ? "The coordinator uses it from its next turn."
      : "Threads already running keep their model; new threads start on the new one.";
  return [
    headline,
    `Now: ${describeModelSelection(input.from, input.providers)}`,
    `New: ${describeModelSelection(input.to, input.providers)}`,
    `${leftOff.length > 0 ? `The new choice leaves off ${joinAnd(leftOff)}. ` : ""}${effect} Change it back any time in project settings.`,
    `Reason: ${reason}`,
  ].join("\n\n");
}

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
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProvider,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

export const ProjectModelRole = Schema.Literals(["threads", "coordinator"]);
/** `threads`: the model new threads start on. `coordinator`: the coordinator's own model. */
export type ProjectModelRole = typeof ProjectModelRole.Type;

type Providers = ReadonlyArray<ServerProvider>;

const optionsOf = (selection: ModelSelection): ReadonlyArray<ProviderOptionSelection> =>
  selection.options ?? [];

/**
 * The same provider, model and options, whatever order the options are in. A
 * choice with no options is not the same as one with an option switched off:
 * the first follows the model's default, the second is a decision.
 */
export function sameModelSelection(
  left: ModelSelection | null | undefined,
  right: ModelSelection | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const a = optionsOf(left);
  const b = optionsOf(right);
  return (
    a.length === b.length &&
    a.every((option) => b.some((other) => other.id === option.id && other.value === option.value))
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
 * Why this machine cannot save the selection, or null when it lists it. An
 * empty provider list means the catalog is not known here, which refuses
 * nothing: the person still reads the card.
 */
export function modelSelectionProblem(
  selection: ModelSelection,
  providers: Providers,
): string | null {
  if (providers.length === 0) return null;
  const provider = findProvider(selection, providers);
  if (provider === undefined)
    return `This machine has no provider ${selection.instanceId}. orchestrator_capabilities lists the providers and their models.`;
  if (findModel(selection, providers) === undefined)
    return `${provider.displayName ?? selection.instanceId} does not list the model ${selection.model} on this machine. orchestrator_capabilities lists its models.`;
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
    `Reason: ${input.reason}`,
  ].join("\n\n");
}

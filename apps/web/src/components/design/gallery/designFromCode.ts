/**
 * The first message of a "Design from code" thread. It is plain text every
 * provider reads the same way: which design to work on, the tools to use and
 * the design system to follow.
 */
import type { DesignRef, DesignSystemSummary, ModelSelection } from "@specweave-studio/contracts";

import type { ProviderInstanceEntry } from "~/providerInstances";

export function designFromCodePrompt(input: {
  readonly projectTitle: string;
  readonly ref: DesignRef;
  readonly title: string;
  readonly system: DesignSystemSummary | null;
  readonly brief: string;
}): string {
  const { ref, system } = input;
  const brief =
    input.brief.trim() === ""
      ? "Ask me what the design should show, then start once I answer."
      : input.brief.trim();
  return [
    `Design from code in ${input.projectTitle}: ${brief}`,
    "",
    `Design: "${input.title}", id ${ref.designId}, file ${ref.path} in this project. It is open on my screen and updates as you change it.`,
    "",
    "Work on it only through the design tools:",
    "- design_get to read it, design_apply with expectedRevision to change it (re-read on a conflict),",
    "- design_screenshot to look at a page or frame before you call it done,",
    "- design_save_version once a direction is worth keeping.",
    "",
    system === null
      ? "No design system is set. Read the project's styles first (CSS variables, theme and token files, shared components) and match them; don't invent a new look."
      : `Design system: ${system.name} (id ${system.ref.systemId}). Read it with design_system_get and use its tokens and components instead of literal colors and sizes.`,
    "Use the project's real component names, copy and data shapes from the code. Put each screen or variant in its own frame.",
    "Don't edit source files for this; I'll pick a frame and ask you to implement it.",
  ].join("\n");
}

/** "Claude Opus 5.5, high effort": the model a new thread starts on. */
export function workerModelLabel(
  selection: ModelSelection | null,
  entries: readonly ProviderInstanceEntry[],
): string | null {
  if (selection === null) return null;
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  const name = model?.name ?? selection.model;
  const options = Array.isArray(selection.options) ? selection.options : [];
  const effort = options.find((option) => /effort/i.test(option.id))?.value;
  const named =
    entry && !name.toLowerCase().includes(entry.displayName.toLowerCase())
      ? `${entry.displayName} ${name}`
      : name;
  return typeof effort === "string" && effort !== "" ? `${named}, ${effort} effort` : named;
}

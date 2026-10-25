/**
 * The first message of a "Design from code" thread. It is plain text every
 * provider reads the same way: which design to work on, the tools to use and
 * the design system to follow.
 */
import type {
  DesignRef,
  DesignSystemSummary,
  DesignThreadBinding,
  ModelSelection,
} from "@specweave-studio/contracts";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { foundSystemSummary, type FoundSystem } from "./foundSystems";

/** Sources listed in the brief; the rest are counted. */
const SOURCES_LISTED = 8;

export function designFromCodePrompt(input: {
  readonly projectTitle: string;
  readonly ref: DesignRef;
  readonly title: string;
  readonly system: {
    readonly name: string;
    readonly ref: Pick<DesignSystemSummary["ref"], "systemId">;
  } | null;
  /** A system found in the repository and not imported yet, with its review proposal. */
  readonly found?: (FoundSystem & { readonly proposalId: string | null }) | null;
  readonly brief: string;
  /** Set when this window could not bind the design to the thread: the agent does it. */
  readonly selfBind?: DesignThreadBinding | null;
}): string {
  const { ref, system } = input;
  const found = input.found ?? null;
  const brief =
    input.brief.trim() === ""
      ? "Ask me what the design should show, then start once I answer."
      : input.brief.trim();
  return [
    `Design from code in ${input.projectTitle}: ${brief}`,
    "",
    `Design: "${input.title}", id ${ref.designId}, file ${ref.path} in this project. It is open on my screen and updates as you change it.${input.title.endsWith("…") ? " Give it a short title with set_title." : ""}`,
    ...(input.selfBind == null
      ? []
      : [
          "",
          `First attach yourself to it: design_apply with operations [{"op":"set_thread","thread":${JSON.stringify(input.selfBind)}}] (expectedRevision from design_get). Binding your own thread is allowed.`,
        ]),
    "",
    "Work on it only through the design tools:",
    "- design_get to read it, design_apply with expectedRevision to change it (re-read on a conflict),",
    "- design_screenshot to look at a page or frame before you call it done,",
    "- design_save_version once a direction is worth keeping.",
    "",
    ...(system !== null
      ? [
          `Design system: ${system.name} (id ${system.ref.systemId}). Read it with design_system_get and use its tokens and components instead of literal colors and sizes.`,
        ]
      : found !== null
        ? foundSystemLines(found)
        : [
            "No design system is set. Read the project's styles first (CSS variables, theme and token files, shared components) and match them; don't invent a new look.",
          ]),
    "Use the project's real component names, copy and data shapes from the code. Put each screen or variant in its own frame.",
    "Don't edit source files for this; I'll pick a frame and ask you to implement it.",
  ].join("\n");
}

/** Where the reused system lives, so the agent reads those files instead of guessing. */
function foundSystemLines(found: FoundSystem & { readonly proposalId: string | null }) {
  const listed = found.sources.slice(0, SOURCES_LISTED).map((source) => {
    const counts = foundSystemSummary({
      tokens: source.tokens,
      components: source.components,
      modes: [],
    });
    return `- ${source.path}${counts === "" ? "" : `: ${counts}`}`;
  });
  const more = found.sources.length - listed.length;
  return [
    `Design system found in this repository (not imported yet): ${found.name}, ${foundSystemSummary(found)}.`,
    ...listed,
    ...(more > 0 ? [`- and ${more} more file${more === 1 ? "" : "s"} beside them`] : []),
    "Read these files first and reuse their token names (CSS variables) and components; don't invent a palette or new components.",
    found.proposalId === null
      ? "To import it: design_system_scan, then design_system_propose with these paths; the user confirms it in Settings > Design systems."
      : `Its import waits for my review in Settings > Design systems (proposal ${found.proposalId}). Once I confirm it, design_system_list gives its id; then set_design_system to it.`,
  ];
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

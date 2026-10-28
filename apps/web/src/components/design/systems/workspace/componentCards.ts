/**
 * How the Components section lays out a system's components as cards: grouped
 * by the folder or entry point they came from, filtered by a search, and what
 * each card shows (a built preview, hand-written HTML, or why there is none).
 */
import type { DesignSystem, DesignSystemComponent } from "@specweave-studio/contracts";

export type ComponentPreviewKind =
  | { readonly kind: "built"; readonly file: string }
  | { readonly kind: "html" }
  | { readonly kind: "none"; readonly note: string };

export const NO_PREVIEW = "No preview yet. Ask the agent to add one.";

export function previewKind(component: DesignSystemComponent): ComponentPreviewKind {
  if (component.previewFile !== undefined) return { kind: "built", file: component.previewFile };
  if (component.previewHtml !== undefined && component.previewHtml.trim() !== "") {
    return { kind: "html" };
  }
  return { kind: "none", note: component.previewNote ?? NO_PREVIEW };
}

export interface ComponentGroup {
  readonly name: string;
  readonly components: ReadonlyArray<DesignSystemComponent>;
}

const groupName = (component: DesignSystemComponent) => {
  if (component.group !== undefined && component.group.trim() !== "") return component.group;
  return component.framework === "css-class" ? "CSS classes" : "Components";
};

const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/[-_]+/g, " ");

/**
 * Groups in a stable order (the order components first appear), each listing
 * the components that match `query` by name, group or import path. Components
 * with a preview come first in their group, so a group opens on something to see.
 */
export function componentGroups(
  components: ReadonlyArray<DesignSystemComponent>,
  query: string,
): ComponentGroup[] {
  const needle = query.trim().toLowerCase();
  const groups = new Map<string, DesignSystemComponent[]>();
  for (const component of components) {
    const group = groupName(component);
    const haystack = [component.name, group, component.importPath ?? ""].join(" ").toLowerCase();
    if (needle !== "" && !haystack.includes(needle)) continue;
    const list = groups.get(group) ?? [];
    list.push(component);
    groups.set(group, list);
  }
  return [...groups].map(([name, list]) => ({
    name: label(name),
    components: [
      ...list.filter((component) => previewKind(component).kind !== "none"),
      ...list.filter((component) => previewKind(component).kind === "none"),
    ],
  }));
}

/** "275 of 317 components render from the kit's stories." or null when nothing was built. */
export function previewSummary(system: DesignSystem): string | null {
  const previews = system.previews;
  if (previews === undefined) return null;
  const noun = previews.total === 1 ? "component renders" : "components render";
  return `${previews.rendered.toLocaleString("en-US")} of ${previews.total.toLocaleString("en-US")} ${noun} from the kit's stories.`;
}

/** The story captions in a built preview file, in order. */
export function storyNames(html: string): string[] {
  return [...html.matchAll(/<section data-swc-story="([^"]*)"/g)].map((match) =>
    (match[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&"),
  );
}

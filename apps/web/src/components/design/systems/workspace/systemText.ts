/** Short texts the design system page shares. Pure. */
import type { DesignOwnerInput, DesignSystem } from "@specweave-studio/contracts";

const LONG_DATE = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** "October 23, 2026"; the text as given when it is not a date. */
export function longDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : LONG_DATE.format(time);
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** "Used by 3 designs", "Not used by any design yet", or "Checking…" while unknown. */
export function usageLabel(designs: number | null): string {
  if (designs === null) return "Checking…";
  return designs === 0 ? "Not used by any design yet" : `Used by ${plural(designs, "design")}`;
}

/** The delete warning, with how many designs keep pointing at the system. */
export function deleteWarning(
  system: Pick<DesignSystem, "name">,
  designs: number | null,
  ownerLabel: string,
): string {
  const where = `This deletes ${system.name} and its stored files from ${ownerLabel}.`;
  if (designs === null) return `${where} Designs that use it keep its id and render without it.`;
  if (designs === 0) return `${where} No design uses it.`;
  return `${where} ${plural(designs, "design")} ${designs === 1 ? "uses it; it keeps its id and renders" : "use it; they keep its id and render"} without it.`;
}

export function ownerText(owner: DesignOwnerInput, projectTitle: string | null): string {
  return owner.kind === "playground" ? "Playground" : (projectTitle ?? "Project");
}

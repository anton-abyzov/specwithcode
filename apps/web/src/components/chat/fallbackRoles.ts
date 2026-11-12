import { baseModelSlug } from "@specweave-studio/shared/threadModelIdentity";
import type { ModelStateHeader } from "./fallbackStatus";

/** A fallback role's key: `claude-opus-5-5[1m]` runs the row `claude-opus-5-5`. */
export const fallbackRoleKey = (instanceId: string, model: string) =>
  `${instanceId}\u0000${baseModelSlug(model)}`;

/**
 * Each model's part in the fallback, so the list says which runs now, which is the
 * pick and where the rest sit in the order, not only which are starred.
 */
export function fallbackRolesByKey(
  chain: NonNullable<ModelStateHeader["chain"]> | undefined,
): ReadonlyMap<string, { readonly label: string; readonly tone: "now" | "pick" | "order" }> {
  const roles = new Map<
    string,
    { readonly label: string; readonly tone: "now" | "pick" | "order" }
  >();
  for (const entry of chain ?? []) {
    roles.set(
      fallbackRoleKey(entry.instanceId, entry.model),
      entry.role === "now"
        ? {
            label: entry.position === null ? "Now" : `Now · fallback ${entry.position}`,
            tone: "now",
          }
        : entry.role === "pick"
          ? { label: "Your pick", tone: "pick" }
          : { label: `Fallback ${entry.position}`, tone: "order" },
    );
  }
  return roles;
}

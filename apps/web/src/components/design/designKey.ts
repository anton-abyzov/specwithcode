import { DesignId, ProjectId, type DesignOwnerInput } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

/**
 * The `/design/$designKey` route parameter: `p.<projectId>.<designId>` for a
 * project's design, `pg.<designId>` for one in the Playground. A design id
 * never contains a dot, so the last dot always ends the project id.
 */
export function encodeDesignKey(owner: DesignOwnerInput, designId: DesignId): string {
  return owner.kind === "playground" ? `pg.${designId}` : `p.${owner.projectId}.${designId}`;
}

const isDesignId = Schema.is(DesignId);

export function decodeDesignKey(
  key: string,
): { readonly owner: DesignOwnerInput; readonly designId: DesignId } | null {
  if (key.startsWith("pg.")) {
    const designId = key.slice(3);
    return isDesignId(designId) ? { owner: { kind: "playground" }, designId } : null;
  }
  if (!key.startsWith("p.")) return null;
  const rest = key.slice(2);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return null;
  const projectId = rest.slice(0, dot);
  const designId = rest.slice(dot + 1);
  if (!isDesignId(designId) || projectId.trim() === "") return null;
  return { owner: { kind: "project", projectId: ProjectId.make(projectId) }, designId };
}

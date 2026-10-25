import type { DesignShareInfo } from "./backend";

/** Where the editor's owner crumbs and the Share dialog's owner chip lead. */
export function ownerLinks(share: DesignShareInfo) {
  const owner = share.ownerProject ?? null;
  if (owner === null)
    return {
      project: null,
      designs: {
        href: "/design?tab=playground",
        route: { to: "/design", search: { tab: "playground" } } as const,
      },
    };
  return {
    project:
      owner.projectKey === null
        ? null
        : {
            href: `/projects/${encodeURIComponent(owner.projectKey)}?pane=designs`,
            route: {
              to: "/projects/$projectKey",
              params: { projectKey: owner.projectKey },
              search: { pane: "designs" },
            } as const,
          },
    designs: {
      href: `/design?project=${encodeURIComponent(owner.projectId)}`,
      route: { to: "/design", search: { project: owner.projectId } } as const,
    },
  };
}

/** A plain click stays in the app; a modified click keeps the browser's own behavior. */
export function plainClick(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
}) {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0);
}

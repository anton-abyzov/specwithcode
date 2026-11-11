// Stands in for the thread's server: every media path maps to the fixture's /media route,
// and a thumb request is visible in the URL so the check can tell the two apart.
type MediaResource = { readonly _tag: string; readonly path?: string } | null;

const mediaUrl = (path: string, variant?: string) =>
  `/media/${encodeURIComponent(path.split("/").at(-1) ?? "file")}${variant ? "?variant=thumb" : ""}`;

export function useAssetUrlState(
  _environmentId: unknown,
  resource: MediaResource,
  variant?: string,
) {
  if (resource === null || resource.path === undefined) return { _tag: "Loading" as const };
  // A file that is gone, or lives on another machine, cannot be signed.
  if (resource.path.includes("/missing/")) return { _tag: "Failure" as const };
  return {
    _tag: "Success" as const,
    url: mediaUrl(resource.path, variant),
    expiresAt: Date.now() + 3_600_000,
    ...(resource.path.endsWith(".png") ? { imageDimensions: { width: 1600, height: 900 } } : {}),
  };
}

export function useAssetUrlRefresh(_environmentId: unknown, resource: MediaResource) {
  return async () => (resource?.path ? mediaUrl(resource.path) : null);
}

/** The full-file URL the expanded viewer asks for; never a variant. */
export function useAtomQueryRunner() {
  return async (request: { input: { resource: { path: string }; variant?: string } }) => ({
    _tag: "Success" as const,
    value: {
      relativeUrl: mediaUrl(request.input.resource.path, request.input.variant),
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

/** The viewer's side pane asks for files; the fixture has none to show. */
export function useProjectFileQuery() {
  return {
    data: null,
    error: null,
    readError: null,
    isNotFile: false,
    isPending: false,
    refresh: () => {},
  };
}

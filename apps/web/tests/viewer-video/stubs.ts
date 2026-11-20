// Stands in for the thread's server: a media path maps to the fixture's /media route.
type MediaResource = { readonly _tag: string; readonly path?: string } | null;

const mediaUrl = (path: string) => `/media/${encodeURIComponent(path.split("/").at(-1) ?? "file")}`;

export function useAssetUrlState(_environmentId: unknown, resource: MediaResource) {
  if (resource === null || resource.path === undefined) return { _tag: "Loading" as const };
  return {
    _tag: "Success" as const,
    url: mediaUrl(resource.path),
    expiresAt: Date.now() + 3_600_000,
  };
}

export function useAssetUrlRefresh(_environmentId: unknown, resource: MediaResource) {
  return async () => (resource?.path ? mediaUrl(resource.path) : null);
}

export function useAtomQueryRunner() {
  return async (request: { input: { resource: { path: string } } }) => ({
    _tag: "Success" as const,
    value: {
      relativeUrl: mediaUrl(request.input.resource.path),
      expiresAt: Date.now() + 3_600_000,
    },
  });
}

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

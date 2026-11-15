// Split chunks are fetched lazily, so a deploy (or desktop server swap)
// between page load and a later fetch can 404 the old hashed assets. One
// reload picks up the fresh index.html. A sessionStorage flag keeps a
// persistent failure from becoming a reload loop. The flag holds the build it
// reloaded for and survives later boots: a chunk fetched only after boot can
// fail on every visit, so clearing it on a good boot would reload forever.
// A different build gets its own single reload.
const CHUNK_RELOAD_GUARD_KEY = "studio:chunk-load-reloaded";

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per
 * build and returns whether it did, so the caller knows whether to swallow the
 * event or let the error surface through the normal paths.
 */
export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build: string = import.meta.env.APP_VERSION || "0.0.0",
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === build;
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, build);
  } catch {
    // Without storage the guard cannot survive a reload, so a persistent
    // failure would loop forever. Let the error surface instead.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

// A browser caches a failed dynamic import for the life of the document, so
// re-running the route loader fails the same way; only a reload retries it.
const CHUNK_LOAD_ERROR_PREFIXES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
];

/** Whether an error came from a split chunk that failed to load. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return (
    message !== undefined && CHUNK_LOAD_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

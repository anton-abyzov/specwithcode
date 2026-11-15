// Split chunks are fetched lazily, so a deploy (or desktop server swap)
// between page load and a later fetch can 404 the old hashed assets. One
// reload picks up the fresh index.html. A sessionStorage flag keeps a
// persistent failure from becoming a reload loop. The flag holds the build
// whose chunk failed, the one running when the reload fired, and survives
// later boots: a chunk fetched only after boot can fail on every visit, so
// clearing it on a good boot would reload forever. A different build gets its
// own single reload.
const CHUNK_RELOAD_GUARD_KEY = "studio:chunk-load-reloaded";

/**
 * The running build. A production entry script is named by a hash of every
 * chunk it can load, so two deploys that share a version number still differ.
 * In development the entry name never changes and the version alone remains.
 */
function currentBuild(): string {
  const version = import.meta.env.APP_VERSION || "0.0.0";
  let entry: string | null | undefined;
  try {
    entry = document.querySelector('script[type="module"][src]')?.getAttribute("src");
  } catch {
    entry = null;
  }
  return entry ? `${version} ${entry}` : version;
}

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per
 * build and returns whether it did, so the caller knows whether to swallow the
 * event or let the error surface through the normal paths.
 */
export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build: string = currentBuild(),
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

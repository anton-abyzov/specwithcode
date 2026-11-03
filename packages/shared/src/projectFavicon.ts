export const PROJECT_FAVICON_FALLBACK_MARKER = "project-favicon-missing";

export function getProjectFaviconResourceKey(
  environmentId: string,
  workspaceRoot: string,
  faviconPath?: string | null,
) {
  return JSON.stringify([environmentId, workspaceRoot, faviconPath || null]);
}

export function getProjectFaviconCacheKey(
  environmentId: string,
  workspaceRoot: string,
  url: string,
) {
  let revision = url;

  try {
    const pathname = new URL(url, "https://studio.invalid").pathname;
    revision = pathname.slice(pathname.lastIndexOf("/") + 1);
  } catch {
    // Keep the full value as a safe fallback for malformed URLs.
  }

  return JSON.stringify([environmentId, workspaceRoot, revision]);
}

export function isProjectFaviconFallbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;

  try {
    const pathname = new URL(url, "https://studio.invalid").pathname;
    return pathname.slice(pathname.lastIndexOf("/") + 1) === PROJECT_FAVICON_FALLBACK_MARKER;
  } catch {
    return false;
  }
}

/**
 * A saved icon file another checkout of the project can also use: a path inside
 * the repository. An absolute path names a file on one machine only.
 */
export function isPortableProjectFaviconPath(faviconPath: string): boolean {
  return !/^(?:[a-zA-Z]:)?[\\/]/.test(faviconPath);
}

/**
 * Whether someone chose this checkout's icon. The server reports a favicon it found
 * in the repository as an absolute path inside the workspace; that one is automatic.
 */
export function hasSavedProjectIcon(project: {
  readonly projectIcon?: unknown;
  readonly faviconPath?: string | null | undefined;
  readonly workspaceRoot: string;
}): boolean {
  if (project.projectIcon != null) return true;
  if (project.faviconPath == null) return false;
  if (isPortableProjectFaviconPath(project.faviconPath)) return true;
  const root = project.workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return !project.faviconPath.replaceAll("\\", "/").startsWith(`${root}/`);
}

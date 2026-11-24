/**
 * Path comparisons for files the Board and Library open, on any host: either
 * separator, a whole segment at a time, and anything returned is cut from the
 * original path.
 *
 * On a Windows drive or UNC path only ASCII letters match without case. The
 * browser cannot know a volume's case table (NTFS keeps `ς` and `σ`, or `ß`
 * and `ss`, apart where JavaScript folds them together), and a wrong match
 * would show another copy's file. A missed match only serves a page by its
 * exact path, without its sibling stylesheets.
 */

const segmentsOf = (value: string): string[] => value.replaceAll("\\", "/").split("/");

export const isWindowsPath = (value: string): boolean =>
  /^[A-Za-z]:/.test(value) || value.startsWith("\\\\") || value.startsWith("//");

const ASCII_CAPITAL = /[A-Z]/g;
const asciiLower = (value: string): string =>
  value.replace(ASCII_CAPITAL, (letter) => letter.toLowerCase());

const sameSegment = (left: string, right: string, windows: boolean): boolean =>
  left === right || (windows && asciiLower(left) === asciiLower(right));

/**
 * The part of `path` inside `root`, with forward slashes, built from the
 * original segments; null when `path` is not strictly inside it.
 */
export function pathInside(root: string, path: string): string | null {
  if (root === "") return null;
  const windows = isWindowsPath(root) || isWindowsPath(path);
  const base = segmentsOf(root);
  while (base.length > 1 && base.at(-1) === "") base.pop();
  const target = segmentsOf(path);
  if (target.length <= base.length) return null;
  if (!base.every((segment, index) => sameSegment(segment, target[index]!, windows))) return null;
  const relative = target.slice(base.length).join("/");
  return relative === "" ? null : relative;
}

/** The folder holding a file, from the original path (its last segment cut). */
export function parentPath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  const at = slashed.lastIndexOf("/");
  return at <= 0 ? path.slice(0, Math.max(at, 0) + 1) : path.slice(0, at);
}

/**
 * For a file in a copy of a project (`<copy>/.specweave/increments/...`): the
 * copy's folder, cut from the original path, and the file's path inside it.
 * The last such pair of segments counts. Null when there is none.
 */
export function incrementCopyRoot(
  path: string,
): { readonly root: string; readonly relative: string } | null {
  const windows = isWindowsPath(path);
  const segments = segmentsOf(path);
  for (let index = segments.length - 3; index >= 1; index -= 1) {
    if (
      !sameSegment(segments[index]!, ".specweave", windows) ||
      !sameSegment(segments[index + 1]!, "increments", windows)
    ) {
      continue;
    }
    // Separators are swapped one for one, so segment lengths are offsets.
    const offset = segments.slice(0, index).reduce((sum, segment) => sum + segment.length + 1, -1);
    if (offset <= 0) return null;
    return { root: path.slice(0, offset), relative: segments.slice(index).join("/") };
  }
  return null;
}

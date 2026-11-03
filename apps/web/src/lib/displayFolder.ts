/**
 * The home folder as "~", so the part that differs between projects stays readable.
 * macOS, Linux and Windows home folders all shorten; anything else is left as it is.
 */
export function displayFolder(path: string): string {
  return path
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

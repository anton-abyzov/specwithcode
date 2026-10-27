import { isWindowsAbsolutePath } from "@specweave-studio/shared/path";

/**
 * How the file viewer shows a host file it has no media player for: a
 * PowerPoint deck as its slides, a document or archive it cannot draw as a
 * card that opens it in its app, anything else as text.
 */
export type HostFilePreview = "deck" | "card" | "text";

const DECK = /\.pptx$/i;
/** Files that are never text: office documents, archives, databases, fonts, design files. */
const NOT_TEXT =
  /\.(key|numbers|pages|docx?|dotx|xlsx?|xlsm|pptm|ppt|potx|ppsx|odp|ods|odt|rtf|epub|zip|gz|tgz|bz2|xz|tar|7z|rar|dmg|pkg|iso|exe|dll|so|dylib|bin|o|a|class|jar|wasm|sqlite3?|db|woff2?|ttf|otf|psd|sketch|fig|ai|eps|heic|tiff?)$/i;

export function hostFilePreview(path: string): HostFilePreview {
  if (DECK.test(path)) return "deck";
  return NOT_TEXT.test(path) ? "card" : "text";
}

const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.key$/i, "Keynote presentations have no preview here."],
  [/\.(pptm|ppt|potx|ppsx)$/i, "Only PowerPoint decks saved as .pptx have a slide preview."],
  [/\.(docx?|dotx)$/i, "Word documents have no preview here."],
  [/\.(xlsx?|xlsm)$/i, "Excel workbooks have no preview here."],
  [/\.(numbers|pages)$/i, "iWork documents have no preview here."],
  [/\.(odp|ods|odt)$/i, "OpenDocument files have no preview here."],
];

/** Why a file has no preview here, in one sentence. */
export function noPreviewReason(name: string): string {
  return REASONS.find(([pattern]) => pattern.test(name))?.[1] ?? `${name} has no preview here.`;
}

/**
 * The host path of a file an artifact names: as given when absolute (POSIX, drive or UNC),
 * otherwise joined to the workspace root with the root's own separator.
 */
export function hostArtifactPath(path: string, cwd: string | undefined): string {
  if (!cwd || path.startsWith("/") || isWindowsAbsolutePath(path)) return path;
  const root = cwd.replace(/[\\/]+$/, "");
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${separator}${path.replace(/^(?:\.[\\/])+/, "")}`;
}

// @effect-diagnostics nodeBuiltinImport:off - Plain promises over files inside one approved root.
/**
 * Brand files a code import offers to store beside the system, so Overview,
 * Assets and Typography are not empty after an import: the package's README
 * and docs, images in its brand or logo folders, its logo and favicon files,
 * fonts with their licenses, and the same next to copies of its tokens (an
 * app's `public/assets/brand/uikit-tokens.css` sits beside the logos).
 *
 * Folder listings come from the caller and every read goes through
 * `readBytesInsideRoot`, so hidden folders, secrets and links out of the root
 * are never read. Same files, same offer: sorted, deduplicated by content,
 * and capped.
 */
import {
  DESIGN_SYSTEM_FILE_MAX_BYTES,
  type DesignSystemFinding,
  type DesignSystemProposedFile,
} from "@specweave-studio/contracts";

import { compareText, finding, sha256Hex } from "./common.ts";
import { RootPathError, readBytesInsideRoot, statInsideRoot } from "./scanCandidates.ts";
import { pathProblem } from "./SystemFilesStore.ts";

/** At most this many files are offered, and this many bytes in all. */
export const BRAND_FILES_MAX_COUNT = 80;
export const BRAND_FILES_MAX_BYTES = 64 * 1024 * 1024;
const DOCS_MAX = 20;

const IMAGE = /\.(?:svg|png|jpe?g|gif|webp|ico|avif)$/i;
const FONT = /\.(?:woff2?|ttf|otf)$/i;
const FONT_LICENSE = /(?:licen[cs]e|ofl).*\.(?:txt|md)$/i;
const BRAND_FOLDER = /^(?:brand|brands|branding|logo|logos)$/i;
const FONT_FOLDER = /^fonts?$/i;
/** Logo-like files anywhere in a package's root or its `public` folder. */
const LOGO_FILE =
  /^(?:logo|logomark|wordmark|favicon|crest|brandmark)(?:[-._ ][^/]*)?\.(?:svg|png|ico|webp)$/i;

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const join = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);
const inside = (folder: string, path: string) => folder === "" || path.startsWith(`${folder}/`);

/** A source file name as a stored name: what a stored path cannot hold becomes `-`. */
export const storedFileName = (name: string): string | null => {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const clean = stem
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._()-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[-. ]+$/, "")
    .slice(0, 100);
  if (clean === "" || extension === "") return null;
  return `${clean}.${extension}`;
};

/** The nearest folder at or above `path`'s folder that holds a package.json. */
const packageRootOf = (folders: ReadonlyMap<string, ReadonlyArray<string>>, path: string) => {
  let folder = folders.has(path) ? path : folderOf(path);
  for (;;) {
    if (folders.get(folder)?.includes(join(folder, "package.json"))) return folder;
    if (folder === "") return null;
    folder = folderOf(folder);
  }
};

interface Wanted {
  readonly source: string;
  readonly target: string;
}

/** Fonts in `folder` and the license files beside them. */
const fontsIn = (files: ReadonlyArray<string>): Wanted[] => {
  const fonts = files.filter((file) => FONT.test(file));
  if (fonts.length === 0) return [];
  return [...fonts, ...files.filter((file) => FONT_LICENSE.test(baseName(file)))].map((file) => ({
    source: file,
    target: "fonts",
  }));
};

const imagesIn = (files: ReadonlyArray<string>): Wanted[] =>
  files
    .filter((file) => IMAGE.test(file))
    .map((file) => ({ source: file, target: "assets/Brand" }));

/** Folders below `base` whose path names a brand or font folder at any depth. */
const kindsOf = (base: string, folder: string) => {
  const names = (base === "" ? folder : folder.slice(base.length + 1)).split("/");
  return {
    brand: names.some((name) => BRAND_FOLDER.test(name)),
    fonts: names.some((name) => FONT_FOLDER.test(name)),
  };
};

/** What one package offers, in a stable order: README, docs, images, fonts. */
const fromPackage = (
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
  root: string,
  primary: boolean,
): Wanted[] => {
  const wanted: Wanted[] = [];
  const top = folders.get(root) ?? [];
  const readme = top.find((file) => /^readme\.md$/i.test(baseName(file)));
  if (readme) wanted.push({ source: readme, target: primary ? "" : "docs" });
  // A nested package (its own package.json) is another system's, not this one's.
  const inPackage = [...folders.keys()]
    .filter(
      (folder) =>
        folder !== root && inside(root, folder) && packageRootOf(folders, folder) === root,
    )
    .sort(compareText);
  const docs = join(root, "docs");
  wanted.push(
    ...inPackage
      .filter((folder) => folder === docs || folder.startsWith(`${docs}/`))
      .flatMap((folder) => folders.get(folder) ?? [])
      .filter((file) => /\.md$/i.test(file))
      .map((file) => ({ source: file, target: "docs" })),
  );
  for (const folder of [root, join(root, "public")]) {
    wanted.push(
      ...(folders.get(folder) ?? [])
        .filter((file) => LOGO_FILE.test(baseName(file)))
        .map((file) => ({ source: file, target: "assets/Brand" })),
    );
  }
  for (const folder of inPackage) {
    const kinds = kindsOf(root, folder);
    if (kinds.brand) wanted.push(...imagesIn(folders.get(folder) ?? []));
    if (kinds.fonts) wanted.push(...fontsIn(folders.get(folder) ?? []));
  }
  return wanted;
};

/** Brand and font folders at a copy: its own folder, that folder's siblings, and theirs below. */
const nearCopy = (folders: ReadonlyMap<string, ReadonlyArray<string>>, copy: string): Wanted[] => {
  const folder = folderOf(copy);
  // Never the whole project: a copy at the top looks only in its own folder.
  const parent = folder === "" ? null : folderOf(folder) === "" ? folder : folderOf(folder);
  if (parent === null) return [];
  const near = [...folders.keys()]
    .filter((candidate) => inside(parent, candidate) && (candidate !== parent || parent === folder))
    .sort(compareText);
  const wanted: Wanted[] = [];
  for (const candidate of near) {
    const kinds = kindsOf(parent, candidate);
    if (kinds.brand) wanted.push(...imagesIn(folders.get(candidate) ?? []));
    if (kinds.fonts) wanted.push(...fontsIn(folders.get(candidate) ?? []));
  }
  return wanted;
};

export interface BrandFileOffer {
  readonly files: ReadonlyArray<DesignSystemProposedFile>;
  readonly findings: ReadonlyArray<DesignSystemFinding>;
}

/** `logo.svg`, then `logo 2.svg`, `logo 3.svg`…: the first name nobody holds. */
const freePath = (path: string, taken: ReadonlySet<string>) => {
  if (!taken.has(path.toLowerCase())) return path;
  const dot = path.lastIndexOf(".");
  for (let count = 2; ; count += 1) {
    const candidate = `${path.slice(0, dot)} ${count}${path.slice(dot)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

/**
 * The brand files to offer for the selected sources and copies. `stored` holds
 * the system's stored paths: a name it already keeps is not offered, so an
 * import never overwrites a README or logo someone stored by hand. Sizes are
 * checked before a file is read, so the caps bound what is read, not only
 * what is offered.
 */
export const findBrandFiles = async (
  realRoot: string,
  folders: ReadonlyMap<string, ReadonlyArray<string>>,
  paths: ReadonlyArray<string>,
  copies: ReadonlyArray<string> = [],
  stored: ReadonlyArray<string> = [],
): Promise<BrandFileOffer> => {
  // The package holding most selected sources is the system's own; its README is the Overview.
  const counts = new Map<string, number>();
  for (const path of paths) {
    const root = packageRootOf(folders, path);
    if (root !== null) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  const roots = [...counts].sort(
    (left, right) => right[1] - left[1] || compareText(left[0], right[0]),
  );
  const wanted = [
    ...roots.flatMap(([root], index) => fromPackage(folders, root, index === 0)),
    ...[...new Set(copies)].sort(compareText).flatMap((copy) => nearCopy(folders, copy)),
  ];

  const storedNames = new Set(stored.map((path) => path.toLowerCase()));
  const taken = new Set(storedNames);
  const seenSources = new Set<string>();
  const seenHashes = new Set<string>();
  const files: DesignSystemProposedFile[] = [];
  const findings: DesignSystemFinding[] = [];
  let bytes = 0;
  let docs = 0;
  let capped = 0;
  for (const { source, target } of wanted) {
    if (seenSources.has(source)) continue;
    seenSources.add(source);
    const name = storedFileName(baseName(source));
    if (name === null) continue;
    const named = join(target, name);
    // A name the system stores is never offered; one taken earlier in this offer gets a number.
    if (pathProblem(named) !== null || storedNames.has(named.toLowerCase())) continue;
    const path = freePath(named, taken);
    if (pathProblem(path) !== null) continue;
    if (files.length >= BRAND_FILES_MAX_COUNT || (target === "docs" && docs >= DOCS_MAX)) {
      capped += 1;
      continue;
    }
    let size: number;
    try {
      size = (await statInsideRoot(realRoot, source, DESIGN_SYSTEM_FILE_MAX_BYTES)).size;
    } catch (error) {
      if (error instanceof RootPathError && error.reason === "too-large") {
        findings.push(
          finding("unreadable", "info", `${source} is over 10 MiB, so it is not offered`, source),
        );
      }
      continue;
    }
    if (bytes + size > BRAND_FILES_MAX_BYTES) {
      capped += 1;
      continue;
    }
    let read: { readonly bytes: Buffer };
    try {
      read = await readBytesInsideRoot(
        realRoot,
        source,
        Math.min(DESIGN_SYSTEM_FILE_MAX_BYTES, BRAND_FILES_MAX_BYTES - bytes),
      );
    } catch {
      continue;
    }
    const sha256 = sha256Hex(read.bytes);
    if (seenHashes.has(sha256)) continue;
    seenHashes.add(sha256);
    taken.add(path.toLowerCase());
    bytes += read.bytes.byteLength;
    if (target === "docs") docs += 1;
    files.push({ source, path, bytes: read.bytes.byteLength, sha256 });
  }
  if (capped > 0) {
    findings.push(
      finding(
        "brand-files",
        "info",
        `${capped} more brand ${capped === 1 ? "file was" : "files were"} left out: an import offers at most ${BRAND_FILES_MAX_COUNT} files, ${DOCS_MAX} of them docs, and 64 MiB. Upload the rest in Assets.`,
      ),
    );
  }
  return { files, findings };
};

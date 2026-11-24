import type { EnvironmentId } from "@specweave-studio/contracts";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";

import {
  basenameGlob,
  fileLinkMetaAtPath,
  matchesFileNamePattern,
  type MarkdownFileLinkMeta,
  mayBeDirectory,
} from "../../markdown-links";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";

function parentAndName(path: string): { parent: string; name: string } | null {
  // `C:\\repo\\README.md` splits at its backslash.
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index <= 0) return null;
  return { parent: path.slice(0, index), name: path.slice(index + 1) };
}

type EntryKind = "file" | "directory";
type SettledPath =
  | { readonly path: string; readonly kind: EntryKind }
  | { readonly unresolved: ReadonlyArray<string> };
type Settled =
  | SettledPath
  /** Shorthand, settled file by file; a real file under the written name wins. */
  | { readonly expansions: ReadonlyArray<SettledPath> };

type FolderEntries = ReadonlyArray<{ readonly path: string; readonly kind: EntryKind }>;
type SearchResult = {
  readonly entries: ReadonlyArray<{ readonly path: string }>;
  readonly truncated: boolean;
};

/**
 * One pass of host reads. Every listing and search is read fresh from the
 * host: other parts of the app (the file browser) keep listings for a while,
 * and a file may have been made or deleted since. Each folder and search is
 * read once while a read of it is in flight, so messages that mount together
 * and name one folder cost one read.
 */
interface HostReads {
  list(folder: string): Promise<FolderEntries | null>;
  search(root: string, query: string): Promise<SearchResult | null>;
}

// Reads still on their way to the host: a link asked while one is in flight
// shares it; once it lands, the next ask reads fresh again.
const inFlightReads = new Map<string, Promise<unknown>>();

function freshRead<A>(key: string, read: () => Promise<A>): Promise<A> {
  const pending = inFlightReads.get(key);
  if (pending) return pending as Promise<A>;
  const promise = read().finally(() => {
    if (inFlightReads.get(key) === promise) inFlightReads.delete(key);
  });
  inFlightReads.set(key, promise);
  return promise;
}

function hostReads(environmentId: EnvironmentId): HostReads {
  // Within one pass each folder and search is read once.
  const thisPass = new Map<string, Promise<unknown>>();
  const once = <A>(key: string, read: () => Promise<A>): Promise<A> => {
    const known = thisPass.get(key);
    if (known) return known as Promise<A>;
    const promise = freshRead(key, read);
    thisPass.set(key, promise);
    return promise;
  };
  return {
    list: (folder) =>
      once(`${environmentId}\u0000list\u0000${folder}`, () =>
        folderEntriesOnHost(environmentId, folder, true),
      ),
    search: (root, query) =>
      once(`${environmentId}\u0000search\u0000${root}\u0000${query}`, async () => {
        const result = await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.searchEntries({
            environmentId,
            input: { cwd: root, query, limit: SEARCH_LIMIT },
          }),
          { reportFailure: false, reportDefect: false, refresh: true },
        );
        return result?._tag === "Success" ? result.value : null;
      }),
  };
}

/** What the host has at `path`, read from its parent folder's listing. */
async function entryKindOnHost(reads: HostReads, path: string): Promise<EntryKind | null> {
  const split = parentAndName(path);
  if (!split) return null;
  const entries = await reads.list(split.parent);
  return entries?.find((entry) => entry.path === split.name)?.kind ?? null;
}

/** The names in a host folder, or null when it cannot be listed. */
export async function folderEntriesOnHost(
  environmentId: EnvironmentId,
  folder: string,
  refresh = false,
): Promise<FolderEntries | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.listEntries({ environmentId, input: { cwd: folder, directoryPath: "" } }),
    { reportFailure: false, reportDefect: false, ...(refresh ? { refresh: true } : {}) },
  );
  return result?._tag === "Success" ? result.value.entries : null;
}

/** Links the host must settle: where they are, or whether they are folders. */
function needsHostCheck(meta: MarkdownFileLinkMeta): boolean {
  return (
    meta.requiresHost === true ||
    meta.expansions !== undefined ||
    meta.glob !== undefined ||
    (meta.candidates?.length ?? 0) > 1 ||
    meta.search !== undefined ||
    (!meta.directory && mayBeDirectory(meta))
  );
}

const SEARCH_LIMIT = 50;

/**
 * The one entry a search names for `path`: the entry whose path ends with what
 * the message wrote. Two or more (`spec.md` sits in every increment), or a
 * result cut short, names none: opening a same-named file from elsewhere is
 * worse than saying the file was not found.
 */
export function uniqueSearchMatch(
  entries: ReadonlyArray<{ readonly path: string }>,
  truncated: boolean,
  path: string,
): string | null {
  const matches = new Set(
    entries
      .map((entry) => entry.path)
      .filter((entryPath) => entryPath === path || entryPath.endsWith(`/${path}`)),
  );
  if (matches.size !== 1 || truncated) return null;
  return [...matches][0]!;
}

/**
 * A file the message named by a path the candidates do not hold, found by
 * name in the roots it may live under, only when one file there matches.
 * `CoordinatorConversation.tsx` finds
 * `apps/web/src/components/studio/CoordinatorConversation.tsx`.
 */
async function searchOnHost(
  reads: HostReads,
  search: NonNullable<MarkdownFileLinkMeta["search"]>,
): Promise<string | null> {
  const name = search.path.split("/").at(-1) ?? search.path;
  if (name.length === 0) return null;
  for (const root of search.roots) {
    const result = await reads.search(root, name);
    if (result === null) continue;
    const match = uniqueSearchMatch(result.entries, result.truncated, search.path);
    if (match !== null) return `${root}/${match}`;
  }
  return null;
}

/**
 * A link as asked of one machine. Answers are kept by it, never by the span,
 * so a span that now resolves elsewhere never shows the old answer. Nothing
 * outlives the message: each mount asks the host again, and a bare name stays
 * code until the host answers, so a deleted file never shows a chip.
 */
function settledCacheKey(environmentId: EnvironmentId, meta: MarkdownFileLinkMeta): string {
  return `${environmentId}\u0000${JSON.stringify(meta)}`;
}

/** For tests: forget what the hosts said. */
export function clearSettledFileLinkCache(): void {
  inFlightReads.clear();
}

/**
 * Settles links on what the host has: a link that may point to more than one
 * place (see `MarkdownFileLinkMeta.candidates`) on the first path that exists,
 * and an extensionless path (`../specweave-wt-code-captures`) on whether it is
 * a folder, so the chip opens the file manager rather than a file viewer that
 * cannot show it. Until the host answers, the authored path stays.
 */
export function useExistingFileLinks<Key>(
  metaByKey: ReadonlyMap<Key, MarkdownFileLinkMeta>,
  environmentId: EnvironmentId | null,
  cwd: string | undefined,
): ReadonlyMap<Key, MarkdownFileLinkMeta> {
  // Answers by what was asked (machine and link), never by the span alone, so
  // a span that now resolves under another folder never shows the old file.
  const [answered, setAnswered] = useState<ReadonlyMap<string, Settled>>(new Map());
  const unsettled = useMemo(
    () => [...metaByKey].filter(([, meta]) => needsHostCheck(meta)),
    [metaByKey],
  );
  // This machine's answers for the links the message names now.
  const found = useMemo(() => {
    const known = new Map<Key, Settled>();
    if (environmentId === null) return known;
    for (const [key, meta] of unsettled) {
      const cacheKey = settledCacheKey(environmentId, meta);
      const settled = answered.get(cacheKey);
      if (settled) known.set(key, settled);
    }
    return known;
  }, [answered, environmentId, unsettled]);

  useEffect(() => {
    if (environmentId === null || unsettled.length === 0) return;
    // Every link is asked again: a file deleted since still loses its chip.
    let active = true;
    const reads = hostReads(environmentId);
    const settleOne = async (meta: MarkdownFileLinkMeta): Promise<SettledPath> => {
      const candidates = meta.candidates ?? [meta.filePath];
      for (const candidate of candidates) {
        const kind = await entryKindOnHost(reads, candidate);
        if (kind === null || (meta.directory && kind !== "directory")) continue;
        return { path: candidate, kind };
      }
      if (meta.search && !meta.directory) {
        const found = await searchOnHost(reads, meta.search).catch(() => null);
        if (found !== null) return { path: found, kind: "file" };
      }
      return { unresolved: candidates };
    };
    void (async () => {
      const next = new Map<string, Settled>();
      const settle = (_key: Key, meta: MarkdownFileLinkMeta, settled: Settled) => {
        const cacheKey = settledCacheKey(environmentId, meta);
        next.set(cacheKey, settled);
      };
      for (const [key, meta] of unsettled) {
        if (meta.expansions || meta.glob) {
          // A file really named `a{1,2}.md` or `shot-*.png` is that file.
          const literal = await entryKindOnHost(reads, meta.filePath);
          if (literal === "file") {
            settle(key, meta, { path: meta.filePath, kind: literal });
            continue;
          }
        }
        if (meta.expansions) {
          const expansions: SettledPath[] = [];
          for (const expansion of meta.expansions) {
            expansions.push(await settleOne(expansion));
          }
          settle(key, meta, { expansions });
          continue;
        }
        if (meta.glob) {
          settle(key, meta, await settleGlob(reads, meta));
          continue;
        }
        settle(key, meta, await settleOne(meta));
      }
      if (!active) return;
      // Only the links this message names now: answers for links it no
      // longer names are dropped, so they never pile up while it stays open.
      const current = new Set(unsettled.map(([, meta]) => settledCacheKey(environmentId, meta)));
      setAnswered((previous) => {
        const kept = [...previous].filter(([cacheKey]) => current.has(cacheKey));
        return new Map([...kept, ...next]);
      });
    })();
    return () => {
      active = false;
    };
  }, [unsettled, environmentId]);

  return useMemo(() => {
    if (found.size === 0) return metaByKey;
    const settled = new Map(metaByKey);
    for (const [key, entry] of found) {
      const meta = metaByKey.get(key);
      if (!meta) continue;
      if ("expansions" in entry) {
        const members = meta.expansions ?? [];
        // A pattern's files come from the host, with nothing authored for each.
        const expansions = entry.expansions.flatMap((member, index) => {
          const authored =
            members[index] ?? ("path" in member ? fileLinkMetaAtPath({}, member.path, cwd) : null);
          // Unsettled (a folder the host cannot list) keeps the authored path.
          const one = authored && (settledMeta(authored, member, cwd) ?? authored);
          return one ? [one] : [];
        });
        const { glob: _glob, ...rest } = meta;
        settled.set(key, { ...rest, expansions });
        continue;
      }
      const { expansions: _expansions, glob: _glob, ...single } = meta;
      const one = settledMeta(single, entry, cwd);
      if (one) settled.set(key, one);
    }
    return settled;
  }, [cwd, found, metaByKey]);
}

/** A link as the host settled it; null keeps it as authored. */
function settledMeta(
  meta: MarkdownFileLinkMeta,
  entry: SettledPath,
  cwd: string | undefined,
): MarkdownFileLinkMeta | null {
  if ("unresolved" in entry) {
    // Nothing on the host: an extensionless path may still be a folder
    // the host cannot list, so only a file is marked as not found.
    return mayBeDirectory(meta) ? null : { ...meta, unresolved: entry.unresolved };
  }
  const { directory: _directory, ...rest } = meta;
  return fileLinkMetaAtPath(
    entry.kind === "directory" ? { ...rest, directory: true } : rest,
    entry.path,
    cwd,
  );
}

const MAX_GLOB_MATCHES = 32;

/**
 * The files a `*` pattern names, from the listing of the first folder it may be
 * in. None, or more than a report would mean, leaves no links: the pattern is
 * never a file of its own.
 */
async function settleGlob(reads: HostReads, meta: MarkdownFileLinkMeta): Promise<Settled> {
  for (const candidate of meta.candidates ?? [meta.filePath]) {
    const glob = basenameGlob(candidate);
    if (glob === null) continue;
    const entries = await reads.list(glob.folder);
    const matches = (entries ?? [])
      .filter((entry) => entry.kind === "file" && !entry.path.includes("/"))
      .filter((entry) => matchesFileNamePattern(entry.path, glob.pattern))
      .map((entry) => entry.path)
      .toSorted();
    if (matches.length === 0) continue;
    // Too many to be the files a report means: it stays as written.
    if (matches.length > MAX_GLOB_MATCHES) return { expansions: [] };
    return {
      expansions: matches.map((name) => ({ path: `${glob.folder}/${name}`, kind: "file" })),
    };
  }
  return { expansions: [] };
}

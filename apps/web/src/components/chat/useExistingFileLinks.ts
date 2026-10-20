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
  const index = path.lastIndexOf("/");
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

/** What the host has at `path`, read from its parent folder's listing. */
async function entryKindOnHost(
  environmentId: EnvironmentId,
  path: string,
): Promise<EntryKind | null> {
  const split = parentAndName(path);
  if (!split) return null;
  const entries = await folderEntriesOnHost(environmentId, split.parent);
  return entries?.find((entry) => entry.path === split.name)?.kind ?? null;
}

/** The names in a host folder, or null when it cannot be listed. */
export async function folderEntriesOnHost(
  environmentId: EnvironmentId,
  folder: string,
): Promise<ReadonlyArray<{ readonly path: string; readonly kind: EntryKind }> | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.listEntries({ environmentId, input: { cwd: folder, directoryPath: "" } }),
    { reportFailure: false, reportDefect: false },
  );
  return result?._tag === "Success" ? result.value.entries : null;
}

/** Links the host must settle: where they are, or whether they are folders. */
function needsHostCheck(meta: MarkdownFileLinkMeta): boolean {
  return (
    meta.expansions !== undefined ||
    meta.glob !== undefined ||
    (meta.candidates?.length ?? 0) > 1 ||
    meta.search !== undefined ||
    (!meta.directory && mayBeDirectory(meta))
  );
}

const SEARCH_LIMIT = 50;

/**
 * A file the message named by a path the candidates do not hold, found by
 * name in the roots it may live under: the match whose path ends with what
 * the message wrote, the shortest first. `CoordinatorConversation.tsx` finds
 * `apps/web/src/components/studio/CoordinatorConversation.tsx`.
 */
async function searchOnHost(
  environmentId: EnvironmentId,
  search: NonNullable<MarkdownFileLinkMeta["search"]>,
): Promise<string | null> {
  const name = search.path.split("/").at(-1) ?? search.path;
  if (name.length === 0) return null;
  for (const root of search.roots) {
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectEnvironment.searchEntries({
        environmentId,
        input: { cwd: root, query: name, limit: SEARCH_LIMIT },
      }),
      { reportFailure: false, reportDefect: false },
    );
    if (result?._tag !== "Success") continue;
    const match = result.value.entries
      .filter((entry) => entry.path === search.path || entry.path.endsWith(`/${search.path}`))
      .toSorted((left, right) => left.path.length - right.path.length)[0];
    if (match) return `${root}/${match.path}`;
  }
  return null;
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
  const [found, setFound] = useState<ReadonlyMap<Key, Settled>>(new Map());
  const unsettled = useMemo(
    () => [...metaByKey].filter(([, meta]) => needsHostCheck(meta)),
    [metaByKey],
  );

  useEffect(() => {
    if (environmentId === null || unsettled.length === 0) return;
    let active = true;
    const settleOne = async (meta: MarkdownFileLinkMeta): Promise<SettledPath> => {
      const candidates = meta.candidates ?? [meta.filePath];
      for (const candidate of candidates) {
        const kind = await entryKindOnHost(environmentId, candidate);
        if (kind === null || (meta.directory && kind !== "directory")) continue;
        return { path: candidate, kind };
      }
      if (meta.search && !meta.directory) {
        const found = await searchOnHost(environmentId, meta.search).catch(() => null);
        if (found !== null) return { path: found, kind: "file" };
      }
      return { unresolved: candidates };
    };
    void (async () => {
      const next = new Map<Key, Settled>();
      for (const [key, meta] of unsettled) {
        if (meta.expansions || meta.glob) {
          // A file really named `a{1,2}.md` or `shot-*.png` is that file.
          const literal = await entryKindOnHost(environmentId, meta.filePath);
          if (literal === "file") {
            next.set(key, { path: meta.filePath, kind: literal });
            continue;
          }
        }
        if (meta.expansions) {
          const expansions: SettledPath[] = [];
          for (const expansion of meta.expansions) expansions.push(await settleOne(expansion));
          next.set(key, { expansions });
          continue;
        }
        if (meta.glob) {
          next.set(key, await settleGlob(environmentId, meta));
          continue;
        }
        next.set(key, await settleOne(meta));
      }
      if (active) setFound(next);
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
async function settleGlob(
  environmentId: EnvironmentId,
  meta: MarkdownFileLinkMeta,
): Promise<Settled> {
  for (const candidate of meta.candidates ?? [meta.filePath]) {
    const glob = basenameGlob(candidate);
    if (glob === null) continue;
    const entries = await folderEntriesOnHost(environmentId, glob.folder);
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

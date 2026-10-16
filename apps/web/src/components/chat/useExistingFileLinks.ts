import type { EnvironmentId } from "@specweave-studio/contracts";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";

import {
  fileLinkMetaAtPath,
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
type Settled =
  | { readonly path: string; readonly kind: EntryKind }
  | { readonly unresolved: ReadonlyArray<string> };

/** What the host has at `path`, read from its parent folder's listing. */
async function entryKindOnHost(
  environmentId: EnvironmentId,
  path: string,
): Promise<EntryKind | null> {
  const split = parentAndName(path);
  if (!split) return null;
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.listEntries({
      environmentId,
      input: { cwd: split.parent, directoryPath: "" },
    }),
    { reportFailure: false, reportDefect: false },
  );
  if (result?._tag !== "Success") return null;
  return result.value.entries.find((entry) => entry.path === split.name)?.kind ?? null;
}

/** Links the host must settle: where they are, or whether they are folders. */
function needsHostCheck(meta: MarkdownFileLinkMeta): boolean {
  return (
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
    void (async () => {
      const next = new Map<Key, Settled>();
      for (const [key, meta] of unsettled) {
        const candidates = meta.candidates ?? [meta.filePath];
        let settled: Settled | null = null;
        for (const candidate of candidates) {
          const kind = await entryKindOnHost(environmentId, candidate);
          if (kind === null || (meta.directory && kind !== "directory")) continue;
          settled = { path: candidate, kind };
          break;
        }
        if (settled === null && meta.search && !meta.directory) {
          const found = await searchOnHost(environmentId, meta.search).catch(() => null);
          if (found !== null) settled = { path: found, kind: "file" };
        }
        next.set(key, settled ?? { unresolved: candidates });
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
      if ("unresolved" in entry) {
        // Nothing on the host: an extensionless path may still be a folder
        // the host cannot list, so only a file is marked as not found.
        if (!mayBeDirectory(meta)) settled.set(key, { ...meta, unresolved: entry.unresolved });
        continue;
      }
      const { directory: _directory, ...rest } = meta;
      settled.set(
        key,
        fileLinkMetaAtPath(
          entry.kind === "directory" ? { ...rest, directory: true } : rest,
          entry.path,
          cwd,
        ),
      );
    }
    return settled;
  }, [cwd, found, metaByKey]);
}

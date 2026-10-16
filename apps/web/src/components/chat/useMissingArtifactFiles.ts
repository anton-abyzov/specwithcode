import type { EnvironmentId } from "@specweave-studio/contracts";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";

const CONCURRENCY = 4;

function splitPath(path: string): { parent: string; name: string } | null {
  const index = path.lastIndexOf("/");
  if (index <= 0) return null;
  return { parent: path.slice(0, index), name: path.slice(index + 1) };
}

/** A folder's children by name, or null when the host could not list it. */
async function listNames(
  environmentId: EnvironmentId,
  folder: string,
): Promise<{ names: ReadonlySet<string>; complete: boolean } | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.listEntries({ environmentId, input: { cwd: folder, directoryPath: "" } }),
    { refresh: true, reportFailure: false, reportDefect: false },
  ).catch(() => null);
  if (result?._tag !== "Success") return null;
  return {
    names: new Set(result.value.entries.map((entry) => entry.path)),
    complete: !result.value.truncated,
  };
}

/**
 * Which of `paths` the host no longer has, checked once per folder while
 * `enabled`. Only a definite absence counts: the folder listed without the
 * file, or the folder's own parent listed without the folder. A host that
 * cannot answer marks nothing missing.
 */
export function useMissingArtifactFiles(
  environmentId: EnvironmentId | null,
  paths: ReadonlyArray<string>,
  enabled: boolean,
): ReadonlySet<string> {
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const signature = useMemo(
    () => [...new Set(paths.filter((path) => path.startsWith("/")))].toSorted().join("\n"),
    [paths],
  );
  useEffect(() => {
    if (!enabled || environmentId === null || signature.length === 0) return;
    let active = true;
    void (async () => {
      const byFolder = new Map<string, string[]>();
      for (const path of signature.split("\n")) {
        const split = splitPath(path);
        if (!split) continue;
        byFolder.set(split.parent, [...(byFolder.get(split.parent) ?? []), path]);
      }
      const next = new Set<string>();
      const check = async (folder: string, files: ReadonlyArray<string>) => {
        const listing = await listNames(environmentId, folder);
        if (listing === null) {
          const up = splitPath(folder);
          const parent = up ? await listNames(environmentId, up.parent) : null;
          if (parent?.complete && up && !parent.names.has(up.name)) {
            for (const file of files) next.add(file);
          }
          return;
        }
        if (!listing.complete) return;
        for (const file of files) {
          if (!listing.names.has(file.slice(folder.length + 1))) next.add(file);
        }
      };
      // A few folders at a time, so a long list does not queue the host up.
      const queue = [...byFolder];
      const take = () => (active ? queue.shift() : undefined);
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          for (let job = take(); job; job = take()) await check(job[0], job[1]);
        }),
      );
      if (active) setMissing(next);
    })();
    return () => {
      active = false;
    };
  }, [enabled, environmentId, signature]);
  return missing;
}

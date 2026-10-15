import type { EnvironmentId } from "@specweave-studio/contracts";
import { executeAtomQuery } from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useMemo, useState } from "react";

import { fileLinkMetaAtPath, type MarkdownFileLinkMeta } from "../../markdown-links";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { projectEnvironment } from "../../state/projects";

function parentAndName(path: string): { parent: string; name: string } | null {
  const index = path.lastIndexOf("/");
  if (index <= 0) return null;
  return { parent: path.slice(0, index), name: path.slice(index + 1) };
}

async function existsOnHost(
  environmentId: EnvironmentId,
  path: string,
  directory: boolean,
): Promise<boolean> {
  const split = parentAndName(path);
  if (!split) return false;
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.listEntries({
      environmentId,
      input: { cwd: split.parent, directoryPath: "" },
    }),
    { reportFailure: false, reportDefect: false },
  );
  return (
    result?._tag === "Success" &&
    result.value.entries.some(
      (entry) => entry.path === split.name && entry.kind === (directory ? "directory" : "file"),
    )
  );
}

/**
 * Settles links that may point to more than one place (see
 * `MarkdownFileLinkMeta.candidates`) on the first path that exists on the
 * host, so the chip's tooltip, viewer and file manager all use the real file.
 * Until the host answers, or when none exists, the most likely path stays.
 */
export function useExistingFileLinks(
  metaByText: ReadonlyMap<string, MarkdownFileLinkMeta>,
  environmentId: EnvironmentId | null,
  cwd: string | undefined,
): ReadonlyMap<string, MarkdownFileLinkMeta> {
  const [existing, setExisting] = useState<ReadonlyMap<string, string>>(new Map());
  const ambiguous = useMemo(
    () => [...metaByText].filter(([, meta]) => (meta.candidates?.length ?? 0) > 1),
    [metaByText],
  );

  useEffect(() => {
    if (environmentId === null || ambiguous.length === 0) return;
    let active = true;
    void (async () => {
      const found = new Map<string, string>();
      for (const [text, meta] of ambiguous) {
        for (const candidate of meta.candidates!) {
          if (await existsOnHost(environmentId, candidate, meta.directory === true)) {
            found.set(text, candidate);
            break;
          }
        }
      }
      if (active) setExisting(found);
    })();
    return () => {
      active = false;
    };
  }, [ambiguous, environmentId]);

  return useMemo(() => {
    if (existing.size === 0) return metaByText;
    const settled = new Map(metaByText);
    for (const [text, path] of existing) {
      const meta = metaByText.get(text);
      if (meta && meta.filePath !== path) settled.set(text, fileLinkMetaAtPath(meta, path, cwd));
    }
    return settled;
  }, [cwd, existing, metaByText]);
}

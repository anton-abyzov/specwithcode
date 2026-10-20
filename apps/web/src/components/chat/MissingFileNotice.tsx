import type { EnvironmentId, ProjectReadFileError } from "@specweave-studio/contracts";
import { type ReactNode, useEffect, useState } from "react";

import { folderEntriesOnHost } from "./useExistingFileLinks";

const MAX_SIMILAR_FILES = 8;

/**
 * A read that failed finding the file, never one the server refused: a
 * protected file keeps its refusal rather than reading as missing.
 */
export function mayBeMissing(readError: ProjectReadFileError | null): boolean {
  return (
    readError !== null &&
    readError.failure === "operation_failed" &&
    readError.reason === undefined &&
    (readError.operation === "realpath-target" || readError.operation === "open")
  );
}

/** Files beside a missing one that a reader likely meant: same extension, same leading name. */
export function similarFileNames(name: string, siblings: ReadonlyArray<string>): string[] {
  const extension = /\.[^.]+$/.exec(name)?.[0] ?? "";
  const shared = (other: string) => {
    let length = 0;
    while (length < Math.min(name.length, other.length) && name[length] === other[length]) {
      length++;
    }
    return length;
  };
  return siblings
    .filter((sibling) => sibling !== name && sibling.endsWith(extension) && shared(sibling) >= 3)
    .toSorted((left, right) => shared(right) - shared(left) || left.localeCompare(right))
    .slice(0, MAX_SIMILAR_FILES);
}

type Check =
  | { readonly kind: "checking" }
  | { readonly kind: "present" }
  | { readonly kind: "folder-missing" }
  | { readonly kind: "missing"; readonly similar: ReadonlyArray<string> };

/**
 * Why a file did not open, told plainly: the host lists its folder, so a file
 * that is not there says so, with its full path and the files beside it that
 * look like what was meant (`findings-B.md` for `findings-{B,C,D,E}.md`).
 * Any other failure keeps the server's own words.
 */
export function MissingFileNotice(props: {
  readonly environmentId: EnvironmentId;
  /** Absolute host path of the file that did not open. */
  readonly path: string;
  readonly error: string | null;
  readonly onOpen?: ((path: string) => void) | undefined;
  readonly actions?: ReactNode;
}) {
  const { environmentId, path } = props;
  const slash = path.lastIndexOf("/");
  const folder = slash > 0 ? path.slice(0, slash) : "/";
  const name = path.slice(slash + 1);
  // The answer is kept with the path it is about, so another path checks afresh.
  const [answer, setAnswer] = useState<{ readonly path: string; readonly check: Check } | null>(
    null,
  );
  const check: Check = answer?.path === path ? answer.check : { kind: "checking" };

  useEffect(() => {
    let active = true;
    const settle = (next: Check) => {
      if (active) setAnswer({ path, check: next });
    };
    void folderEntriesOnHost(environmentId, folder)
      .catch(() => null)
      .then((entries) => {
        if (entries === null) return settle({ kind: "folder-missing" });
        if (entries.some((entry) => entry.path === name)) return settle({ kind: "present" });
        const files = entries
          .filter((entry) => entry.kind === "file" && !entry.path.includes("/"))
          .map((entry) => entry.path);
        settle({ kind: "missing", similar: similarFileNames(name, files) });
      });
    return () => {
      active = false;
    };
  }, [environmentId, folder, name, path]);

  if (check.kind === "checking") {
    return <p className="p-4 text-muted-foreground text-sm">Checking where the file is…</p>;
  }
  if (check.kind === "present" || (check.kind === "folder-missing" && props.error === null)) {
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm" role="alert">
        <p className="text-destructive-foreground">{props.error ?? `${name} could not be read.`}</p>
        <div className="flex gap-1">{props.actions}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-4 text-sm" role="status" data-missing-file={path}>
      <p>
        {check.kind === "folder-missing"
          ? `${name} was not found: its folder does not exist or cannot be read here.`
          : `${name} was not found.`}
      </p>
      <p className="break-all font-mono text-muted-foreground text-xs">{path}</p>
      {check.kind === "missing" && check.similar.length > 0 ? (
        <>
          <p>Files with similar names in {folder}:</p>
          <ul className="flex flex-col gap-1" data-similar-files="true">
            {check.similar.map((similar) => (
              <li key={similar}>
                {props.onOpen ? (
                  <button
                    type="button"
                    className="font-mono text-xs underline underline-offset-2 hover:text-foreground"
                    onClick={() => props.onOpen?.(`${folder}/${similar}`)}
                  >
                    {similar}
                  </button>
                ) : (
                  <span className="font-mono text-xs">{similar}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="flex gap-1">{props.actions}</div>
    </div>
  );
}

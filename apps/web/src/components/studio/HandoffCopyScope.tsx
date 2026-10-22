import { useEffect, useEffectEvent, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { FolderCopyScopes } from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { Radio, RadioGroup } from "../ui/radio-group";

export function useCopyScope(project: EnvironmentProject) {
  const command = useAtomCommand(machineHandoff.copyScopes, { reportFailure: false });
  const requestKey = JSON.stringify([project.environmentId, project.id, project.workspaceRoot]);
  const [response, setResponse] = useState<{
    key: string;
    result: FolderCopyScopes | null;
    notice: string | null;
  } | null>(null);
  const [choice, setChoice] = useState<{ key: string; copyRoot: string } | null>(null);
  const load = useEffectEvent(() =>
    command({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await load();
        if (loaded._tag === "Failure") throw squashAtomCommandFailure(loaded);
        if (!cancelled) setResponse({ key: requestKey, result: loaded.value, notice: null });
      } catch {
        if (!cancelled)
          setResponse({
            key: requestKey,
            result: null,
            notice:
              "Could not verify a containing workspace. Only this project folder is available; update or reconnect the source to check again.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestKey]);
  const current = response?.key === requestKey ? response : null;
  const result = current?.result;
  const scopes = result?.scopes ?? [
    {
      copyRoot: project.workspaceRoot,
      projectRelativePath: ".",
      kind: "project" as const,
      label: "This project folder",
      repositories: [],
      truncated: false,
    },
  ];
  const selected =
    scopes.find((scope) => choice?.key === requestKey && scope.copyRoot === choice.copyRoot) ??
    scopes.find((scope) => scope.copyRoot === result?.recommendedCopyRoot) ??
    scopes[0]!;
  return {
    scopes,
    selected,
    loading: current === null,
    notice: current?.notice ?? null,
    select: (copyRoot: string) => setChoice({ key: requestKey, copyRoot }),
    recommended: result?.recommendedCopyRoot ?? project.workspaceRoot,
  };
}

export function HandoffCopyScope({
  scope,
  sourceLabel,
  disabled,
}: {
  readonly scope: ReturnType<typeof useCopyScope>;
  readonly sourceLabel: string;
  readonly disabled: boolean;
}) {
  return (
    <fieldset
      className="min-w-0 space-y-2"
      disabled={disabled || scope.loading}
      data-slot="copy-source-folder"
    >
      <legend className="mb-2 text-sm font-medium">What to copy from {sourceLabel}</legend>
      {scope.loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking project and umbrella folders…
        </p>
      ) : (
        <RadioGroup
          aria-label="Source folder"
          value={scope.selected.copyRoot}
          onValueChange={scope.select}
        >
          {[...scope.scopes]
            .sort(
              (a, b) =>
                Number(b.copyRoot === scope.recommended) - Number(a.copyRoot === scope.recommended),
            )
            .map((entry) => (
              <label
                key={entry.copyRoot}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${scope.selected.copyRoot === entry.copyRoot ? "border-primary bg-accent/40" : ""}`}
              >
                <span className="flex h-5 items-center">
                  <Radio value={entry.copyRoot} />
                </span>
                <span className="min-w-0 leading-5">
                  <span className="block font-medium">
                    {entry.kind === "workspace"
                      ? `Whole umbrella · ${entry.label}`
                      : "This project folder only"}
                    {scope.scopes.length > 1 && entry.copyRoot === scope.recommended
                      ? " (recommended)"
                      : ""}
                  </span>
                  <span className="block font-mono text-xs wrap-anywhere">{entry.copyRoot}</span>
                </span>
              </label>
            ))}
        </RadioGroup>
      )}
      {scope.notice && (
        <p role="status" className="text-xs text-warning-foreground">
          {scope.notice}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Copies the selected folder and its contents, preserving their layout. Folders outside this
        root and linked folders are not followed.
      </p>
      {scope.selected.projectRelativePath !== "." && (
        <div
          className="space-y-1 rounded-md bg-muted/50 p-3 text-xs"
          data-slot="copy-project-location"
        >
          <p>
            This project and its coordinator stay in{" "}
            <span className="font-mono wrap-anywhere">{scope.selected.projectRelativePath}</span>{" "}
            inside the copied umbrella.
          </p>
          {scope.selected.repositories.length > 0 && (
            <details>
              <summary className="cursor-pointer">
                Included repositories ({scope.selected.repositories.length}
                {scope.selected.truncated ? "+" : ""})
              </summary>
              <ul className="mt-1 space-y-1 font-mono wrap-anywhere">
                {scope.selected.repositories.map((repo) => (
                  <li key={repo}>{repo}</li>
                ))}
              </ul>
              {scope.selected.truncated && (
                <p className="mt-1">
                  The list is abbreviated. Measure the folder to review the copy.
                </p>
              )}
            </details>
          )}
        </div>
      )}
    </fieldset>
  );
}

export function CopyScopeMapping({
  source,
  target,
  projectFolder,
}: {
  readonly source: string;
  readonly target: string;
  readonly projectFolder: string;
}) {
  return (
    <div className="space-y-1 rounded-md border p-3 text-xs" data-slot="copy-scope-mapping">
      <p>
        Copy from <span className="font-mono wrap-anywhere">{source}</span>
      </p>
      <p>
        Copy into <span className="font-mono wrap-anywhere">{target}</span>
      </p>
      {target !== projectFolder && (
        <p>
          Project / coordinator folder:{" "}
          <span className="font-mono wrap-anywhere">{projectFolder}</span>
        </p>
      )}
    </div>
  );
}

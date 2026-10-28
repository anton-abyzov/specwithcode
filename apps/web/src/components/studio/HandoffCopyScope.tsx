import { useEffect, useEffectEvent, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { FolderCopyScopes } from "@specweave-studio/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { Checkbox } from "../ui/checkbox";

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

/**
 * The copy root, under More options. The whole umbrella is the default when the project sits
 * in one; "Copy only this project folder" narrows it. A plain project has nothing to choose.
 */
export function HandoffCopyScope({
  scope,
  sourceLabel,
  disabled,
}: {
  readonly scope: ReturnType<typeof useCopyScope>;
  readonly sourceLabel: string;
  readonly disabled: boolean;
}) {
  const projectOnly = scope.scopes.find((entry) => entry.kind === "project") ?? null;
  const umbrella =
    scope.scopes.find(
      (entry) => entry.copyRoot === scope.recommended && entry.kind !== "project",
    ) ??
    scope.scopes.find((entry) => entry.kind !== "project") ??
    null;
  const narrowed = projectOnly !== null && scope.selected.copyRoot === projectOnly.copyRoot;
  return (
    <div className="min-w-0 space-y-1.5" data-slot="copy-source-folder">
      {scope.loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Checking project and umbrella folders…
        </p>
      ) : (
        umbrella &&
        projectOnly && (
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <span className="flex h-5 items-center">
              <Checkbox
                checked={narrowed}
                disabled={disabled}
                aria-label="Copy only this project folder"
                onCheckedChange={(checked) =>
                  scope.select(checked === true ? projectOnly.copyRoot : umbrella.copyRoot)
                }
              />
            </span>
            <span className="min-w-0 leading-5">
              Copy only this project folder
              <span className="block text-xs text-muted-foreground">
                Otherwise the whole umbrella folder goes, so its repositories stay together.
              </span>
            </span>
          </label>
        )
      )}
      {scope.notice && (
        <p role="status" className="text-xs text-warning-foreground">
          {scope.notice}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Copies <span className="font-mono wrap-anywhere">{scope.selected.copyRoot}</span> from{" "}
        {sourceLabel}. Linked folders and anything outside it stay here.
      </p>
      {scope.selected.projectRelativePath !== "." && scope.selected.repositories.length > 0 && (
        <p className="text-xs text-muted-foreground" data-slot="copy-project-location">
          Includes {scope.selected.repositories.length}
          {scope.selected.truncated ? "+" : ""}{" "}
          {scope.selected.repositories.length === 1 ? "repository" : "repositories"}.
        </p>
      )}
    </div>
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

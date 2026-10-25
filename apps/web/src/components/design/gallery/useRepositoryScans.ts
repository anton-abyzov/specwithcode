/**
 * Read-only design-system scans of project repositories, one per project for
 * as long as the gallery is open. The creation dialogs ask for one when a
 * project has no design system of its own; a dialog reopened later, or
 * switched back to that project, reuses it. Nothing is written.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import type { DesignSystemScanInput, EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { useCallback, useRef, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { designSystemImport } from "~/studio/designSystemImport";

import { failureText } from "../systems/reviewModel";
import type { ScanState } from "./creationSystem";
import { foundSystemsFromScan } from "./foundSystems";

export interface RepositoryScans {
  readonly stateFor: (projectId: ProjectId) => ScanState | null;
  /** Starts a scan unless one ran or runs; `again` repeats a finished one. */
  readonly request: (projectId: ProjectId, again?: boolean) => void;
}

export function useRepositoryScans(environmentId: EnvironmentId): RepositoryScans {
  const scan = useAtomCommand(designSystemImport.scan, { reportFailure: false });
  const [states, setStates] = useState<ReadonlyMap<ProjectId, ScanState>>(() => new Map());
  // The latest states without waiting for a render, so two requests in one tick scan once.
  const known = useRef(new Map<ProjectId, ScanState>());

  const settle = useCallback((projectId: ProjectId, state: ScanState) => {
    known.current.set(projectId, state);
    setStates(new Map(known.current));
  }, []);

  const request = useCallback(
    (projectId: ProjectId, again = false) => {
      const current = known.current.get(projectId);
      if (current?.status === "scanning" || (current !== undefined && !again)) return;
      settle(projectId, { status: "scanning" });
      const input: DesignSystemScanInput = { owner: { kind: "project", projectId }, preview: true };
      void scan({ environmentId, input }).then((result) =>
        settle(
          projectId,
          result._tag === "Success"
            ? {
                status: "done",
                found: foundSystemsFromScan(result.value),
                truncated: result.value.truncated,
              }
            : {
                status: "failed",
                message: failureText(
                  squashAtomCommandFailure(result),
                  "The repository could not be read.",
                ),
              },
        ),
      );
    },
    [environmentId, scan, settle],
  );

  const stateFor = useCallback((projectId: ProjectId) => states.get(projectId) ?? null, [states]);
  return { stateFor, request };
}

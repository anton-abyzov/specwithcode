import { useCallback, useState } from "react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { NewProjectFolderPicker } from "../components/studio/NewProjectFolderPicker";

export function useProjectFolderChoice(environmentId: EnvironmentId | null, busy: boolean) {
  const [choice, setChoice] = useState<{ environmentId: EnvironmentId; path: string } | null>(null);
  const reset = useCallback(() => setChoice(null), []);
  const path = choice?.environmentId === environmentId ? choice.path : null;
  return {
    path,
    reset,
    picker:
      environmentId === null ? null : (
        <NewProjectFolderPicker
          key={environmentId}
          environmentId={environmentId}
          selectedPath={path}
          disabled={busy}
          onSelect={(path) => setChoice({ environmentId, path })}
        />
      ),
  };
}

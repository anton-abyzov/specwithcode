import type { EnvironmentId } from "@specweave-studio/contracts";
import { FolderBrowser } from "./FolderBrowser";

/** Lists folders on one machine. Opening one reports its path. */
export function RemoteFolderBrowser({
  machine,
  start,
  onPick,
  disabled = false,
}: {
  readonly machine: EnvironmentId;
  /** The folder to list first. */
  readonly start: string;
  readonly onPick: (path: string) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div data-slot="handoff-folder-browser">
      <FolderBrowser
        environmentId={machine}
        startPath={start || "~/"}
        disabled={disabled}
        onNavigate={onPick}
      />
    </div>
  );
}

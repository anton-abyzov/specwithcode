import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffFileStatus } from "./DiffFileStatus";

/** Copy and status controls for one file header; re-renders only when its own file changes. */
export function DiffFileHeaderSuffix({
  filePath,
  hasStat,
  error,
  truncated,
  onRetry,
}: {
  filePath: string;
  hasStat: boolean;
  error: boolean;
  truncated: boolean;
  onRetry: (path: string) => void;
}) {
  return (
    <>
      <DiffFilePathCopyButton filePath={filePath} />
      {hasStat ? (
        <DiffFileStatus error={error} truncated={truncated} retry={() => onRetry(filePath)} />
      ) : null}
    </>
  );
}

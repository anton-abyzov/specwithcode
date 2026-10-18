type RestartToUpdateHandler = () => void;

let handler: RestartToUpdateHandler | null = null;

/**
 * Lets the sidebar update button start the same install as the Restart to
 * update pill, so a downloaded update installs from either control.
 */
export function onRestartToUpdateRequest(next: RestartToUpdateHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** False when no Restart to update pill is mounted to take the request. */
export function requestRestartToUpdate(): boolean {
  if (!handler) return false;
  handler();
  return true;
}

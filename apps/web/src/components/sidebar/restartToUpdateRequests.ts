export interface RestartToUpdateRequest {
  /** Only when the install updates the service on this Mac too. */
  readonly requireService?: boolean;
}

/** Starts the install; false when there is nothing (as asked) for it to install. */
type RestartToUpdateHandler = (request: RestartToUpdateRequest) => boolean;

let handler: RestartToUpdateHandler | null = null;

/**
 * Lets the sidebar update pill and Settings start the same install as the
 * Restart to update button, so a downloaded update installs the same way
 * (the service first, then the app) from any control.
 */
export function onRestartToUpdateRequest(next: RestartToUpdateHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * False when no Restart to update button is mounted, or it has nothing to
 * install as asked; the caller then installs on its own.
 */
export function requestRestartToUpdate(request: RestartToUpdateRequest = {}): boolean {
  if (!handler) return false;
  return handler(request);
}

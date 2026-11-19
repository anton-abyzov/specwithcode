/**
 * Which files under the logs folder the storage sweep may remove once they
 * have not been written for the configured days ("Delete rotated logs after").
 *
 * Rotated files (`server.trace.ndjson.3`, `server-child.log.1`) always could
 * go. The logs of one terminal or one agent session (`terminals/*.log`,
 * `provider/*.log`) are written while that terminal or session lives and never
 * again, so nothing rotated them out; they go by the same age. The live trace
 * and server logs, and the provider event log, are never removed: the app
 * holds them open and rotates them by size.
 *
 * @module storageLogRetention
 */

const ROTATED = /\.(?:log|ndjson)\.\d+$/;
const SESSION_LOG = /^(?:terminals|provider)\/[^/]+\.log$/;
const KEPT = new Set(["provider/events.log"]);

/** `relative` is the file's path in the logs folder, with forward slashes. */
export function removableLogFile(relative: string): boolean {
  if (ROTATED.test(relative)) return true;
  return SESSION_LOG.test(relative) && !KEPT.has(relative);
}

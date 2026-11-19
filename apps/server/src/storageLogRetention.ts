/**
 * Which files under the logs folder the storage sweep may remove once they
 * have not been written for the configured days ("Delete rotated logs after").
 *
 * Only rotated files go (`server.trace.ndjson.3`, `server-child.log.1`,
 * `provider/events.log.2`): rotation renames a log away and nothing writes it
 * again. The live trace and server logs, and the log of one terminal or one
 * agent session, are kept: a terminal or session quiet for weeks can still be
 * open, and its writer could append between the age reading and the removal.
 *
 * @module storageLogRetention
 */

const ROTATED = /\.(?:log|ndjson)\.\d+$/;

/** `relative` is the file's path in the logs folder, with forward slashes. */
export function removableLogFile(relative: string): boolean {
  return ROTATED.test(relative);
}

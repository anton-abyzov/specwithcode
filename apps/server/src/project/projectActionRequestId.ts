/** Request ids of the approval cards for project changes; see ProjectActionRequests. */
export const PROJECT_ACTION_REQUEST_PREFIX = "project-action:";

/** Cards whose answer the server applies; agents may not answer them. */
export function isProjectActionRequestId(requestId: string): boolean {
  return requestId.startsWith(PROJECT_ACTION_REQUEST_PREFIX);
}

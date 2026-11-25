/**
 * Whether a page request navigates the tab's main frame. Called from Playwright's event
 * listeners, which run outside any Effect: `frame()` throws for a request that has no frame yet
 * (a service worker's, or a navigation issued before its frame attached), and an uncaught throw
 * there would end the server process, so such a request is simply not a main navigation.
 */
export const isMainFrameNavigation = (
  request: { isNavigationRequest(): boolean; frame(): unknown },
  mainFrame: unknown,
): boolean => {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame() === mainFrame;
  } catch {
    return false;
  }
};

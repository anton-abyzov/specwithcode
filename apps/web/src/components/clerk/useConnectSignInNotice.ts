import type { DesktopBridge, DesktopConnectSignInState } from "@specweave-studio/contracts";
import { useEffect } from "react";

import { toastManager } from "../ui/toast";

/**
 * One notice for a Connect sign-in that continues in the system browser. The
 * desktop app reports each change of state; each one puts a new toast at the
 * front and closes the one before it, so there is one notice and it never
 * stacks. (Updating one toast in place would keep its old position, where
 * newer toasts can cover it or push it past the visible limit.)
 */
export const CONNECT_SIGN_IN_NOTICE_ID = "connect-sign-in";

type ConnectSignInNotice = {
  readonly type: "loading" | "error" | "warning";
  readonly title: string;
  readonly description: string;
};

/** The states that show something. `completed` and `replaced` only take the notice away. */
export const CONNECT_SIGN_IN_NOTICES = {
  waiting: {
    type: "loading",
    title: "Finish signing in in your browser",
    description:
      "The sign-in page opened in your browser. If you don't see it, look for a new browser tab or window. Click the button again to open it again.",
  },
  "open-failed": {
    type: "error",
    title: "Couldn't open your browser",
    description: "Open a browser on this computer, then click the button again.",
  },
  "timed-out": {
    type: "warning",
    title: "Sign-in didn't finish",
    description: "The browser didn't come back within 3 minutes. Click the button again to retry.",
  },
} as const satisfies Partial<Record<DesktopConnectSignInState, ConnectSignInNotice>>;

type ConnectSignInToasts = Pick<typeof toastManager, "add" | "close">;

/** Tracks the one notice on screen. Exported for tests; the app uses the instance below. */
export function createConnectSignInNotice(toasts: ConnectSignInToasts = toastManager) {
  let current: string | null = null;
  let shownCount = 0;
  const dismiss = () => {
    if (current === null) return;
    toasts.close(current);
    current = null;
  };
  const show = (state: DesktopConnectSignInState) => {
    if (state === "completed" || state === "replaced") {
      dismiss();
      return;
    }
    const previous = current;
    shownCount += 1;
    // A new id each time: the toast enters at the front, over the one it replaces.
    current = toasts.add({
      id: `${CONNECT_SIGN_IN_NOTICE_ID}-${shownCount}`,
      ...CONNECT_SIGN_IN_NOTICES[state],
      // Stays until the sign-in finishes, fails, is retried or is dismissed.
      timeout: 0,
      data: {
        // The sign-in dialog is still open and would cover the notice.
        aboveSignInDialog: true,
        // These say what to do; there is no error text worth copying.
        hideCopyButton: true,
      },
    });
    if (previous !== null) toasts.close(previous);
  };
  return { show, dismiss };
}

const connectSignInNotice = createConnectSignInNotice();

type ConnectSignInBridge = Pick<DesktopBridge, "onConnectSignInState">;

/**
 * Mount once inside the desktop's managed-auth shell. A plain browser has no
 * desktop bridge and an older desktop build has no such event: both show
 * nothing, as before.
 *
 * `signedIn` takes the notice away when the person ends up signed in some
 * other way (a password or a passkey after the browser did not come back):
 * the desktop only reports `completed` for a callback from the browser.
 */
export function useConnectSignInNotice(
  signedIn = false,
  bridge: ConnectSignInBridge | undefined = typeof window === "undefined"
    ? undefined
    : window.desktopBridge,
): void {
  const subscribe = bridge?.onConnectSignInState;
  useEffect(() => {
    if (!subscribe) return;
    const unsubscribe = subscribe(connectSignInNotice.show);
    return () => {
      unsubscribe();
      connectSignInNotice.dismiss();
    };
  }, [subscribe]);
  useEffect(() => {
    if (subscribe && signedIn) connectSignInNotice.dismiss();
  }, [subscribe, signedIn]);
}

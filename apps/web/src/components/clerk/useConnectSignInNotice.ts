import type { DesktopBridge, DesktopConnectSignInState } from "@specweave-studio/contracts";
import { useEffect } from "react";

import { toastManager } from "../ui/toast";

/**
 * One notice for a Connect sign-in that continues in the system browser. The
 * desktop app reports each change of state; every state lands on the same
 * toast id, so the notice is replaced in place and never stacks.
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

export function showConnectSignInState(
  state: DesktopConnectSignInState,
  toasts: ConnectSignInToasts = toastManager,
): void {
  if (state === "completed" || state === "replaced") {
    toasts.close(CONNECT_SIGN_IN_NOTICE_ID);
    return;
  }
  toasts.add({
    id: CONNECT_SIGN_IN_NOTICE_ID,
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
}

type ConnectSignInBridge = Pick<DesktopBridge, "onConnectSignInState">;

/**
 * Mount once inside the desktop's managed-auth shell. A plain browser has no
 * desktop bridge and an older desktop build has no such event: both show
 * nothing, as before.
 */
export function useConnectSignInNotice(
  bridge: ConnectSignInBridge | undefined = typeof window === "undefined"
    ? undefined
    : window.desktopBridge,
): void {
  const subscribe = bridge?.onConnectSignInState;
  useEffect(() => {
    if (!subscribe) return;
    const unsubscribe = subscribe((state) => showConnectSignInState(state));
    return () => {
      unsubscribe();
      toastManager.close(CONNECT_SIGN_IN_NOTICE_ID);
    };
  }, [subscribe]);
}

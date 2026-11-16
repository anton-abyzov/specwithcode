import type { DesktopBridge, DesktopConnectSignInState } from "@specweave-studio/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { useConnectSignInNotice } from "../../src/components/clerk/useConnectSignInNotice";
import { ToastProvider, toastManager } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

/*
 * The real notice hook and the real toasts, fed by a stand-in desktop bridge.
 * `window.emitConnectSignInState(state)` plays the desktop app: waiting,
 * replaced, open-failed, timed-out or completed. `window.addOtherToast(title)`
 * adds an unrelated toast, as the app can while a sign-in waits.
 * `?theme=dark` the theme.
 *
 * The sign-in dialog here is a stand-in for the hosted one, which needs a live
 * account service. It copies what matters for the notice: a fixed backdrop
 * over the whole window at z-index 10000 (`@clerk/ui` 1.33.1, zIndices.modal).
 * `?dialog=0` leaves it out.
 */
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

declare global {
  interface Window {
    emitConnectSignInState?: (state: DesktopConnectSignInState) => void;
    addOtherToast?: (title: string) => void;
  }
}

const listeners = new Set<(state: DesktopConnectSignInState) => void>();
window.emitConnectSignInState = (state) => {
  for (const listener of listeners) listener(state);
};
window.addOtherToast = (title) => {
  toastManager.add({ type: "info", title, timeout: 0 });
};
const bridge: Pick<DesktopBridge, "onConnectSignInState"> = {
  onConnectSignInState: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

function SignInDialogStandIn() {
  return (
    <div
      data-testid="sign-in-dialog-stand-in"
      className="fixed inset-0 flex items-start justify-center overflow-auto"
      style={{ zIndex: 10000, backgroundColor: "rgba(0, 0, 0, 0.73)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sign in (stand-in)"
        className="mt-16 w-[25rem] rounded-xl border border-border bg-card p-8 text-card-foreground shadow-xl"
      >
        <h1 className="text-center text-base font-semibold">Sign in to SpecWithCode Connect</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Stand-in for the hosted sign-in dialog
        </p>
        <button
          type="button"
          className="mt-6 flex h-9 w-full items-center justify-center rounded-md border border-border text-sm"
        >
          Continue with Google
        </button>
      </div>
    </div>
  );
}

function Harness() {
  useConnectSignInNotice(false, bridge);
  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <p className="text-sm text-muted-foreground">The app window behind the sign-in dialog.</p>
      {params.get("dialog") === "0" ? null : <SignInDialogStandIn />}
    </div>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <Harness />
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

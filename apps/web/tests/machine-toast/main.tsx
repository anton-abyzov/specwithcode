/* Synthetic data only. One "Input needed" toast through the real ToastProvider, as
   ThreadNotificationCoordinator adds it:
   - `?machine=teal&name=M5`: a toast for another machine, in that machine's colour.
   - no `machine`: a toast for this window's own machine, plain.
   `?theme=dark` for the dark theme, `?dir=rtl` for right-to-left. */
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { MachineColorId } from "@specweave-studio/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";
import { ToastProvider, toastManager } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dir = params.get("dir") === "rtl" ? "rtl" : "ltr";
applyThemePalette("studio-chat", dark ? "dark" : "light");
const color = params.get("machine") as MachineColorId | null;
const name = params.get("name") ?? "M5";

function Alert() {
  useEffect(() => {
    // After the provider's own effect has subscribed to the manager.
    let id: string | undefined;
    const timer = setTimeout(() => {
      id = add();
    }, 50);
    return () => {
      clearTimeout(timer);
      if (id) toastManager.close(id);
    };
  }, []);
  return <div className="fixture-canvas">Weekly metrics report</div>;
}

function add(): string {
  {
    return toastManager.add({
      type: "warning",
      timeout: 0,
      // The machine's name in its colour, as ActionMachineName renders it.
      title: color ? (
        <>
          Input needed on{" "}
          <span
            data-machine-color={color}
            data-action-machine
            className="machine-mark font-semibold"
          >
            {name}
          </span>
        </>
      ) : (
        "Input needed"
      ),
      description: "Release notes draft",
      data: {
        hideCopyButton: true,
        ...(color ? { machineColor: color } : {}),
        leadingIcon: (
          <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
        ),
      },
      actionProps: { children: "Open thread", onClick: () => undefined },
    });
  }
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <Alert />
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

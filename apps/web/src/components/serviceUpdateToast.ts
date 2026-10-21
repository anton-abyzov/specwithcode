import type { ServiceUpdateToastView } from "./sidebar/SidebarRestartToUpdate.logic";
import { hiddenToastActionProps, stackedThreadToast } from "./ui/toast";

/** What the service update's toast does when its buttons are pressed or it is closed. */
export interface ServiceUpdateToastActions {
  /** "Update now" or "Try again". */
  readonly retry: () => void;
  /** "Cancel update". */
  readonly cancel: () => void;
  readonly close: () => void;
}

/** The options of the one persistent toast that follows a service update, for `view`. */
export function serviceUpdateToastOptions(
  view: ServiceUpdateToastView,
  actions: ServiceUpdateToastActions,
) {
  return stackedThreadToast({
    type: view.type,
    title: view.title,
    description: view.description,
    timeout: 0,
    priority: view.type === "error" || view.type === "warning" ? "high" : "low",
    actionProps:
      view.action === null
        ? hiddenToastActionProps
        : {
            children: view.action === "update-now" ? "Update now" : "Try again",
            onClick: actions.retry,
          },
    data: {
      hideCopyButton: view.type !== "error",
      onClose: actions.close,
      ...(view.cancel
        ? { secondaryActionProps: { children: "Cancel update", onClick: actions.cancel } }
        : {}),
    },
  });
}

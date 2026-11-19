import { useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { useLinkMachines } from "./useLinkMachines";
import { unlinkGuard, useUnlinkMember } from "./useUnlinkMember";

/**
 * "Fix…" on a linked machine that still runs a coordinator of its own. It says what is so
 * and offers one action, the unlink of the project's machine settings, behind the same
 * guard and the same confirmation. Nothing touches threads or files, and nothing runs
 * until the person presses it.
 */
export function ExtraCoordinatorFix({
  member,
  coordinator,
  shared,
  projectTitle,
  onOpenSettings = null,
  onClose,
}: {
  /** The machine that runs the extra coordinator. */
  readonly member: EnvironmentProject;
  /** The machine that holds the project's coordinator. */
  readonly coordinator: EnvironmentProject;
  /** Every loaded machine of the project. */
  readonly shared: readonly EnvironmentProject[];
  readonly projectTitle: string;
  /** Opens the project's settings, where its machines are listed; null hides the button. */
  readonly onOpenSettings?: (() => void) | null;
  readonly onClose: () => void;
}) {
  const tx = useTx();
  const machines = useLinkMachines();
  const unlinking = useUnlinkMember();
  const [confirming, setConfirming] = useState(false);
  const machine = machines.label(member.environmentId);
  const main = machines.label(coordinator.environmentId);
  const guard = unlinkGuard(member, shared);
  const problem = machines.problem(member.environmentId);
  // Only a coordinator started beside the project's can be unlinked from here. Any other
  // shape (one it was not started beside, or a machine alone in its list) has no unlink.
  const noUnlink = !guard.allowed && guard.follower === null;
  const names = { machine, project: projectTitle, main };
  const unlink = async () => {
    const said = await unlinking.unlink({ member, coordinator, shared });
    if (!said) return;
    toastManager.add({ type: said.error ? "error" : "success", title: said.text });
    if (!said.error) onClose();
    else setConfirming(false);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !unlinking.busy && onClose()}>
      <DialogPopup
        showCloseButton={!unlinking.busy}
        className="w-full sm:max-w-md"
        data-extra-coordinator-fix={confirming ? "confirm" : "explain"}
      >
        <DialogHeader>
          <DialogTitle>
            {confirming
              ? tx("Unlink {project} on {machine}?", names)
              : tx("Extra coordinator on {machine}", names)}
          </DialogTitle>
          <DialogDescription>
            {confirming
              ? tx(
                  "It becomes its own project again, with an active coordinator and a copy of this project's notes. {main} stops sending it work. Threads and files stay where they are.",
                  names,
                )
              : tx(
                  "{machine} also runs a coordinator for {project}. The project's coordinator is on {main}.",
                  names,
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {confirming ? null : (
            <div className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p data-fix-relink="">
                {tx(
                  "To make {machine} part of this project again, link it afterwards. Linking makes it give way to the coordinator on {main}.",
                  names,
                )}
              </p>
              {guard.follower ? (
                <p data-fix-refused="">
                  {tx(
                    "{other} still follows the coordinator on {machine}. Continue the coordinator on another machine first.",
                    { other: machines.label(guard.follower.environmentId), machine },
                  )}
                </p>
              ) : !guard.allowed ? (
                <p data-fix-refused="">
                  {tx("{machine} cannot be unlinked from this window.", { machine })}
                </p>
              ) : problem ? (
                <p data-fix-refused="">{problem}</p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={unlinking.busy}
            onClick={() => (confirming ? setConfirming(false) : onClose())}
          >
            {tx("Cancel")}
          </Button>
          {confirming ? (
            <Button
              variant="destructive-outline"
              disabled={unlinking.busy}
              data-fix-confirm=""
              onClick={() => void unlink()}
            >
              {unlinking.busy ? tx("Unlinking…") : tx("Unlink")}
            </Button>
          ) : noUnlink ? (
            onOpenSettings ? (
              <Button
                variant="outline"
                data-fix-settings=""
                onClick={() => {
                  onClose();
                  onOpenSettings();
                }}
              >
                {tx("Open project settings")}
              </Button>
            ) : null
          ) : (
            <Button
              variant="destructive-outline"
              // As the unlink button in the project's settings: off while busy or while
              // the machine cannot be changed, with that reason said above.
              disabled={unlinking.busy || !guard.allowed || problem !== null}
              data-fix-unlink=""
              onClick={() => setConfirming(true)}
            >
              {tx("Unlink {project} on {machine}", names)}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

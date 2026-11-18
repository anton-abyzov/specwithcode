import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
} from "@specweave-studio/contracts";
import { useTx } from "../../i18n";
import { useMachineLastSeenVersion } from "../../lib/machineLastSeen";
import { randomUUID } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  mainOffer,
  makeMain,
  makeMainBlockText,
  makeMainPath,
  pendingMainMove,
  requestMainMove,
  subscribeMainMove,
  takeMainMove,
  unloadedMainText,
  type MainOffer,
  type MakeMainMachines,
} from "../../studio/makeMain";
import {
  checkoutKeyEnvironmentId,
  type OrchestratorCopy,
} from "../../studio/projectCoordinatorMachine";
import { projectLink } from "../../studio/projectLink";
import { useRetiredMachineRecords } from "../settings/useReplacedMachineRecords";
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
import { unreachableSince } from "./ProjectMachinesSettings";
import { useLinkMachines } from "./useLinkMachines";

const keyOf = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

/** Told how a switch asked with them ended; exactly one is called, once. */
export interface MainSwitchAfter {
  /** The coordinator continues on that machine now (an offline switch that went through). */
  readonly continued: () => void;
  /** Nothing continued: it was put away, refused, failed, or opened the confirmed move instead. */
  readonly stopped: () => void;
}

export interface MainSwitch {
  /** One "Continue the coordinator here" per machine that has the switch, pressable or off with its reason. */
  readonly offers: readonly MainOffer[];
  /** Runs the switch for that machine; null where the page offers none. */
  readonly run: ((key: string, after?: MainSwitchAfter) => void) | null;
  /** Told when this page's move dialog opens or closes, so a move asked elsewhere returns there. */
  readonly moveOpenChange: (open: boolean) => void;
  /** The confirmation of an offline switch; rendered once by the page. */
  readonly element: ReactNode;
}

/**
 * "Continue the coordinator here" for a project page: which machines have the switch, and
 * what a click does. With the coordinator's machine connected it opens that machine's own
 * confirmed coordinator move (on its page, shown first when the click came from another
 * machine's). With it unreachable for 10 minutes it asks once, then this machine continues
 * the coordinator. It never starts a second coordinator.
 */
export function useMakeMain({
  project,
  members,
  copies,
  enabled,
  openMove,
  onCheckout,
}: {
  /** The copy this page shows. */
  readonly project: EnvironmentProject;
  /** Every checkout in the project's row; the linked ones are picked out per copy. */
  readonly members: readonly EnvironmentProject[];
  /** The same copies as the machine menu names them. */
  readonly copies: readonly OrchestratorCopy[];
  /** Off for a project that never moves (a personal assistant). */
  readonly enabled: boolean;
  /** Opens this page's confirmed coordinator move to that copy; null when it cannot. */
  readonly openMove: ((key: string) => void) | null;
  /** Shows another checkout's page; null until saved choices load. */
  readonly onCheckout: ((key: string) => void) | null;
}): MainSwitch {
  const tx = useTx();
  const machines = useLinkMachines();
  const { environments } = useEnvironments();
  const operate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const files = useEnvironmentsWithScope(environments, AuthFilesystemWriteScope);
  const git = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  const retired = useRetiredMachineRecords();
  const takeover = useAtomCommand(projectLink.takeover, { reportFailure: false });
  const acceptStandby = useAtomCommand(projectLink.acceptStandby, { reportFailure: false });
  useMachineLastSeenVersion();
  const [now, setNow] = useState(Date.now);
  const [confirm, setConfirm] = useState<EnvironmentProject | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  // What the caller of the switch in flight waits for; told once, then dropped.
  const after = useRef<MainSwitchAfter | null>(null);
  const settle = (how: keyof MainSwitchAfter) => {
    const told = after.current;
    after.current = null;
    told?.[how]();
  };
  // A page that goes away tells a waiting caller nothing continued here.
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => () => settleRef.current("stopped"), []);
  const current = keyOf(project);
  const nameOf = (member: EnvironmentProject) =>
    copies.find((copy) => copy.key === keyOf(member))?.machine ??
    machines.label(member.environmentId);
  // A machine whose copy this window has not loaded: named as the menu names it.
  const machineName = (environmentId: EnvironmentProject["environmentId"]) =>
    copies.find((copy) => checkoutKeyEnvironmentId(copy.key) === environmentId)?.machine ??
    machines.label(environmentId);

  const reach: MakeMainMachines = {
    connected: machines.connected,
    unreachableSince: (environmentId) =>
      unreachableSince(environmentId, machines.connected(environmentId), now),
    now,
    canMoveFrom: (environmentId) =>
      operate.has(environmentId) && files.has(environmentId) && git.has(environmentId),
    takeoverReady: machines.takeoverReady,
    retired,
  };
  const offers: MainOffer[] = [];
  if (enabled)
    for (const member of members) {
      const path = makeMainPath(member, members, reach);
      if (path.kind === "none") continue;
      if (path.kind === "unloaded") {
        const offer = mainOffer(keyOf(member), path, {
          machine: nameOf(member),
          main: machineName(path.mainEnvironmentId),
          project: project.title,
        });
        if (offer) offers.push(offer);
        continue;
      }
      // A reachable main forgets when it was last found gone, as Settings does.
      if (machines.connected(path.main.environmentId))
        unreachableSince(path.main.environmentId, true, now);
      // The move runs on main's page: this one's dialog, or main's after showing it.
      if (path.kind === "move" && (keyOf(path.main) === current ? !openMove : !onCheckout))
        continue;
      const offer = mainOffer(keyOf(member), path, {
        machine: nameOf(member),
        main: nameOf(path.main),
      });
      if (offer) offers.push(offer);
    }
  // The clock runs while a switch counts its wait down or says how long the coordinator's
  // machine has been silent, and only then.
  const waiting = offers.some(
    (offer) =>
      (offer.kind === "blocked" && offer.note?.values?.minutes) ||
      (offer.kind === "takeover" && offer.silentMinutes !== undefined),
  );
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, [waiting]);

  // A move asked for on another machine's page lands here, on the coordinator's page, and
  // opens its dialog once.
  const returnTo = useRef<string | null>(null);
  const moveOpened = useRef(false);
  const latest = useRef({ onCheckout, openMove });
  latest.current = { onCheckout, openMove };
  const pending = useSyncExternalStore(
    subscribeMainMove,
    () => pendingMainMove(current),
    () => null,
  );
  useEffect(() => {
    if (!pending) return;
    const move = takeMainMove(current);
    if (!move) return;
    const open = latest.current.openMove;
    if (!open) {
      toastManager.add({
        type: "warning",
        title: tx("The coordinator cannot be handed off from this machine yet."),
        description: tx("Send this project its first message here, then try again."),
      });
      return;
    }
    returnTo.current = move.returnTo;
    moveOpened.current = false;
    open(move.to);
  }, [pending, current, tx]);
  const moveOpenChange = useCallback((open: boolean) => {
    if (open) {
      moveOpened.current = true;
      return;
    }
    // Only a dialog that did open returns: an unmounting page also reports "closed".
    if (!moveOpened.current) return;
    moveOpened.current = false;
    const back = returnTo.current;
    returnTo.current = null;
    if (back) latest.current.onCheckout?.(back);
  }, []);

  const start = (member: EnvironmentProject) =>
    makeMain(member, {
      ...reach,
      members,
      move: (main, copy) => {
        if (keyOf(main) === current) {
          openMove?.(keyOf(copy));
          return;
        }
        requestMainMove({ from: keyOf(main), to: keyOf(copy), returnTo: current });
        onCheckout?.(keyOf(main));
      },
      takeover,
      acceptStandby,
      rearms: (environmentId) =>
        environments.find((item) => item.environmentId === environmentId)?.serverConfig?.environment
          .capabilities.coordinatorRearm === true,
      newOperationId: randomUUID,
    });

  /** Runs the path picked now; the confirmation saw the same copy a moment ago. */
  const runSwitch = async (member: EnvironmentProject) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    const machine = nameOf(member);
    try {
      const outcome = await start(member);
      if (outcome.status === "unloaded") {
        const { reason } = unloadedMainText({
          machine,
          main: machineName(outcome.mainEnvironmentId),
          project: project.title,
        });
        toastManager.add({
          type: "warning",
          title: tx("The coordinator cannot continue on {machine} yet.", { machine }),
          description: tx(reason.text, reason.values),
        });
      } else if (outcome.status === "blocked") {
        const names = { machine, main: nameOf(outcome.main) };
        const { reason } = makeMainBlockText(outcome, names);
        toastManager.add({
          type: "warning",
          title: tx("The coordinator cannot continue on {machine} yet.", { machine }),
          description: tx(reason.text, reason.values),
        });
      } else if (outcome.status === "main") {
        const previous = nameOf(outcome.previous);
        toastManager.add({
          type: "success",
          title: tx("The coordinator continues on {machine}", { machine }),
          description: tx(
            "It starts from the shared goal, memory and plan. The conversation on {main} stays there as history, and {main} gives way when it is back.",
            { main: previous },
          ),
        });
        if (outcome.unclaimed.length > 0) {
          toastManager.add({
            type: "warning",
            title: tx(
              "The coordinator continues on {machine}. {names} have not confirmed it yet.",
              {
                machine,
                names: outcome.unclaimed.join(", "),
              },
            ),
            description: tx(
              "They refuse work from the old coordinator only once they have confirmed the new one.",
            ),
          });
        }
        settle("continued");
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: tx("The coordinator stayed on {main}", {
          main: offers.find((offer) => offer.key === keyOf(member))?.main ?? tx("its machine"),
        }),
        description: cause instanceof Error && cause.message ? cause.message : tx("Retry it."),
      });
    } finally {
      running.current = false;
      setBusy(false);
      setConfirm(null);
      // Anything but a finished offline switch: nothing continued here.
      settle("stopped");
    }
  };

  const run = (key: string, then?: MainSwitchAfter) => {
    const member = members.find((item) => keyOf(item) === key);
    if (!member || running.current) {
      then?.stopped();
      return;
    }
    settle("stopped");
    after.current = then ?? null;
    // An offline switch leaves the old conversation behind, so it asks first. The move
    // has its own review and consent.
    if (makeMainPath(member, members, reach).kind === "takeover") setConfirm(member);
    else void runSwitch(member);
  };

  const confirmOffer = confirm ? offers.find((offer) => offer.key === keyOf(confirm)) : undefined;
  const names = {
    machine: confirmOffer?.machine ?? (confirm ? nameOf(confirm) : ""),
    main: confirmOffer?.main ?? tx("the old machine"),
  };
  const putAway = () => {
    setConfirm(null);
    settle("stopped");
  };
  const element = (
    <Dialog open={confirm !== null} onOpenChange={(open) => !open && !busy && putAway()}>
      <DialogPopup showCloseButton={!busy} className="w-full sm:max-w-md" data-make-main-confirm="">
        <DialogHeader>
          <DialogTitle>{tx("Continue the coordinator on {machine}?", names)}</DialogTitle>
          <DialogDescription>
            {tx(
              "{main} has been offline for 10 minutes or more. The coordinator starts on {machine} from the shared goal, memory and plan. The conversation on {main} stays there as history. Until {main} is back it can still start work on its own machine; then it gives way and lists what it ran meanwhile.",
              names,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={putAway}>
            {tx("Cancel")}
          </Button>
          <Button disabled={busy} onClick={() => confirm && void runSwitch(confirm)}>
            {busy ? tx("Starting the coordinator…") : tx("Continue here")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  return { offers, run: enabled ? run : null, moveOpenChange, element };
}

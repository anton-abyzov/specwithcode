import type { EnvironmentId } from "@specweave-studio/contracts";
import { CheckIcon, LaptopIcon, SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { useTx } from "~/i18n";
import { cn } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import { useMachineNickname } from "~/studio/machineNickname";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { addDevicePlan, type AddDeviceChoice } from "./AddDeviceDialog.logic";
import { scrollToSettingsTarget } from "./settingsLayout";
import {
  MachineNextStepHead,
  MachineSetupState,
  NEXT_STEP_FRAME_CLASS,
  type MachineSetup,
} from "./MachineSummary";

export interface AddDeviceDialogProps {
  /** This machine. Null before the window knows it; the dialog then stays closed. */
  readonly environmentId: EnvironmentId | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The page's setup when it has one; alone, the dialog reads its own while open. */
  readonly setup?: MachineSetup | undefined;
  readonly initialChoice?: AddDeviceChoice | undefined;
  /** Shows a Settings > Machines target: the private pairing row or the join-line fold. */
  readonly onShowFallback: (target: string) => void;
}

/**
 * Shows a target on Settings > Machines when the page is already open: opens
 * the folds around it first, so the join line is not left inside a closed one.
 */
export function showMachinesTarget(targetId: string): void {
  let node = document.getElementById(targetId)?.parentElement ?? null;
  while (node) {
    if (node instanceof HTMLDetailsElement) node.open = true;
    node = node.parentElement;
  }
  scrollToSettingsTarget(targetId);
}

/**
 * "Add a device or machine": one question, a phone or a computer, and for
 * each the code that gets the app and the account to sign in with. Setup that
 * is finished reads as one line, so the dialog only ever shows what is left.
 */
export function AddDeviceDialog(props: AddDeviceDialogProps) {
  const { environmentId, open, onOpenChange, setup } = props;
  return (
    <Dialog open={open && environmentId !== null} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-xl"
        data-testid="add-device-dialog"
        // Focus starts on the chosen kind, so the other one never looks picked.
        initialFocus={() =>
          document.querySelector<HTMLElement>(
            '[data-testid="add-device-dialog"] [role="radio"][aria-checked="true"]',
          )
        }
      >
        {environmentId === null || !open ? null : setup ? (
          <AddDeviceBody {...props} environmentId={environmentId} setup={setup} />
        ) : (
          <MachineSetupState environmentId={environmentId}>
            {(own) => <AddDeviceBody {...props} environmentId={environmentId} setup={own} />}
          </MachineSetupState>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function AddDeviceBody({
  environmentId,
  setup,
  initialChoice = "phone",
  onOpenChange,
  onShowFallback,
}: AddDeviceDialogProps & { readonly environmentId: EnvironmentId; readonly setup: MachineSetup }) {
  const tx = useTx();
  const environment = useEnvironment(environmentId);
  const machine = useMachineNickname(environmentId, environment?.label) || tx("This machine");
  const [choice, setChoice] = useState<AddDeviceChoice>(initialChoice);
  const plan = addDevicePlan({
    choice,
    connect: setup.connect,
    phones: setup.phones,
    machine,
  });
  const noConnect = setup.connect.kind === "unavailable";
  const blocked = setup.lock !== null;
  const showFallback = () => {
    onOpenChange(false);
    onShowFallback(plan.fallback.target);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tx("Add a device or machine")}</DialogTitle>
        <DialogDescription>
          {tx("It signs in with your account and shows up in Settings > Machines by itself.")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div
            role="radiogroup"
            aria-label={tx("What are you adding?")}
            className="grid grid-cols-2 gap-2"
          >
            <ChoiceButton
              selected={choice === "phone"}
              onSelect={() => setChoice("phone")}
              icon={<SmartphoneIcon aria-hidden className="size-4" />}
              title={tx("A phone")}
              detail={tx("iPhone or Android")}
            />
            <ChoiceButton
              selected={choice === "computer"}
              onSelect={() => setChoice("computer")}
              icon={<LaptopIcon aria-hidden className="size-4" />}
              title={tx("A computer")}
              detail={tx("Mac, Windows or Linux")}
            />
          </div>

          {plan.ready ? (
            <p
              data-add-device-ready
              className="flex items-start gap-1.5 text-xs text-muted-foreground"
            >
              <CheckIcon aria-hidden className="mt-px size-3.5 shrink-0 text-success-foreground" />
              <span>{tx(plan.ready.text, plan.ready.values)}</span>
            </p>
          ) : null}

          {blocked ? (
            <p className="text-sm text-muted-foreground">{setup.lock?.message}</p>
          ) : noConnect ? null : plan.needsConnect ? (
            <div data-add-device-step className={NEXT_STEP_FRAME_CLASS}>
              <MachineNextStepHead setup={setup} machineName={machine} />
              <p className="border-t border-border/60 px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
                {tx(
                  "The code to add a device shows here once {machine} is on SpecWithCode Connect.",
                  {
                    machine,
                  },
                )}
              </p>
            </div>
          ) : (
            <div
              data-add-device-choice={choice}
              className="flex flex-col gap-4 rounded-xl border border-border/60 bg-card/60 p-3 sm:flex-row sm:items-start sm:p-4"
            >
              <div className="flex shrink-0 flex-col items-center gap-1 self-center sm:self-start">
                <div className="rounded-lg bg-white p-1.5">
                  <QRCodeSvg
                    value={plan.url}
                    size={120}
                    level="M"
                    marginSize={1}
                    title={
                      choice === "phone"
                        ? tx("Code that opens the App Store or Google Play")
                        : tx("Code that opens the SpecWithCode download page")
                    }
                  />
                </div>
                <span className="text-2xs text-muted-foreground">{plan.shownUrl}</span>
              </div>
              <ol className="flex min-w-0 flex-1 flex-col gap-2.5">
                {plan.steps.map((step, index) => (
                  <li key={step.text} className="flex items-start gap-2.5 text-sm">
                    <span
                      aria-hidden
                      className="mt-px grid size-5 shrink-0 place-items-center rounded-full border border-border text-2xs font-semibold text-muted-foreground"
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0 text-foreground">{tx(step.text, step.values)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-3">
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">
              {noConnect
                ? choice === "phone"
                  ? tx("This build pairs phones over your own network.")
                  : tx("This build adds computers with a join line or a code.")
                : tx(plan.fallback.text.text)}
            </p>
            <Button size="xs" variant={noConnect ? "outline" : "ghost"} onClick={showFallback}>
              {tx(plan.fallback.action.text)}
            </Button>
          </div>
        </div>
      </DialogPanel>
    </>
  );
}

function ChoiceButton({
  selected,
  onSelect,
  icon,
  title,
  detail,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring",
        selected
          ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary/40"
          : "border-border/60 text-muted-foreground hover:bg-accent/50",
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}

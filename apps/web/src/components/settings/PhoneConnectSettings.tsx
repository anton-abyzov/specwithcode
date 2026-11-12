import type { EnvironmentId } from "@specweave-studio/contracts";
import { CheckIcon, SmartphoneIcon } from "lucide-react";
import type { ReactNode } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useTx } from "~/i18n";
import { cn } from "~/lib/utils";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useMachineNickname } from "~/studio/machineNickname";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import {
  isPendingMachineStep,
  MachineNextStepHead,
  MachineSetupState,
  NEXT_STEP_FRAME_CLASS,
  type MachineSetup,
} from "./MachineSummary";
import { PHONE_APP_URL, phoneCardSteps, type PhoneCardStep } from "./PhoneConnect.logic";
import { PhoneDevicesSettings } from "./PhoneDevicesSettings";
import { SettingsSection, TeamRulesLabel } from "./settingsLayout";

/** Whether this window shows the Connect phone card: any window of a build with Connect. */
export function isPhoneConnectShown(): boolean {
  return hasCloudPublicConfig();
}

/**
 * "Your phone": three steps to reach this machine from an iPhone or an Android
 * phone through SpecWithCode Connect, worded from the live state. A browser
 * shows it too, with the state read from the machine. The page hands in the
 * setup it already read; alone, the card reads its own.
 */
export function PhoneConnectSettings({
  setup,
  pairRow,
}: {
  readonly setup?: MachineSetup | undefined;
  /** The quiet row for pairing over the person's own network, drawn last in the card. */
  readonly pairRow?: ReactNode;
}) {
  const environmentId = usePrimaryEnvironmentId();
  if (!isPhoneConnectShown() || environmentId === null) return null;
  if (setup) return <YourPhoneCard environmentId={environmentId} setup={setup} pairRow={pairRow} />;
  return (
    <MachineSetupState environmentId={environmentId}>
      {(own) => <YourPhoneCard environmentId={environmentId} setup={own} pairRow={pairRow} />}
    </MachineSetupState>
  );
}

function YourPhoneCard({
  environmentId,
  setup,
  pairRow,
}: {
  readonly environmentId: EnvironmentId;
  readonly setup: MachineSetup;
  readonly pairRow?: ReactNode;
}) {
  const tx = useTx();
  const environment = useEnvironment(environmentId);
  const machine = useMachineNickname(environmentId, environment?.label) || tx("This machine");
  const { connect, lock } = setup;
  const steps = phoneCardSteps({ connect, phones: setup.phones, machine });
  // Signing in and turning Connect on stay the person's to do when a rule only keeps phones off.
  const connectStep =
    (setup.step.kind === "sign-in" || setup.step.kind === "turn-on") && !setup.connectLocked;
  const pending = isPendingMachineStep(setup.step) && (lock === null || connectStep);
  // A failed read is the one state where the card's own button is the way on.
  const failed = lock === null && connect.kind === "unknown";
  // Finished steps fold away: the summary above already says Connect is on and how many
  // phones are linked, so once all three are done the card is only the list of phones.
  const left = failed ? steps : steps.filter((step) => step.state !== "done");

  return (
    <SettingsSection
      id="phone-connect"
      title={left.length === 0 ? "Phones" : "Your phone"}
      variant="plain"
      icon={<SmartphoneIcon aria-hidden className="size-4" />}
    >
      <div
        data-phone-card={pending ? setup.step.kind : failed ? "failed" : lock ? "locked" : "plain"}
        className={cn(
          pending
            ? NEXT_STEP_FRAME_CLASS
            : "overflow-hidden rounded-xl border border-border/60 bg-card/60",
        )}
      >
        {pending ? <MachineNextStepHead setup={setup} machineName={machine} /> : null}
        {lock ? (
          <div
            className={cn(
              "flex flex-wrap items-center gap-2 px-3 py-3 text-sm sm:px-4",
              pending && "border-t border-border/60",
            )}
          >
            <p className="min-w-0 flex-1 text-muted-foreground">{lock.message}</p>
            <TeamRulesLabel>{lock.setBy}</TeamRulesLabel>
          </div>
        ) : left.length === 0 ? null : (
          <ol className={cn("divide-y divide-border/60", pending && "border-t border-border/60")}>
            {left.map((step, index) => (
              <PhoneStep key={step.title.text} index={index + 1} step={step}>
                {index === 0 && failed ? (
                  <Button type="button" size="sm" onClick={setup.retry}>
                    {tx("Try again")}
                  </Button>
                ) : null}
              </PhoneStep>
            ))}
          </ol>
        )}
        {(lock === null || pending) && setup.error ? (
          <p
            role="alert"
            className="border-t border-border/60 px-3 py-2 text-xs text-destructive-foreground sm:px-4"
          >
            {setup.error}
          </p>
        ) : null}
        {/* Removing a phone only takes access away, so the list stays under a lock too. */}
        <PhoneDevicesSettings />
        {pairRow ? <div className="border-t border-border/60 bg-muted/40">{pairRow}</div> : null}
      </div>
    </SettingsSection>
  );
}

function PhoneStep({
  index,
  step,
  children,
}: {
  readonly index: number;
  readonly step: PhoneCardStep;
  readonly children?: ReactNode;
}) {
  const tx = useTx();
  return (
    <li
      data-phone-step={index}
      data-state={step.state}
      aria-current={step.state === "current" ? "step" : undefined}
      className="flex items-start gap-3 px-3 py-3 sm:px-4"
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
          step.state === "done"
            ? "bg-success/15 text-success-foreground"
            : step.state === "current"
              ? "bg-primary text-primary-foreground"
              : "border border-border text-muted-foreground",
        )}
      >
        {step.state === "done" ? <CheckIcon className="size-3" /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {step.state === "done" ? <span className="sr-only">{tx("Done:")} </span> : null}
          {tx(step.title.text, step.title.values)}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {tx(step.body.text, step.body.values)}
        </p>
      </div>
      {step.storeCode ? (
        <div className="flex shrink-0 flex-col items-center gap-1">
          <div className="rounded-lg bg-white p-1.5">
            <QRCodeSvg
              value={PHONE_APP_URL}
              size={104}
              level="M"
              marginSize={1}
              title={tx("Code that opens the App Store or Google Play")}
            />
          </div>
          <span className="text-[11px] text-muted-foreground">{tx("App Store · Google Play")}</span>
        </div>
      ) : null}
      {children}
    </li>
  );
}

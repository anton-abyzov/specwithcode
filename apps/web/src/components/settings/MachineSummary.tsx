import { useAuth, useUser } from "@clerk/react";
import {
  AuthRelayWriteScope,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { CheckIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { useManagedRelayPhones } from "../../cloud/managedRelayState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useCloudLinkController } from "../../cloud/useCloudLinkController";
import { useRememberConnectChoice } from "../../cloud/useRememberConnectChoice";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { useTx } from "../../i18n";
import { cn } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useMachineNickname } from "../../studio/machineNickname";
import { teamRulesReachLock, type TeamRulesLock } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { resolveServerConfigVersionMismatch } from "../../versionSkew";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { ENVIRONMENT_MACHINE_KIND_LABELS, EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import {
  isPhoneStepDismissed,
  machineConnect,
  machineFacts,
  machineNextStep,
  machineNextStepTitle,
  machinePhones,
  machineRole,
  machineRoleLabel,
  machineVersionLabel,
  machineVersionState,
  withPhoneStepDismissed,
  type MachineConnect,
  type MachineNextStep,
  type MachinePhones,
  type MachineRoleRow,
} from "./machineNextStep.logic";
import { RenameMachineDialog } from "./RenameMachineDialog";
import { AddDeviceDialog, showMachinesTarget } from "./AddDeviceDialog";

/** This machine's setup, read once for the page: its link, its phones and the one next step. */
export interface MachineSetup {
  readonly connect: MachineConnect;
  readonly connectLocked: boolean;
  /** The rule that keeps phones off this machine, or it off SpecWithCode Connect. */
  readonly lock: TeamRulesLock | null;
  readonly phones: MachinePhones;
  readonly step: MachineNextStep;
  /** Why the link could not be read or changed, in the server's words. */
  readonly error: string | null;
  /** Reads the link again after a failed read. */
  readonly retry: () => void;
  /** A sign-in or a switch started from the next step is in flight. */
  readonly busy: boolean;
  readonly signIn: () => void;
  readonly turnOn: () => void;
  /** "Not now" on the phone step: hidden for this machine and remembered. */
  readonly dismissPhoneStep: () => void;
}

const NO_CONNECT: MachineConnect = { kind: "unavailable" };
/** How often the phone list is read while the page waits for a phone (under AC-28's 10 seconds). */
export const PHONE_POLL_MS = 5_000;
const nothing = () => {};

/**
 * Reads this machine's setup and hands it to the page, so the summary, the
 * phone card and the page's order all draw from one answer. A build without
 * SpecWithCode Connect has no steps to offer.
 */
export function MachineSetupState({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: (setup: MachineSetup) => ReactNode;
}) {
  return hasCloudPublicConfig() ? (
    <ConfiguredMachineSetupState environmentId={environmentId}>
      {children}
    </ConfiguredMachineSetupState>
  ) : (
    children({
      connect: NO_CONNECT,
      connectLocked: false,
      lock: null,
      phones: null,
      step: { kind: "done" },
      error: null,
      retry: nothing,
      busy: false,
      signIn: nothing,
      turnOn: nothing,
      dismissPhoneStep: nothing,
    })
  );
}

function ConfiguredMachineSetupState({
  environmentId,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly children: (setup: MachineSetup) => ReactNode;
}) {
  // A pending sign-in must not read as signed out, or the step would ask to sign in again.
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { linkState, linked, publishAgentActivity, operationError, reconcileCloudState } =
    useCloudLinkController();
  const phoneList = useManagedRelayPhones();
  const canManageRelay = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const { summary: teamRules } = useTeamRules(environmentId);
  const { openAuthPrompt } = useStudioConnectAuthPrompt();
  const rememberConnectChoice = useRememberConnectChoice();
  const dismissed = useClientSettings((settings) => settings.machinePhoneStepDismissed);
  const updateClientSettings = useUpdateClientSettings();
  const [busy, setBusy] = useState(false);

  const connect = machineConnect({
    configured: true,
    authLoaded: isLoaded,
    signedIn: isSignedIn === true,
    account: user?.primaryEmailAddress?.emailAddress ?? null,
    link: linkState.data,
    linkPending: linkState.isPending,
  });
  const connectLock = teamRulesReachLock(teamRules, "connect");
  const phonesLock = teamRulesReachLock(teamRules, "phones");
  const phones = machinePhones({
    accountId: phoneList.accountId,
    phones: phoneList.data,
    pending: phoneList.isPending,
  });
  const step = machineNextStep({
    connect,
    // Only the desktop app runs this machine's link, and only with leave to manage it.
    canChangeConnect: window.desktopBridge !== undefined && canManageRelay,
    connectLocked: connectLock !== null,
    phonesLocked: phonesLock !== null,
    phones,
    phoneStepDismissed: isPhoneStepDismissed(dismissed, environmentId),
  });

  // While the page waits for a phone, its row appears by itself within seconds of the sign-in.
  const waitingForPhone = step.kind === "add-phone";
  const refreshPhones = phoneList.refresh;
  useEffect(() => {
    if (!waitingForPhone) return;
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        refreshPhones();
      }
    }, PHONE_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingForPhone, refreshPhones]);

  const turnOn = () => {
    if (busy) return;
    setBusy(true);
    // A link the owner shaped keeps its activity choice; a first link publishes so the phone gets alerts.
    void reconcileCloudState({
      managedTunnel: true,
      publish: linked ? publishAgentActivity : true,
    })
      .then((ok) => {
        // Turned on from here: an earlier off no longer holds a sign-in back.
        if (ok) rememberConnectChoice(true);
      })
      .finally(() => setBusy(false));
  };

  return children({
    connect,
    connectLocked: connectLock !== null,
    // A phone reaches the machine over Connect, so either rule stops the phone card.
    lock: phonesLock ?? connectLock,
    phones,
    step,
    error: operationError ?? linkState.error,
    retry: linkState.refresh,
    busy,
    // The sign-in itself turns Connect on for this machine (see `connectAtSignIn`).
    signIn: openAuthPrompt,
    turnOn,
    dismissPhoneStep: () =>
      void updateClientSettings({
        machinePhoneStepDismissed: withPhoneStepDismissed(dismissed, environmentId),
      }),
  });
}

/**
 * The top of Settings > Machines: this machine's name, kind, role and version,
 * then three facts, the only place the page states them. It holds no primary
 * button; the next step does. "Add a device or machine" opens the add dialog.
 */
export function MachineSummary({
  environmentId,
  rows,
  setup,
}: {
  readonly environmentId: EnvironmentId;
  /** The page's machine rows; the role and the count of other machines come from them. */
  readonly rows: ReadonlyArray<MachineRoleRow>;
  readonly setup: MachineSetup;
}) {
  const tx = useTx();
  const environment = useEnvironment(environmentId);
  const name = useMachineNickname(environmentId, environment?.label) || tx("This machine");
  const chosen = useClientSettings((settings) => settings.onboardingMachineRole);
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const serverConfig = environment?.serverConfig ?? null;
  const kind = serverConfig ? resolveEnvironmentMachineKind(serverConfig) : "desktop";
  const role = machineRoleLabel(machineRole({ rows, chosen }));
  const version = machineVersionLabel(
    machineVersionState({
      serverVersion: serverConfig?.environment.serverVersion ?? null,
      mismatch: resolveServerConfigVersionMismatch(serverConfig),
    }),
  );
  const facts = machineFacts({
    connect: setup.connect,
    connectLocked: setup.connectLocked,
    phones: setup.phones,
    otherMachines: rows.filter((row) => row.seen.state !== "this-machine").length,
  });
  const about = [
    tx(ENVIRONMENT_MACHINE_KIND_LABELS[kind]),
    tx(role.text, role.values),
    version ? tx(version.text, version.values) : null,
  ].filter((part): part is string => part !== null);

  return (
    <section
      aria-label={tx("This machine")}
      data-machine-summary
      className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/60 px-3 py-3 sm:px-4 sm:py-4"
    >
      <EnvironmentMachineIcon
        aria-hidden
        kind={kind}
        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 className="truncate text-[15px] font-semibold text-foreground" data-machine-name>
            {name}
          </h2>
          <span className="text-xs text-muted-foreground" data-machine-about>
            {about.join(" · ")}
          </span>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {facts.map((fact) => (
            <li
              key={fact.key}
              data-machine-fact={fact.key}
              data-ok={fact.ok}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                fact.ok
                  ? "border-success/30 bg-success/10 text-success-foreground"
                  : "border-border/60 text-muted-foreground",
              )}
            >
              {fact.ok ? <CheckIcon aria-hidden className="size-3 shrink-0" /> : null}
              <span className="truncate">{tx(fact.text, fact.values)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
        <Button type="button" variant="outline" size="xs" onClick={() => setAdding(true)}>
          <PlusIcon aria-hidden className="size-3.5" />
          {tx("Add a device or machine")}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={() => setRenaming(true)}>
          {tx("Rename")}
        </Button>
      </div>
      <AddDeviceDialog
        environmentId={environmentId}
        open={adding}
        onOpenChange={setAdding}
        setup={setup}
        onShowFallback={showMachinesTarget}
      />
      <RenameMachineDialog
        environmentId={environmentId}
        hostLabel={environment?.label ?? tx("This machine")}
        open={renaming}
        onOpenChange={setRenaming}
      />
    </section>
  );
}

/** Whether a step is one the person still has to take, as opposed to read or done. */
export function isPendingMachineStep(step: MachineNextStep): boolean {
  return step.kind === "sign-in" || step.kind === "turn-on" || step.kind === "add-phone";
}

/**
 * The head of the one next step: its label, its name and the page's only
 * primary button. A window that cannot take the step says where to. Draws
 * nothing unless a step is pending.
 */
export function MachineNextStepHead({
  setup,
  machineName,
}: {
  readonly setup: MachineSetup;
  /** This machine's name, for a window that cannot take the step itself. */
  readonly machineName: string;
}) {
  const tx = useTx();
  const { step } = setup;
  const title = machineNextStepTitle(step);
  if (title === null || !isPendingMachineStep(step)) return null;
  const cannotAct = (step.kind === "sign-in" || step.kind === "turn-on") && !step.canAct;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
      <span className="text-[11px] font-semibold tracking-wide text-primary uppercase">
        {tx("Next step")}
      </span>
      <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tx(title)}</h2>
      {step.kind === "add-phone" ? (
        <>
          <span role="status" className="text-xs font-medium text-muted-foreground">
            {tx("Waiting for your phone…")}
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={setup.dismissPhoneStep}>
            {tx("Not now")}
          </Button>
        </>
      ) : cannotAct ? (
        <span className="text-xs text-muted-foreground" data-machine-next-step-where>
          {tx("Open SpecWithCode on {machine} to do this.", { machine: machineName })}
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          disabled={setup.busy}
          onClick={step.kind === "sign-in" ? setup.signIn : setup.turnOn}
        >
          {step.kind === "sign-in" ? tx("Sign in") : setup.busy ? tx("Turning on…") : tx("Turn on")}
        </Button>
      )}
    </div>
  );
}

/** The frame a pending step is drawn in, here and on the phone card. */
export const NEXT_STEP_FRAME_CLASS =
  "overflow-hidden rounded-xl border border-primary/40 bg-card/60 ring-2 ring-primary/15";

/**
 * The one next step as a card of its own. `children` is the body of the
 * step. It draws nothing while the state is read or once every step is done.
 */
export function MachineNextStepCard({
  setup,
  machineName,
  children,
}: {
  readonly setup: MachineSetup;
  readonly machineName: string;
  readonly children?: ReactNode;
}) {
  const tx = useTx();
  const { step } = setup;
  // Once every step is done the summary's facts say so; a separate line would repeat them.
  if (step.kind === "loading" || step.kind === "done") return null;
  return (
    <section data-machine-next-step={step.kind} className={NEXT_STEP_FRAME_CLASS}>
      <MachineNextStepHead setup={setup} machineName={machineName} />
      {children ? <div className="border-t border-border/60">{children}</div> : null}
    </section>
  );
}

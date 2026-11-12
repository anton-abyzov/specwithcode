import { AuthStandardClientScopes, EnvironmentId } from "@specweave-studio/contracts";
import type { ReactNode } from "react";

import { AddDeviceDialog } from "../../src/components/settings/AddDeviceDialog";
import { MachineSummary, type MachineSetup } from "../../src/components/settings/MachineSummary";
import { PairPhoneSettings } from "../../src/components/settings/PairPhoneSettings";
import {
  isPhoneConnectShown,
  PhoneConnectSettings,
} from "../../src/components/settings/PhoneConnectSettings";
import {
  CloudLinkRow,
  ThisMachineAdvanced,
} from "../../src/components/settings/ThisMachineAdvanced";
import { SettingsSection } from "../../src/components/settings/settingsLayout";
import { ACCOUNT, pageState, readOnlyWindow } from "./page-mocks";

const here = EnvironmentId.make("env-m4");
const nothing = () => undefined;

/**
 * This machine's setup for each `?state=`:
 * `sign-in`, `sign-in-browser` (a window that cannot change it), `turn-on`,
 * `add-phone` (the default), `done` (a phone is linked) and `no-connect`
 * (a build without SpecWithCode Connect).
 */
export function setupFor(state: string): MachineSetup {
  const base = {
    connectLocked: false,
    lock: null,
    error: null,
    retry: nothing,
    busy: false,
    signIn: nothing,
    turnOn: nothing,
    dismissPhoneStep: nothing,
  };
  switch (state) {
    case "sign-in":
    case "sign-in-browser":
      return {
        ...base,
        connect: { kind: "signed-out" },
        phones: null,
        step: { kind: "sign-in", canAct: state === "sign-in" },
      };
    case "turn-on":
      return {
        ...base,
        connect: { kind: "off", account: ACCOUNT },
        phones: 0,
        step: { kind: "turn-on", canAct: true },
      };
    case "done":
      return {
        ...base,
        connect: { kind: "on", account: ACCOUNT },
        phones: 1,
        step: { kind: "done" },
      };
    case "no-connect":
      return { ...base, connect: { kind: "unavailable" }, phones: null, step: { kind: "done" } };
    default:
      return {
        ...base,
        connect: { kind: "on", account: ACCOUNT },
        phones: 0,
        step: { kind: "add-phone" },
      };
  }
}

const roleRows = [
  { label: "MacBook Air", seen: { state: "this-machine" }, workers: null, workHere: null },
  {
    label: "Windows PC",
    seen: { state: "connected" },
    workers: { status: "allowed" as const },
    workHere: null,
  },
];

/** A section the fixture names without drawing: its own fixture or test covers it. */
function Named({ title, children }: { title: string; children: string }) {
  return (
    <SettingsSection title={title}>
      <p className="px-3 py-2.5 text-sm text-muted-foreground sm:px-4">{children}</p>
    </SettingsSection>
  );
}

/**
 * Settings > Machines in the order the page draws it, with the real summary,
 * phone card, pairing row and Advanced fold. The machine cards come from the
 * rows view; the two sections named in words have their own checks.
 */
export function MachinesPage({ hereCard, others }: { hereCard: ReactNode; others: ReactNode }) {
  const setup = setupFor(pageState);
  const pairRow = (
    <PairPhoneSettings
      endpoint={null}
      serverEndpoints={
        pageState === "done"
          ? ([{ httpBaseUrl: "http://192.168.1.20:3773", kind: "lan" }] as never)
          : undefined
      }
      canCreateLinks={!readOnlyWindow}
      delegatableScopes={AuthStandardClientScopes}
      onPairingLinkCreated={nothing}
      hasAccessControls={!readOnlyWindow}
      onShowAccessSettings={nothing}
      onTurnOnNetworkAccess={readOnlyWindow ? undefined : nothing}
      folded={isPhoneConnectShown()}
    />
  );
  return (
    // The page container draws the settings scope line, which needs the router; the column is the same.
    <div data-page-state={pageState} className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <>
        <MachineSummary environmentId={here} rows={roleRows} setup={setup} />
        <details data-machine-here-details className="rounded-xl border border-border/60">
          <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium sm:px-4">
            Projects and accounts on this machine
          </summary>
          <ul>{hereCard}</ul>
        </details>
        {isPhoneConnectShown() ? <PhoneConnectSettings setup={setup} pairRow={pairRow} /> : pairRow}
        <SettingsSection title="Other machines">
          <ul className="divide-y divide-border/60">{others}</ul>
        </SettingsSection>
        <Named title="Let another of your machines run work here">
          The account's other machines, with Allow. Drawn by the incoming-worker-access fixture.
        </Named>
        <Named title="Who can run work here">
          The machines that may start work on this one. Covered by its own tests.
        </Named>
        <ThisMachineAdvanced>
          <SettingsSection title="MacBook Air" literal>
            <CloudLinkRow canReadRelay={!readOnlyWindow} canManageRelay={!readOnlyWindow} />
          </SettingsSection>
          <Named title="Saved connections">
            Machines this app reaches by a pairing link or over SSH.
          </Named>
        </ThisMachineAdvanced>
      </>
    </div>
  );
}

/**
 * `?view=add-device&state=done&tab=computer`: the add dialog open over an
 * empty page, as the account menu opens it, for each setup state.
 */
export function AddDevicePage({ tab }: { tab: "phone" | "computer" }) {
  return (
    <AddDeviceDialog
      environmentId={here}
      open
      onOpenChange={nothing}
      setup={setupFor(pageState)}
      initialChoice={tab}
      onShowFallback={nothing}
    />
  );
}

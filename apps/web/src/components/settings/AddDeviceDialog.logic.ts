import type { MachineConnect, MachinePhones, MachinePhrase } from "./machineNextStep.logic";
import { PHONE_APP_URL } from "./PhoneConnect.logic";

/** Where a new computer gets the desktop app: macOS, Windows and Linux. */
export const DESKTOP_APP_URL = "https://specwithcode.com/download";

/** What the person is adding. */
export type AddDeviceChoice = "phone" | "computer";

/** Settings > Machines targets the dialog's fallbacks lead to. */
export const PRIVATE_PAIRING_TARGET = "phone-connect";
/** The join-line form inside "Another account, or no Connect"; landing on it opens the fold. */
export const OTHER_ACCOUNT_TARGET = "private-machines-add";

export interface AddDevicePlan {
  /**
   * What is in place already, as one line, so finished setup reads as done
   * instead of as a checklist. Null while this machine is not on Connect.
   */
  readonly ready: MachinePhrase | null;
  /** Connect is the way in: until it is on, the dialog shows that step instead. */
  readonly needsConnect: boolean;
  /** The link the code opens, for the choice. */
  readonly url: string;
  /** The link as a person types it. */
  readonly shownUrl: string;
  /** What to do on the new device, in order. */
  readonly steps: ReadonlyArray<MachinePhrase>;
  /** The way in without Connect or for another account, as the quiet last line. */
  readonly fallback: {
    readonly text: MachinePhrase;
    readonly action: MachinePhrase;
    readonly target: string;
  };
}

/**
 * The add dialog's content for a phone or a computer, worded from this
 * machine's Connect state. Adding either one takes no step on this machine:
 * the new device signs in with the same account and shows up by itself.
 */
export function addDevicePlan(input: {
  readonly choice: AddDeviceChoice;
  readonly connect: MachineConnect;
  readonly phones: MachinePhones;
  /** This machine's name. */
  readonly machine: string;
}): AddDevicePlan {
  const { choice, connect, machine } = input;
  const account = connect.kind === "on" || connect.kind === "off" ? connect.account : null;
  const on = connect.kind === "on";
  const phones = typeof input.phones === "number" ? input.phones : 0;
  const ready: MachinePhrase | null = !on
    ? null
    : choice === "phone" && phones > 0
      ? {
          text:
            phones === 1
              ? "{machine} is on SpecWithCode Connect as {account}. 1 phone linked."
              : "{machine} is on SpecWithCode Connect as {account}. {count} phones linked.",
          values: { machine, account: account ?? "", count: phones },
        }
      : {
          text: "{machine} is on SpecWithCode Connect as {account}.",
          values: { machine, account: account ?? "" },
        };
  const signIn: MachinePhrase =
    account !== null
      ? { text: "Sign in as {account}.", values: { account } }
      : { text: "Sign in with the same account as here." };
  if (choice === "phone")
    return {
      ready,
      needsConnect: connect.kind !== "unavailable" && !on,
      url: PHONE_APP_URL,
      shownUrl: "specwithcode.com/get",
      steps: [
        {
          text: "Scan the code with the phone's camera. It opens the App Store on an iPhone and Google Play on Android.",
        },
        signIn,
        {
          text: "{machine} shows up on the phone by itself, and the phone shows up here.",
          values: { machine },
        },
      ],
      fallback: {
        text: { text: "Cannot use Connect? Pair over your own network." },
        action: { text: "Pair with a private QR code" },
        target: PRIVATE_PAIRING_TARGET,
      },
    };
  return {
    ready,
    needsConnect: connect.kind !== "unavailable" && !on,
    url: DESKTOP_APP_URL,
    shownUrl: "specwithcode.com/download",
    steps: [
      { text: "On the new computer, open specwithcode.com/download and install SpecWithCode." },
      signIn,
      {
        text: "Pick {machine} as the main machine and press Allow there. It shows up here by itself.",
        values: { machine },
      },
    ],
    fallback: {
      text: { text: "Another account, or no Connect? Use a join line or a code." },
      action: { text: "Use a join line" },
      target: OTHER_ACCOUNT_TARGET,
    },
  };
}

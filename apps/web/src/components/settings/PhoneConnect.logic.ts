import type { MachineConnect, MachinePhones, MachinePhrase } from "./machineNextStep.logic";

/**
 * Where the phone card's store code leads: one page that sends an iPhone to
 * the App Store and an Android phone to Google Play.
 */
export const PHONE_APP_URL = "https://specwithcode.com/get";

/**
 * Set by the phone card of earlier versions when a sign-in started from it.
 * This card no longer sets it: the sign-in itself turns SpecWithCode Connect
 * on (see `connectAtSignIn`). The key stays because the sign-in still reads it.
 */
export const PHONE_CONNECT_PENDING_KEY = "specwithcode.phone-connect.pending";

export type PhoneStepState = "done" | "current" | "todo";

export interface PhoneCardStep {
  readonly state: PhoneStepState;
  readonly title: MachinePhrase;
  readonly body: MachinePhrase;
  /** The step shows the code that opens the phone's app store. */
  readonly storeCode: boolean;
}

/**
 * The three lines of "Your phone", worded from the live state: this machine
 * on SpecWithCode Connect, the app on the phone, the same sign-in there.
 * `machine` is this machine's name. The words are the table in the
 * increment's `phone-copy.md`, which the phone apps use too.
 */
export function phoneCardSteps(input: {
  readonly connect: MachineConnect;
  readonly phones: MachinePhones;
  readonly machine: string;
}): readonly [PhoneCardStep, PhoneCardStep, PhoneCardStep] {
  const { connect, machine } = input;
  const on = connect.kind === "on";
  const account = connect.kind === "on" || connect.kind === "off" ? connect.account : null;
  const hasPhone = on && typeof input.phones === "number" && input.phones > 0;
  return [
    { ...connectStep(connect, machine), storeCode: false },
    on
      ? {
          state: hasPhone ? "done" : "current",
          title: { text: "Get SpecWithCode on your phone" },
          body: hasPhone
            ? {
                text: "To add another phone, scan this with its camera. It opens the App Store on an iPhone and Google Play on Android.",
              }
            : {
                text: "Scan this with the phone's camera. It opens the App Store on an iPhone and Google Play on Android. Or search the store for “SpecWithCode”.",
              },
          storeCode: true,
        }
      : {
          state: "todo",
          title: { text: "Get SpecWithCode on your phone" },
          body: {
            text: "iPhone or Android. The store code shows here once this machine is on SpecWithCode Connect.",
          },
          storeCode: false,
        },
    {
      state: hasPhone ? "done" : "todo",
      title:
        on && account !== null
          ? { text: "Sign in on the phone as {account}", values: { account } }
          : { text: "Sign in on the phone with the same account" },
      body: on
        ? {
            text: "{machine} shows up on the phone by itself, and the phone shows up here. Nothing to scan or type.",
            values: { machine },
          }
        : { text: "{machine} shows up there by itself.", values: { machine } },
      storeCode: false,
    },
  ];
}

function connectStep(connect: MachineConnect, machine: string): Omit<PhoneCardStep, "storeCode"> {
  switch (connect.kind) {
    case "on":
      return {
        state: "done",
        title: { text: "{machine} is on SpecWithCode Connect", values: { machine } },
        body:
          connect.account === null
            ? { text: "Reachable from anywhere, by its account only." }
            : {
                text: "Linked as {account}. Reachable from anywhere, by your account only.",
                values: { account: connect.account },
              },
      };
    case "off":
      return {
        state: "current",
        title: { text: "Turn on SpecWithCode Connect for {machine}", values: { machine } },
        body:
          connect.account === null
            ? { text: "It gets a private address that only your account can use." }
            : {
                text: "Signed in as {account}. It gets a private address that only your account can use.",
                values: { account: connect.account },
              },
      };
    case "signed-out":
      return {
        state: "current",
        title: { text: "Sign in to SpecWithCode Connect" },
        body: {
          text: "It links {machine} to your account in the same click. No VPN, open ports or terminal.",
          values: { machine },
        },
      };
    case "loading":
      return {
        state: "todo",
        title: { text: "Checking SpecWithCode Connect…" },
        body: { text: "One moment." },
      };
    case "unknown":
      return {
        state: "current",
        title: { text: "Could not check SpecWithCode Connect" },
        body: { text: "Try again in a moment." },
      };
    case "unavailable":
      return {
        state: "todo",
        title: { text: "SpecWithCode Connect is not in this build" },
        body: { text: "Pair over your own network instead." },
      };
  }
}

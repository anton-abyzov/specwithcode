import { describe, expect, it } from "vite-plus/test";

import {
  addDevicePlan,
  DESKTOP_APP_URL,
  OTHER_ACCOUNT_TARGET,
  PRIVATE_PAIRING_TARGET,
} from "./AddDeviceDialog.logic";
import { PHONE_APP_URL } from "./PhoneConnect.logic";

const on = { kind: "on", account: "sam@example.com" } as const;
const machine = "M4";

describe("addDevicePlan", () => {
  it("gives a phone the store code, the account and the private QR as the way around", () => {
    const plan = addDevicePlan({ choice: "phone", connect: on, phones: 0, machine });
    expect(plan.needsConnect).toBe(false);
    expect(plan.url).toBe(PHONE_APP_URL);
    expect(plan.shownUrl).toBe("specwithcode.com/get");
    expect(plan.steps.map((step) => step.text)).toEqual([
      "Scan the code with the phone's camera. It opens the App Store on an iPhone and Google Play on Android.",
      "Sign in as {account}.",
      "{machine} shows up on the phone by itself, and the phone shows up here.",
    ]);
    expect(plan.steps[1]!.values).toEqual({ account: "sam@example.com" });
    expect(plan.fallback.target).toBe(PRIVATE_PAIRING_TARGET);
    expect(plan.fallback.action.text).toBe("Pair with a private QR code");
  });

  it("gives a computer the download code, the account and Allow on the new machine", () => {
    const plan = addDevicePlan({ choice: "computer", connect: on, phones: 2, machine });
    expect(plan.url).toBe(DESKTOP_APP_URL);
    expect(plan.shownUrl).toBe("specwithcode.com/download");
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[2]).toEqual({
      text: "Pick {machine} as the main machine and press Allow there. It shows up here by itself.",
      values: { machine },
    });
    expect(plan.fallback.target).toBe(OTHER_ACCOUNT_TARGET);
    // Phones are not a computer's business: the ready line leaves them out.
    expect(plan.ready).toEqual({
      text: "{machine} is on SpecWithCode Connect as {account}.",
      values: { machine, account: "sam@example.com" },
    });
  });

  it("folds finished setup into one line that counts the phones", () => {
    expect(addDevicePlan({ choice: "phone", connect: on, phones: 1, machine }).ready?.text).toBe(
      "{machine} is on SpecWithCode Connect as {account}. 1 phone linked.",
    );
    expect(addDevicePlan({ choice: "phone", connect: on, phones: 3, machine }).ready).toEqual({
      text: "{machine} is on SpecWithCode Connect as {account}. {count} phones linked.",
      values: { machine, account: "sam@example.com", count: 3 },
    });
    expect(
      addDevicePlan({ choice: "phone", connect: on, phones: "loading", machine }).ready?.text,
    ).toBe("{machine} is on SpecWithCode Connect as {account}.");
  });

  it("asks for Connect first while this machine is signed out or off", () => {
    for (const connect of [
      { kind: "signed-out" } as const,
      { kind: "off", account: "sam@example.com" } as const,
      { kind: "unknown" } as const,
    ]) {
      for (const choice of ["phone", "computer"] as const) {
        const plan = addDevicePlan({ choice, connect, phones: null, machine });
        expect(plan.needsConnect).toBe(true);
        expect(plan.ready).toBeNull();
      }
    }
  });

  it("names the same account even before Connect is on, and no account when signed out", () => {
    const off = addDevicePlan({
      choice: "computer",
      connect: { kind: "off", account: "sam@example.com" },
      phones: null,
      machine,
    });
    expect(off.steps[1]).toEqual({
      text: "Sign in as {account}.",
      values: { account: "sam@example.com" },
    });
    const out = addDevicePlan({
      choice: "computer",
      connect: { kind: "signed-out" },
      phones: null,
      machine,
    });
    expect(out.steps[1]).toEqual({ text: "Sign in with the same account as here." });
  });

  it("asks for nothing in a build without Connect: the fallback is the way in", () => {
    const plan = addDevicePlan({
      choice: "phone",
      connect: { kind: "unavailable" },
      phones: null,
      machine,
    });
    expect(plan.needsConnect).toBe(false);
    expect(plan.ready).toBeNull();
  });
});

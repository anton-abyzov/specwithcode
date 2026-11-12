import { describe, expect, it } from "vite-plus/test";

import type { MachineConnect } from "./machineNextStep.logic";
import { PHONE_APP_URL, phoneCardSteps } from "./PhoneConnect.logic";

const machine = "Sam's MacBook Pro";
const on: MachineConnect = { kind: "on", account: "sam@example.com" };
const steps = (connect: MachineConnect, phones: number | "loading" | null = 0) =>
  phoneCardSteps({ connect, phones, machine });
const fill = (phrase: { text: string; values?: Readonly<Record<string, string | number>> }) =>
  phrase.text.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(phrase.values?.[name] ?? `{${name}}`),
  );
const read = (connect: MachineConnect, phones: number | "loading" | null = 0) =>
  steps(connect, phones).map((step) => [step.state, fill(step.title), fill(step.body)]);

describe("phoneCardSteps", () => {
  it("is always three steps: this machine, the app, the sign-in on the phone", () => {
    for (const connect of [
      on,
      { kind: "off", account: null },
      { kind: "signed-out" },
      { kind: "loading" },
      { kind: "unknown" },
      { kind: "unavailable" },
    ] satisfies MachineConnect[]) {
      expect(steps(connect)).toHaveLength(3);
    }
  });

  it("starts with the sign-in while signed out, and keeps the store code for later", () => {
    expect(read({ kind: "signed-out" })).toEqual([
      [
        "current",
        "Sign in to SpecWithCode Connect",
        "It links Sam's MacBook Pro to your account in the same click. No VPN, open ports or terminal.",
      ],
      [
        "todo",
        "Get SpecWithCode on your phone",
        "iPhone or Android. The store code shows here once this machine is on SpecWithCode Connect.",
      ],
      [
        "todo",
        "Sign in on the phone with the same account",
        "Sam's MacBook Pro shows up there by itself.",
      ],
    ]);
    expect(steps({ kind: "signed-out" }).some((step) => step.storeCode)).toBe(false);
  });

  it("asks to turn Connect on once signed in, naming the account", () => {
    const [first, second] = read({ kind: "off", account: "sam@example.com" });
    expect(first).toEqual([
      "current",
      "Turn on SpecWithCode Connect for Sam's MacBook Pro",
      "Signed in as sam@example.com. It gets a private address that only your account can use.",
    ]);
    expect(second![0]).toBe("todo");
  });

  it("names the machine and the account once it is on, and shows the store code", () => {
    const all = steps(on);
    expect(read(on)).toEqual([
      [
        "done",
        "Sam's MacBook Pro is on SpecWithCode Connect",
        "Linked as sam@example.com. Reachable from anywhere, by your account only.",
      ],
      [
        "current",
        "Get SpecWithCode on your phone",
        "Scan this with the phone's camera. It opens the App Store on an iPhone and Google Play on Android. Or search the store for “SpecWithCode”.",
      ],
      [
        "todo",
        "Sign in on the phone as sam@example.com",
        "Sam's MacBook Pro shows up on the phone by itself, and the phone shows up here. Nothing to scan or type.",
      ],
    ]);
    expect(all.map((step) => step.storeCode)).toEqual([false, true, false]);
  });

  it("marks every step done with a phone linked, and still offers the code for another", () => {
    const all = steps(on, 2);
    expect(all.map((step) => step.state)).toEqual(["done", "done", "done"]);
    expect(all[1].storeCode).toBe(true);
    expect(all[1].body.text).toContain("To add another phone");
  });

  it("does not call a phone linked while the list is unread", () => {
    expect(steps(on, "loading").map((step) => step.state)).toEqual(["done", "current", "todo"]);
    expect(steps(on, null).map((step) => step.state)).toEqual(["done", "current", "todo"]);
  });

  it("leaves the account out when this window does not know it", () => {
    const [first, , third] = read({ kind: "on", account: null });
    expect(first![2]).toBe("Reachable from anywhere, by its account only.");
    expect(third![1]).toBe("Sign in on the phone with the same account");
  });

  it("says so while checking and when the check fails", () => {
    expect(read({ kind: "loading" })[0]).toEqual([
      "todo",
      "Checking SpecWithCode Connect…",
      "One moment.",
    ]);
    expect(read({ kind: "unknown" })[0]).toEqual([
      "current",
      "Could not check SpecWithCode Connect",
      "Try again in a moment.",
    ]);
  });

  it("says phone and both stores, never one kind of phone alone", () => {
    for (const connect of [on, { kind: "signed-out" }] satisfies MachineConnect[]) {
      const text = read(connect).flat().join(" ");
      expect(text).toContain("phone");
      expect(text).toMatch(/iPhone/);
      expect(text).toMatch(/Android/);
      expect(text).not.toMatch(/environment|relay|tailnet|backend/i);
    }
  });
});

describe("the store code", () => {
  it("leads to the page that sends each phone to its own store", () => {
    expect(PHONE_APP_URL).toBe("https://specwithcode.com/get");
  });
});

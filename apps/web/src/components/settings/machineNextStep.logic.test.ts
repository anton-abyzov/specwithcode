import { describe, expect, it } from "vite-plus/test";

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
  type MachineRoleRow,
} from "./machineNextStep.logic";

const signedOut: MachineConnect = { kind: "signed-out" };
const off: MachineConnect = { kind: "off", account: "sam@example.com" };
const on: MachineConnect = { kind: "on", account: "sam@example.com" };

const base = {
  canChangeConnect: true,
  connectLocked: false,
  phonesLocked: false,
  phones: 0,
  phoneStepDismissed: false,
} as const;

function row(
  label: string,
  parts: Partial<Pick<MachineRoleRow, "workers" | "workHere">> & { here?: boolean } = {},
): MachineRoleRow {
  return {
    label,
    seen: { state: parts.here ? "this-machine" : "connected" },
    workers: parts.workers ?? null,
    workHere: parts.workHere ?? null,
  };
}

describe("machineConnect", () => {
  const read = {
    configured: true,
    authLoaded: true,
    signedIn: true,
    account: "sam@example.com",
    link: { linked: false, managedTunnelActive: false },
    linkPending: false,
  };

  it("has nothing to say in a build without SpecWithCode Connect", () => {
    expect(machineConnect({ ...read, configured: false })).toEqual({ kind: "unavailable" });
  });

  it("waits for the sign-in before calling the machine signed out", () => {
    expect(machineConnect({ ...read, authLoaded: false, signedIn: false })).toEqual({
      kind: "loading",
    });
    expect(machineConnect({ ...read, signedIn: false })).toEqual({ kind: "signed-out" });
  });

  it("is off when signed in without a link, and on once the machine runs its tunnel", () => {
    expect(machineConnect(read)).toEqual(off);
    expect(machineConnect({ ...read, link: { linked: true, managedTunnelActive: true } })).toEqual(
      on,
    );
  });

  it("does not count a link that only publishes activity as on", () => {
    expect(machineConnect({ ...read, link: { linked: true, managedTunnelActive: false } })).toEqual(
      off,
    );
  });

  it("reads a server from before the tunnel field by its link", () => {
    expect(machineConnect({ ...read, link: { linked: true } })).toEqual(on);
  });

  it("believes the machine over this window's sign-in", () => {
    expect(
      machineConnect({
        ...read,
        authLoaded: false,
        signedIn: false,
        link: { linked: true, managedTunnelActive: true },
      }),
    ).toEqual({ kind: "on", account: null });
  });

  it("waits for the first read of the link, and says so when it cannot be read", () => {
    expect(machineConnect({ ...read, link: null, linkPending: true })).toEqual({
      kind: "loading",
    });
    expect(machineConnect({ ...read, link: null })).toEqual({ kind: "unknown" });
  });
});

describe("machineNextStep", () => {
  it("picks one step in order: sign in, turn on, add a phone, none", () => {
    expect(machineNextStep({ ...base, connect: signedOut })).toEqual({
      kind: "sign-in",
      canAct: true,
    });
    expect(machineNextStep({ ...base, connect: off })).toEqual({ kind: "turn-on", canAct: true });
    expect(machineNextStep({ ...base, connect: on })).toEqual({ kind: "add-phone" });
    expect(machineNextStep({ ...base, connect: on, phones: 1 })).toEqual({ kind: "done" });
  });

  it("asks to sign in before anything else, even with phones on the account", () => {
    expect(machineNextStep({ ...base, connect: signedOut, phones: 2 }).kind).toBe("sign-in");
    expect(machineNextStep({ ...base, connect: off, phones: 2 }).kind).toBe("turn-on");
  });

  it("keeps the step and drops the button in a window that cannot change the link", () => {
    expect(machineNextStep({ ...base, connect: signedOut, canChangeConnect: false })).toEqual({
      kind: "sign-in",
      canAct: false,
    });
    expect(machineNextStep({ ...base, connect: off, canChangeConnect: false })).toEqual({
      kind: "turn-on",
      canAct: false,
    });
  });

  it("remembers Not now for the phone step only", () => {
    expect(machineNextStep({ ...base, connect: on, phoneStepDismissed: true })).toEqual({
      kind: "done",
    });
    expect(machineNextStep({ ...base, connect: off, phoneStepDismissed: true }).kind).toBe(
      "turn-on",
    );
  });

  it("offers no step that Team rules forbid", () => {
    expect(machineNextStep({ ...base, connect: signedOut, connectLocked: true })).toEqual({
      kind: "done",
    });
    expect(machineNextStep({ ...base, connect: off, connectLocked: true })).toEqual({
      kind: "done",
    });
    expect(machineNextStep({ ...base, connect: on, phonesLocked: true })).toEqual({
      kind: "done",
    });
  });

  it("shows no step while the state is read, and none it cannot be sure of", () => {
    expect(machineNextStep({ ...base, connect: { kind: "loading" } })).toEqual({
      kind: "loading",
    });
    expect(machineNextStep({ ...base, connect: on, phones: "loading" })).toEqual({
      kind: "loading",
    });
    expect(machineNextStep({ ...base, connect: on, phones: null })).toEqual({ kind: "done" });
    expect(machineNextStep({ ...base, connect: { kind: "unknown" } })).toEqual({ kind: "done" });
    expect(machineNextStep({ ...base, connect: { kind: "unavailable" } })).toEqual({
      kind: "done",
    });
  });

  it("names each step", () => {
    expect(machineNextStepTitle({ kind: "sign-in", canAct: true })).toBe(
      "Sign in to SpecWithCode Connect",
    );
    expect(machineNextStepTitle({ kind: "turn-on", canAct: true })).toBe(
      "Turn on SpecWithCode Connect for this machine",
    );
    expect(machineNextStepTitle({ kind: "add-phone" })).toBe("Add your phone");
    expect(machineNextStepTitle({ kind: "done" })).toBe("You are set");
    expect(machineNextStepTitle({ kind: "loading" })).toBeNull();
  });
});

describe("machineRole", () => {
  const active = { status: "active" } as const;
  const allowed = { status: "allowed" } as const;

  it("is the main machine when no other machine may run work here", () => {
    expect(machineRole({ rows: [row("M4", { here: true })], chosen: null })).toEqual({
      kind: "main",
    });
    expect(
      machineRole({
        rows: [row("M4", { here: true }), row("M1", { workers: allowed })],
        chosen: null,
      }),
    ).toEqual({ kind: "main" });
  });

  it("is a helper for the machines that may run work here", () => {
    expect(machineRole({ rows: [row("M4", { workHere: active })], chosen: null })).toEqual({
      kind: "helper",
      of: "M4",
      more: 0,
    });
    expect(
      machineRole({
        rows: [row("M4", { workHere: active }), row("M3", { workHere: active })],
        chosen: null,
      }),
    ).toEqual({ kind: "helper", of: "M4", more: 1 });
  });

  it("ignores a grant that was revoked or ran out, and this machine's own row", () => {
    expect(
      machineRole({
        rows: [
          row("M4", { workHere: { status: "revoked" } }),
          row("M3", { workHere: { status: "expired" } }),
          row("Here", { here: true, workHere: active }),
        ],
        chosen: null,
      }),
    ).toEqual({ kind: "main" });
  });

  it("stays the main machine when work runs both ways, unless it was set up as a helper", () => {
    const rows = [row("M1", { workHere: active, workers: allowed })];
    expect(machineRole({ rows, chosen: null })).toEqual({ kind: "main" });
    expect(machineRole({ rows, chosen: "main" })).toEqual({ kind: "main" });
    expect(machineRole({ rows, chosen: "joined" })).toEqual({ kind: "helper", of: "M1", more: 0 });
  });

  it("is not set up when it was meant to join and no machine may run work here yet", () => {
    expect(machineRole({ rows: [], chosen: "joined" })).toEqual({ kind: "not-set-up" });
  });

  it("words each role", () => {
    expect(machineRoleLabel({ kind: "main" })).toEqual({ text: "Main machine" });
    expect(machineRoleLabel({ kind: "not-set-up" })).toEqual({ text: "Not set up" });
    expect(machineRoleLabel({ kind: "helper", of: "M4", more: 0 })).toEqual({
      text: "Helper for {machine}",
      values: { machine: "M4" },
    });
    expect(machineRoleLabel({ kind: "helper", of: "M4", more: 2 })).toEqual({
      text: "Helper for {machine} and {count} more",
      values: { machine: "M4", count: 2 },
    });
  });
});

describe("machineVersionState", () => {
  it("says up to date, an update, or nothing before the machine answers", () => {
    expect(
      machineVersionLabel(machineVersionState({ serverVersion: "1.0.233", mismatch: null })),
    ).toEqual({ text: "{version}, up to date", values: { version: "1.0.233" } });
    expect(
      machineVersionLabel(
        machineVersionState({
          serverVersion: "1.0.230",
          mismatch: { serverVersion: "1.0.230", clientVersion: "1.0.233" },
        }),
      ),
    ).toEqual({
      text: "{version}, update to {next} available",
      values: { version: "1.0.230", next: "1.0.233" },
    });
    expect(
      machineVersionLabel(machineVersionState({ serverVersion: null, mismatch: null })),
    ).toBeNull();
  });
});

describe("machineFacts", () => {
  const texts = (input: Parameters<typeof machineFacts>[0]) =>
    machineFacts(input).map((fact) => [fact.ok, fact.text, fact.values]);

  it("always lists Connect, Phone and Other machines, in that order", () => {
    expect(
      machineFacts({
        connect: signedOut,
        connectLocked: false,
        phones: null,
        otherMachines: 0,
      }).map((fact) => fact.key),
    ).toEqual(["connect", "phone", "machines"]);
  });

  it("reads a new machine as the mockup does", () => {
    expect(
      texts({ connect: signedOut, connectLocked: false, phones: null, otherMachines: 0 }),
    ).toEqual([
      [false, "Connect: not signed in", undefined],
      [false, "Phone: none yet", undefined],
      [false, "Other machines: none", undefined],
    ]);
  });

  it("marks what is in place and names the account", () => {
    expect(texts({ connect: on, connectLocked: false, phones: 2, otherMachines: 3 })).toEqual([
      [true, "Connect: linked as {account}", { account: "sam@example.com" }],
      [true, "Phones: {count} linked", { count: 2 }],
      [true, "Other machines: {count}", { count: 3 }],
    ]);
    expect(texts({ connect: on, connectLocked: false, phones: 1, otherMachines: 0 })[1]).toEqual([
      true,
      "Phone: 1 linked",
      undefined,
    ]);
  });

  it("says why Connect is not on", () => {
    const connectText = (connect: MachineConnect, connectLocked = false) =>
      machineFacts({ connect, connectLocked, phones: 0, otherMachines: 0 })[0].text;
    expect(connectText(off)).toBe("Connect: off for this machine");
    expect(connectText(off, true)).toBe("Connect: off by your team's rules");
    expect(connectText(signedOut, true)).toBe("Connect: off by your team's rules");
    expect(connectText({ kind: "on", account: null })).toBe("Connect: on");
    expect(connectText({ kind: "loading" })).toBe("Connect: checking…");
    expect(connectText({ kind: "unknown" })).toBe("Connect: could not check");
    expect(connectText({ kind: "unavailable" })).toBe("Connect: not in this build");
  });

  it("does not call an unread phone list empty", () => {
    const phoneText = (connect: MachineConnect, phones: number | "loading" | null) =>
      machineFacts({ connect, connectLocked: false, phones, otherMachines: 0 })[1].text;
    expect(phoneText(on, "loading")).toBe("Phone: checking…");
    expect(phoneText({ kind: "on", account: null }, null)).toBe("Phone: sign in to see");
    expect(phoneText(on, 0)).toBe("Phone: none yet");
  });
});

describe("machinePhones", () => {
  it("counts the account's phones once the list is read", () => {
    expect(machinePhones({ accountId: "acct", phones: [{}, {}], pending: false })).toBe(2);
    expect(machinePhones({ accountId: "acct", phones: [], pending: true })).toBe(0);
  });

  it("is loading during the first read and unknown when that fails or nobody is signed in", () => {
    expect(machinePhones({ accountId: "acct", phones: null, pending: true })).toBe("loading");
    expect(machinePhones({ accountId: "acct", phones: null, pending: false })).toBeNull();
    expect(machinePhones({ accountId: null, phones: [], pending: false })).toBeNull();
  });
});

describe("phone step put off", () => {
  it("is remembered for one machine and leaves the others", () => {
    const first = withPhoneStepDismissed({}, "m4");
    expect(first).toEqual({ m4: true });
    expect(isPhoneStepDismissed(first, "m4")).toBe(true);
    expect(isPhoneStepDismissed(first, "m1")).toBe(false);
    expect(isPhoneStepDismissed(first, null)).toBe(false);
    expect(withPhoneStepDismissed(first, "m1")).toEqual({ m4: true, m1: true });
    expect(withPhoneStepDismissed(first, "m4")).toBe(first);
  });
});

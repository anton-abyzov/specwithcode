import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));

const { coordinatorBoxState } = await import("./coordinatorBoxState");
const { mainOffer } = await import("./makeMain");
type Input = Parameters<typeof coordinatorBoxState>[0];
type Text = ReturnType<typeof coordinatorBoxState>["line"];

/** The English a person reads: every `{slot}` filled from its values. */
const read = (text: Text | null) =>
  text
    ? text.text.replace(/\{(\w+)\}/g, (_, slot: string) => text.values?.[slot] ?? `{${slot}}`)
    : null;

const names = { machine: "Rack F", main: "Laptop E", project: "Atlas" };
const main = { environmentId: "laptopE" };
/** "Continue here" for Rack F, the machine shown, by the same rule the page uses. */
const offers = {
  move: mainOffer("rackF:p", { kind: "move", main }, names)!,
  takeover: mainOffer("rackF:p", { kind: "takeover", main, silentMs: 23 * 60_000 }, names)!,
  takeoverUnmeasured: mainOffer("rackF:p", { kind: "takeover", main }, names)!,
  waiting: mainOffer(
    "rackF:p",
    { kind: "blocked", main, reason: "waiting", waitMs: 3.5 * 60_000 },
    names,
  )!,
  unloaded: mainOffer("rackF:p", { kind: "unloaded", mainEnvironmentId: "laptopE" as never }, names)!,
  notReady: mainOffer(
    "rackF:p",
    { kind: "blocked", main, reason: "copy-not-ready", waitMs: 0 },
    names,
  )!,
  readOnly: mainOffer(
    "rackF:p",
    { kind: "blocked", main, reason: "main-read-only", waitMs: 0 },
    names,
  )!,
};

/** The coordinator on Laptop E answers and this window may operate it: Send routes there. */
const input = (over: Partial<Input> = {}): Input => ({
  project: "Atlas",
  machine: "Laptop E",
  routes: true,
  machineConnected: true,
  mayOperate: true,
  hasFiles: false,
  movedTo: null,
  offer: offers.move,
  ...over,
});

describe("coordinatorBoxState: which state applies (AC-08 order)", () => {
  // Every condition of the table holds at once; peeling them off top to bottom walks the rows.
  const all: Partial<Input> = {
    offer: offers.takeover,
    mayOperate: false,
    hasFiles: true,
    movedTo: "box-a",
    refused: "The coordinator is paused",
  };
  it("first says that this window has not opened the project on the coordinator's machine", () => {
    expect(coordinatorBoxState(input({ ...all, offer: offers.unloaded })).kind).toBe("unloaded");
  });
  it("then lets a coordinator silent for 10 minutes or more continue here", () => {
    expect(coordinatorBoxState(input(all)).kind).toBe("silent");
  });
  it("then says this machine cannot take a silent coordinator yet", () => {
    expect(coordinatorBoxState(input({ ...all, offer: offers.notReady })).kind).toBe("not-ready");
  });
  it("then waits while it has been silent for less than 10 minutes", () => {
    expect(coordinatorBoxState(input({ ...all, offer: offers.waiting })).kind).toBe("waiting");
  });
  it("then says this window can only read the coordinator's machine", () => {
    expect(coordinatorBoxState(input({ ...all, offer: offers.readOnly })).kind).toBe("read-only");
  });
  it("then refuses files", () => {
    expect(coordinatorBoxState(input({ ...all, offer: offers.move, mayOperate: true })).kind).toBe(
      "files",
    );
  });
  it("then says the coordinator moved while the message was typed", () => {
    expect(
      coordinatorBoxState(input({ ...all, offer: offers.move, mayOperate: true, hasFiles: false }))
        .kind,
    ).toBe("moved");
  });
  it("then says the coordinator's machine refused the message", () => {
    expect(
      coordinatorBoxState(
        input({ ...all, offer: offers.move, mayOperate: true, hasFiles: false, movedTo: null }),
      ).kind,
    ).toBe("refused");
  });
  it("and routes to the coordinator only when nothing above applies", () => {
    expect(coordinatorBoxState(input()).kind).toBe("routes");
  });
  it("says nothing can be sent when no rule names why", () => {
    expect(coordinatorBoxState(input({ routes: false, machineConnected: false })).kind).toBe(
      "unreachable",
    );
    expect(coordinatorBoxState(input({ machine: null, routes: false })).kind).toBe("unreachable");
  });
});

describe("coordinatorBoxState: what each state says and offers", () => {
  it("routes: Send opens the coordinator there, with Continue here beside it (AC-07)", () => {
    const box = coordinatorBoxState(input());
    expect(read(box.line)).toBe("The coordinator for Atlas is on Laptop E. Send opens it there.");
    expect(box.send).toEqual({ text: "Send", enabled: true, continues: false });
    expect(box.continueHere?.enabled).toBe(true);
    expect(read(box.continueHere?.note ?? null)).toBe(
      "Continue here syncs Rack F, then moves the coordinator conversation here from Laptop E.",
    );
  });

  it("silent: the box's own button continues here and sends, with no second button (AC-09)", () => {
    const box = coordinatorBoxState(input({ offer: offers.takeover, machineConnected: false }));
    expect(read(box.line)).toBe(
      "Laptop E has been offline for 23 minutes. Continue here: the coordinator starts on Rack F from the shared goal, memory and plan. Its conversation on Laptop E stays readable there, and Laptop E gives way when it is back.",
    );
    expect(box.send).toEqual({ text: "Continue here and send", enabled: true, continues: true });
    expect(box.continueHere).toBeNull();
    // Where nobody measured the silence, the line says 10 minutes or more.
    expect(
      read(
        coordinatorBoxState(input({ offer: offers.takeoverUnmeasured, machineConnected: false }))
          .line,
      ),
    ).toBe(
      "Laptop E has been offline for 10 minutes or more. Continue here: the coordinator starts on Rack F from the shared goal, memory and plan. Its conversation on Laptop E stays readable there, and Laptop E gives way when it is back.",
    );
  });

  it("silent with files: the button only continues here", () => {
    const box = coordinatorBoxState(
      input({ offer: offers.takeover, machineConnected: false, hasFiles: true }),
    );
    expect(box.send).toEqual({ text: "Continue here", enabled: true, continues: true });
  });

  it("waiting: Send and Continue here are greyed, with the minutes left", () => {
    const box = coordinatorBoxState(
      input({ offer: offers.waiting, machineConnected: false, routes: false }),
    );
    expect(read(box.line)).toBe("Laptop E is not answering. Continue here unlocks in 4 min.");
    expect(box.send).toEqual({ text: "Send", enabled: false, continues: false });
    expect(box.continueHere?.enabled).toBe(false);
    expect(read(box.continueHere?.note ?? null)).toBe("in 4 min");
  });

  it("read-only: Send and Continue here are greyed, for the reason the line gives", () => {
    const box = coordinatorBoxState(
      input({ offer: offers.readOnly, mayOperate: false, routes: false }),
    );
    expect(read(box.line)).toBe(
      "This window can only read Laptop E, so it cannot send there. Open SpecWithCode on Laptop E, or connect to it with full access.",
    );
    expect(box.send.enabled).toBe(false);
    expect(box.continueHere?.enabled).toBe(false);
    expect(read(box.continueHere?.note ?? null)).toBe("read-only on Laptop E");
  });

  it("files: Send is greyed, Continue here is not", () => {
    const box = coordinatorBoxState(input({ hasFiles: true }));
    expect(read(box.line)).toBe(
      "Files stay on this machine. Remove them to send the text, or open Atlas on Laptop E to attach them there.",
    );
    expect(box.send).toEqual({ text: "Send", enabled: false, continues: false });
    expect(box.continueHere?.enabled).toBe(true);
  });

  it("unloaded: both greyed, the line says to connect the coordinator's machine", () => {
    const box = coordinatorBoxState(input({ offer: offers.unloaded, routes: false }));
    expect(read(box.line)).toBe(
      "Connect Laptop E first. This window has not opened Atlas on Laptop E, so it cannot hand the coordinator off yet.",
    );
    expect(box.send.enabled).toBe(false);
    expect(box.continueHere?.enabled).toBe(false);
    expect(read(box.continueHere?.note ?? null)).toBe("connect Laptop E first");
  });

  it("the machine shown offline: both greyed, even when a send could route", () => {
    const offline = mainOffer(
      "rackF:p",
      { kind: "blocked", main, reason: "copy-offline", waitMs: 0 },
      names,
    )!;
    const box = coordinatorBoxState(input({ offer: offline, routes: true }));
    expect(box.kind).toBe("unloaded");
    expect(read(box.line)).toBe("Connect Rack F first to continue the coordinator there.");
    expect(box.send.enabled).toBe(false);
    expect(box.continueHere?.enabled).toBe(false);
  });

  it("not ready: both greyed, Continue here says not ready", () => {
    const box = coordinatorBoxState(
      input({ offer: offers.notReady, machineConnected: false, routes: false }),
    );
    expect(read(box.line)).toBe(
      "Rack F cannot continue the coordinator yet. Update SpecWithCode there, or connect to it with permission to change settings and run work.",
    );
    expect(box.send.enabled).toBe(false);
    expect(box.continueHere?.enabled).toBe(false);
    expect(read(box.continueHere?.note ?? null)).toBe("not ready");
  });

  it("refused: the line gives the machine's reason, Send and Continue here stay on", () => {
    const box = coordinatorBoxState(input({ refused: "The coordinator is paused." }));
    expect(read(box.line)).toBe(
      "Laptop E did not take the message: The coordinator is paused. Nothing was sent.",
    );
    expect(box.send).toEqual({ text: "Send", enabled: true, continues: false });
    expect(box.continueHere?.enabled).toBe(true);
  });

  it("moved: says nothing was sent, and Send goes to the new machine", () => {
    const box = coordinatorBoxState(input({ machine: "box-a", movedTo: "box-a" }));
    expect(read(box.line)).toBe("The coordinator moved to box-a. Nothing was sent.");
    expect(box.send).toEqual({ text: "Send", enabled: true, continues: false });
    expect(box.continueHere?.enabled).toBe(true);
  });

  it("unreachable: names no machine it does not know", () => {
    const box = coordinatorBoxState(input({ machine: null, routes: false, offer: null }));
    expect(read(box.line)).toBe(
      "The coordinator for Atlas is on another machine that this window cannot reach.",
    );
    expect(box.send.enabled).toBe(false);
    expect(box.continueHere).toBeNull();
  });

  it("offers no Continue here where the machine shown has none", () => {
    for (const over of [{}, { hasFiles: true }, { refused: "No" }, { movedTo: "Laptop E" }])
      expect(coordinatorBoxState(input({ ...over, offer: null })).continueHere).toBeNull();
    expect(
      coordinatorBoxState(input({ offer: null, mayOperate: false, routes: false })).continueHere,
    ).toBeNull();
  });
});

describe("coordinatorBoxState: placeholders", () => {
  it("asks the coordinator while its machine answers", () => {
    expect(read(coordinatorBoxState(input()).placeholder)).toBe(
      "Ask the coordinator for Atlas (on Laptop E).",
    );
  });
  it("says the machine is not answering while it is not connected", () => {
    expect(
      read(coordinatorBoxState(input({ machineConnected: false, routes: false })).placeholder),
    ).toBe("The coordinator for Atlas is on Laptop E, which is not answering.");
  });
  it("names no machine it does not know", () => {
    expect(read(coordinatorBoxState(input({ machine: null, routes: false })).placeholder)).toBe(
      "The coordinator for Atlas is on another machine.",
    );
  });
});

describe("coordinatorBoxState: Send never names a machine (AC-02)", () => {
  const machines = ["Laptop E", "Rack F", "laptopE", "rackF", "box-a", "Mac", "Shelf G"];
  const cases: Partial<Input>[] = [
    {},
    { offer: offers.takeover, machineConnected: false },
    { offer: offers.takeover, machineConnected: false, hasFiles: true },
    { offer: offers.takeoverUnmeasured, machineConnected: false },
    { offer: offers.waiting, machineConnected: false, routes: false },
    { offer: offers.readOnly, mayOperate: false, routes: false },
    { hasFiles: true },
    { refused: "No" },
    { offer: offers.unloaded, routes: false },
    { offer: offers.notReady, machineConnected: false, routes: false },
    { machine: "box-a", movedTo: "box-a" },
    { machine: null, routes: false, offer: null },
    { machineConnected: false, routes: false, offer: null },
  ];
  it.each(cases.map((over) => [coordinatorBoxState(input(over)).kind, over] as const))(
    "%s",
    (_kind, over) => {
      const { text } = coordinatorBoxState(input(over)).send;
      expect(["Send", "Continue here and send", "Continue here"]).toContain(text);
      for (const machine of machines) expect(text).not.toContain(machine);
    },
  );
});

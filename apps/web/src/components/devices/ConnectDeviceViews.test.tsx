// @vitest-environment jsdom
import type {
  ConnectDevice,
  ConnectDeviceRequest,
} from "@specweave-studio/contracts/connectDevices";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  codePlace,
  codeSteps,
  connectDeviceIdLabel,
  connectDeviceTitle,
  laterKey,
  laterKeys,
  requestsToPrompt,
} from "../../studio/connectDevices.logic";
import { DeviceApprovalPrompt, DeviceWaitingList } from "./ConnectDeviceViews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const phone = (id: string, shortId: string | undefined, askedAt: string): ConnectDeviceRequest => ({
  id,
  kind: "connect",
  label: "iPhone",
  named: true,
  deviceType: "mobile",
  system: "iOS",
  app: "SpecWithCode",
  // A machine that sends short IDs also sends the device reference Later uses.
  ...(shortId === undefined ? {} : { shortId, device: `reference-of-${id.replace(/\d+$/, "")}` }),
  askedAt,
  expiresAt: "2026-11-18T08:38:00.000Z",
});
const first = phone("request-a", "TSKR", "2026-11-18T08:27:25.000Z");
const second = phone("request-b", "9229", "2026-11-18T08:28:08.000Z");
/** The code each phone shows; the machine matches a typed code against every waiting one. */
const CODES: Readonly<Record<string, ConnectDeviceRequest>> = { K7QX2M: first, P4RT9W: second };

const allowedFrom = (request: ConnectDeviceRequest): ConnectDevice => ({
  key: `jkt:${request.id}`,
  kind: request.kind,
  label: request.label,
  named: true,
  deviceType: "mobile",
  system: "iOS",
  app: "SpecWithCode",
  ...(request.shortId === undefined ? {} : { shortId: request.shortId }),
  approvedAt: "2026-11-18T08:30:00.000Z",
  approvedBy: "this machine",
  keptByUpdate: false,
});

/** The host's state, without the machine: a waiting list, Later, and who was allowed. */
function Machine({ start, log }: { start: ReadonlyArray<ConnectDeviceRequest>; log: string[] }) {
  const [pending, setPending] = useState(start);
  const [later, setLater] = useState<ReadonlySet<string>>(() => new Set());
  const [allowed, setAllowed] = useState<ReadonlyArray<ConnectDevice>>([]);
  const requests = requestsToPrompt(pending, later);
  return (
    <>
      <button type="button" data-ask-again onClick={() => setPending([...start])}>
        ask again
      </button>
      <DeviceApprovalPrompt
        machine="m4"
        account="owner@example.com"
        requests={requests}
        allowed={allowed}
        onApprove={async (typed) => {
          const match = CODES[typed.replace(/[\s-]/g, "").toUpperCase()];
          if (!match || !pending.some((request) => request.id === match.id))
            return "No device is waiting with that code.";
          log.push(`approve ${match.id}`);
          setPending((current) => current.filter((request) => request.id !== match.id));
          setAllowed((current) => [...current, allowedFrom(match)]);
          return null;
        }}
        onDeny={async (id) => {
          log.push(`deny ${id}`);
          setPending((current) => current.filter((request) => request.id !== id));
        }}
        onLater={() => setLater(new Set(requests.map(laterKey)))}
      />
    </>
  );
}

let root: Root | null = null;
const open = async (start: ReadonlyArray<ConnectDeviceRequest>) => {
  const log: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<Machine start={start} log={log} />);
  });
  return log;
};
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const prompt = () => document.querySelector<HTMLElement>("[data-device-approval-prompt]");
const rows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-device-approval-row]")].map((row) => ({
    id: row.dataset.deviceApprovalRow,
    text: row.textContent ?? "",
  }));
const codeBox = () => prompt()!.querySelector<HTMLInputElement>("input")!;
const button = (name: string) =>
  [...prompt()!.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name,
  )!;
const type = async (code: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      codeBox(),
      code,
    );
    codeBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const allow = async () => {
  await act(async () => {
    button("Allow").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("the approval pop-up with several devices (1406)", () => {
  it("lists two phones of one name apart, with one code box and a Deny each", async () => {
    await open([first, second]);
    expect(prompt()!.textContent).toContain("2 devices want to use m4");
    expect(rows().map((row) => row.id)).toEqual(["request-a", "request-b"]);
    expect(rows()[0]!.text).toContain("iPhone");
    expect(rows()[0]!.text).toContain("ID TSKR");
    expect(rows()[1]!.text).toContain("ID 9229");
    expect(rows()[0]!.text).toContain("Signed in to SpecWithCode Connect as owner@example.com");
    expect(prompt()!.querySelectorAll("input")).toHaveLength(1);
    expect(prompt()!.textContent).toContain("Type the code shown on the device you want to allow");
    // Each Deny says which device it turns away.
    expect(
      [...prompt()!.querySelectorAll("[data-device-deny]")].map((deny) =>
        deny.getAttribute("aria-label"),
      ),
    ).toEqual(["Deny iPhone · ID TSKR", "Deny iPhone · ID 9229"]);
    // The typed code is still what approves.
    expect(prompt()!.textContent).toContain("allow only a code you can read on it");
  });

  it("names the phone a code allowed and keeps the other one listed", async () => {
    const log = await open([first, second]);
    // The owner reads the code off the second phone while the first is listed first.
    await type("p4r-t9w");
    await allow();
    expect(log).toEqual(["approve request-b"]);
    expect(prompt()).not.toBeNull();
    const allowed = [...document.querySelectorAll("[data-device-approval-allowed]")];
    expect(allowed.map((line) => line.textContent)).toEqual([
      "Allowed iPhone · ID 9229. It can now use m4.",
    ]);
    expect(allowed[0]!.getAttribute("role")).toBe("status");
    expect(rows().map((row) => row.id)).toEqual(["request-a"]);
    expect(rows()[0]!.text).toContain("ID TSKR");
    expect(codeBox().value).toBe("");
    expect(prompt()!.querySelector("[data-device-approval-count]")!.textContent).toMatch(
      /^1 device waiting/,
    );
    // The allowed line stays above the list; the title is back to one device.
    expect(prompt()!.textContent).toContain("A new device wants to use m4");
    const line = prompt()!.querySelector("[data-device-approval-allowed]")!;
    const list = prompt()!.querySelector("[data-device-approval-waiting]")!;
    expect(line.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes by itself once the last waiting device is allowed", async () => {
    await open([first, second]);
    await type("P4RT9W");
    await allow();
    await type("K7QX2M");
    await allow();
    expect(prompt()).toBeNull();
  });

  it("denies the row its button sits in, never another device", async () => {
    const log = await open([first, second]);
    await act(async () => {
      prompt()!.querySelector<HTMLButtonElement>('[data-device-deny="request-b"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(log).toEqual(["deny request-b"]);
    expect(rows().map((row) => row.id)).toEqual(["request-a"]);
  });

  it("keeps a wrong code's error and allows nothing", async () => {
    const log = await open([first, second]);
    await type("ZZZZZZ");
    await allow();
    expect(log).toEqual([]);
    expect(prompt()!.querySelector('[role="alert"]')!.textContent).toBe(
      "No device is waiting with that code.",
    );
    expect(rows()).toHaveLength(2);
    expect(document.querySelector("[data-device-approval-allowed]")).toBeNull();
  });

  it("keeps the one-device pop-up as it was, plus the ID", async () => {
    await open([first]);
    expect(prompt()!.textContent).toContain("A new device wants to use m4");
    expect(prompt()!.querySelector("[data-device-approval-line]")!.textContent).toBe(
      "iPhone is asking. It signed in to SpecWithCode Connect as owner@example.com.",
    );
    expect(prompt()!.textContent).toContain("Type the code shown on iPhone");
    expect(rows()[0]!.text).toContain("ID TSKR");
    expect(prompt()!.querySelector("[data-device-approval-count]")!.textContent).toBe(
      "Deny turns it away for a day.",
    );
  });

  it("says what Allow opens, apart from another machine's agents (1422)", async () => {
    await open([first]);
    expect(prompt()!.querySelector("[data-device-approval-grants]")!.textContent).toBe(
      "Allow lets that device's SpecWithCode app open m4 and use its chats and the work they start, terminals, files, settings and sign-ins, and approve or remove other devices. Letting another machine's agents run work here is a separate choice.",
    );
  });

  it("renders a machine that sends no ID yet without one", async () => {
    await open([phone("request-old", undefined, first.askedAt)]);
    expect(rows()[0]!.text).not.toContain("ID");
    expect(prompt()!.querySelector("[data-device-short-id]")).toBeNull();
  });
});

describe("one answer at a time (1406)", () => {
  const render = async (handlers: {
    onApprove: (code: string) => Promise<string | null>;
    onDeny: (id: string) => Promise<void>;
  }) => {
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      root = createRoot(container);
      root.render(
        <DeviceApprovalPrompt
          machine="m4"
          requests={[first, second]}
          onApprove={handlers.onApprove}
          onDeny={handlers.onDeny}
          onLater={() => undefined}
        />,
      );
    });
  };
  const denies = () => [
    ...prompt()!.querySelectorAll<HTMLButtonElement>("button[data-device-deny]"),
  ];

  it("holds every Deny while an Allow is on its way", async () => {
    const denied: string[] = [];
    let finish: (problem: string | null) => void = () => undefined;
    await render({
      onApprove: () => new Promise((resolve) => (finish = resolve)),
      onDeny: async (id) => void denied.push(id),
    });
    await type("P4RT9W");
    await act(async () => button("Allow").click());
    expect(denies().map((deny) => deny.disabled)).toEqual([true, true]);
    await act(async () => denies()[1]!.click());
    expect(denied).toEqual([]);
    await act(async () => finish(null));
    expect(denies().map((deny) => deny.disabled)).toEqual([false, false]);
  });

  it("holds Allow and the other Deny while a Deny is on its way", async () => {
    const approved: string[] = [];
    let finish: () => void = () => undefined;
    await render({
      onApprove: async (code) => {
        approved.push(code);
        return null;
      },
      onDeny: () => new Promise((resolve) => (finish = resolve)),
    });
    await type("K7QX2M");
    await act(async () => denies()[1]!.click());
    expect(prompt()!.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(true);
    expect(denies().map((deny) => deny.disabled)).toEqual([true, true]);
    await act(async () => {
      prompt()!.querySelector("form")!.requestSubmit();
    });
    expect(approved).toEqual([]);
    await act(async () => finish());
    expect(prompt()!.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(false);
  });
});

describe("Later (1406)", () => {
  it("hides the pop-up for the listed devices, also when their request is renewed", () => {
    const later = new Set([first, second].map(laterKey));
    expect(requestsToPrompt([first, second], later)).toEqual([]);
    // Ten minutes on, the same phone asks again under a new request id.
    const renewed = { ...first, id: "request-a2" };
    expect(requestsToPrompt([renewed, second], later)).toEqual([]);
    expect(laterKey(renewed)).toBe(laterKey(first));
    // A device that was not listed brings the pop-up back for itself only.
    const third = phone("request-c", "ABCD", first.askedAt);
    expect(requestsToPrompt([renewed, third], later)).toEqual([third]);
  });

  it("lists every waiting device while none was put off", () => {
    expect(requestsToPrompt([first, second], new Set())).toEqual([first, second]);
    expect(requestsToPrompt([], new Set([laterKey(first)]))).toEqual([]);
  });

  it("never hides another device that carries the same short ID", () => {
    const later = new Set([first].map(laterKey));
    // A look-alike: same name, same four characters, another key.
    const twin = phone("request-z", "TSKR", first.askedAt);
    expect(twin.shortId).toBe(first.shortId);
    expect(requestsToPrompt([twin], later)).toEqual([twin]);
  });

  it("falls back to the request when the machine sends no ID", () => {
    const old = phone("request-old", undefined, first.askedAt);
    expect(laterKey(old)).toBe("request-old");
    expect(laterKey(first)).toBe("device:reference-of-request-a");
    expect(requestsToPrompt([old], new Set(["request-old"]))).toEqual([]);
    expect(
      requestsToPrompt([{ ...old, id: "request-new" }], new Set(["request-old"])),
    ).toHaveLength(1);
  });

  it("treats Escape like Later, so closing the pop-up is remembered too (1416)", async () => {
    await open([first, second]);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(prompt()).toBeNull();
  });

  it("hides the pop-up in the real view until a new device asks", async () => {
    await open([first, second]);
    await act(async () => button("Later").click());
    expect(prompt()).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>("[data-ask-again]")!.click());
    expect(prompt()).toBeNull();
  });
});

describe("device names with their ID (1406)", () => {
  it("adds the ID to a name and leaves it out when there is none", () => {
    expect(connectDeviceTitle(first)).toBe("iPhone · ID TSKR");
    expect(connectDeviceTitle({ label: "iPhone", kind: "connect" })).toBe("iPhone");
    expect(connectDeviceIdLabel({ shortId: " 9229 " })).toBe("ID 9229");
    expect(connectDeviceIdLabel({})).toBe("");
    // A nameless device keeps its stand-in name beside the ID.
    expect(
      connectDeviceTitle({
        label: "An iPhone",
        named: false,
        kind: "connect",
        deviceType: "mobile",
        system: "iOS",
        shortId: "TSKR",
      }),
    ).toBe("An iPhone · ID TSKR");
  });
});

describe("the waiting device with several machines (1406)", () => {
  it("lists each machine with its own code and says which device this is", () => {
    const html = renderToStaticMarkup(
      <DeviceWaitingList
        deviceId="9229"
        waiting={[
          { id: "env-1", machine: "Studio Mac", code: "K7QX2M" },
          { id: "env-2", machine: "Build server", code: "P4RT9W" },
        ]}
      />,
    );
    expect(html).toContain("Open SpecWithCode on each machine below and type its code:");
    expect(html).toMatch(
      /data-device-waiting="Studio Mac".*K7QX2M.*data-device-waiting="Build server".*P4RT9W/s,
    );
    expect(html).toContain(
      "This device&#x27;s ID is 9229. The machine shows the same ID next to it.",
    );
    expect(html.match(/>Copy</g)).toHaveLength(2);
  });

  it("keeps the one-machine card and adds the device's ID", () => {
    const html = renderToStaticMarkup(
      <DeviceWaitingList
        deviceId="9229"
        waiting={[{ id: "env-1", machine: "m4", code: "K7QX2M" }]}
      />,
    );
    expect(html).toContain("Open SpecWithCode on m4 and type this code:");
    expect(html).toContain("text-3xl");
    expect(html).toContain("This device&#x27;s ID is 9229.");
    expect(renderToStaticMarkup(<DeviceWaitingList waiting={[]} />)).toBe("");
    // No ID yet: the card says nothing about it.
    expect(
      renderToStaticMarkup(
        <DeviceWaitingList waiting={[{ id: "env-1", machine: "m4", code: "K7QX2M" }]} />,
      ),
    ).not.toContain("ID is");
  });
});

describe("a typed code reads in capitals (1416)", () => {
  it("shows lowercase typing in capitals and still allows the device", async () => {
    const log = await open([first, second]);
    await type("p4r-t9w");
    expect(codeBox().value).toBe("P4R-T9W");
    await allow();
    expect(log).toEqual(["approve request-b"]);
  });
});

describe("where the code is (1447)", () => {
  const where = () => prompt()!.querySelector<HTMLElement>("[data-device-approval-where]")!;
  const steps = () => [...where().querySelectorAll("li")].map((step) => step.textContent);

  it("sends the owner to the top of the screen on an iPhone app that shows it there", async () => {
    await open([{ ...first, label: "iPhone Duo", app: "SpecWithCode 0.1.9" }]);
    expect(where().dataset.deviceApprovalWhere).toBe("phone-top");
    expect(where().textContent).toContain("Where is the code?");
    expect(steps()).toEqual([
      "Open SpecWithCode on iPhone Duo.",
      "The code for m4 is at the top of the screen, under “Allow this phone”.",
      "Check that it also shows ID TSKR.",
    ]);
  });

  it("never tells an iPhone that reports a new enough version to update", () => {
    for (const app of [
      "SpecWithCode 0.1.9",
      "SpecWithCode 0.1.10",
      "SpecWithCode 0.2.0",
      "SpecWithCode 1.0.0",
    ]) {
      expect(codePlace({ ...first, app }), app).toBe("phone-top");
      expect(codeSteps({ ...first, app }, "m4").join(" ")).not.toContain("Update");
    }
  });

  it("points an iPhone that reports no version, or an older one, at a chat and at an update", async () => {
    for (const app of ["SpecWithCode", "SpecWithCode 0.1.8"])
      expect(codePlace({ ...first, app }), app).toBe("phone-chat");
    // A browser on an iPhone, and an iPad, get the general steps.
    for (const app of ["Safari", "Chrome"])
      expect(codePlace({ ...first, app }), app).toBe("unknown");
    expect(codePlace({ ...first, deviceType: "tablet", app: "SpecWithCode 0.1.9" })).toBe(
      "unknown",
    );
    const { app: _app, ...noApp } = first;
    expect(codePlace(noApp)).toBe("phone-chat");
    await open([first]);
    expect(steps()).toEqual([
      "On iPhone, open a chat on m4 in SpecWithCode. The code is there.",
      "No code there? Update SpecWithCode on iPhone, then open it again.",
      "Check that it also shows ID TSKR.",
    ]);
    // The code box, Deny and Later stay.
    expect(codeBox()).not.toBeNull();
    expect(button("Deny")).toBeDefined();
    expect(button("Later")).toBeDefined();
  });

  it("names the waiting card for a desktop app and stays general for anything else", () => {
    const mac = {
      ...first,
      deviceType: "desktop",
      system: "macOS",
      app: "SpecWithCode 1.0.407",
      label: "MacBook",
    };
    expect(codePlace(mac)).toBe("window");
    expect(codeSteps(mac, "m4")).toEqual([
      "Open SpecWithCode on MacBook.",
      "The code for m4 is on a card in the app, and in Settings > Machines under “Waiting to join”.",
      "Check that it also shows ID TSKR.",
    ]);
    // A name cannot reorder or break a step.
    expect(codeSteps({ ...mac, label: "Mac\u202e\nBook" }, "m4")[0]).toBe(
      "Open SpecWithCode on MacBook.",
    );
    const { shortId: _shortId, ...unnamed } = first;
    const android = { ...unnamed, system: "Android", app: "SpecWithCode 0.1.9" };
    expect(codePlace(android)).toBe("unknown");
    expect(codeSteps(android, "m4")).toEqual([
      "Open SpecWithCode on iPhone.",
      "The code is shown where it lists m4 as waiting for approval.",
    ]);
  });

  it("gives one general line when several devices wait", async () => {
    await open([first, second]);
    expect(where().dataset.deviceApprovalWhere).toBe("several");
    expect(steps()).toEqual([]);
    expect(where().textContent).toContain(
      "On an iPhone, look at the top of the screen or in a chat on m4.",
    );
  });
});

describe("Later kept by the machine (1447)", () => {
  it("takes the machine's word alone when it keeps Later, and the window's when it keeps none", () => {
    const local = new Set([laterKey(first)]);
    expect(laterKeys(local, undefined)).toBe(local);
    // The machine keeps Later and lists nothing: the window's old copy hides nothing.
    expect(requestsToPrompt([first, second], laterKeys(local, []))).toEqual([first, second]);
    const both = laterKeys(local, ["reference-of-request-a", "reference-of-request-b"]);
    expect(requestsToPrompt([first, second], both)).toEqual([]);
    // The machine's list hides by device reference only, never by short ID or request.
    const twin = phone("request-z", "9229", first.askedAt);
    expect(requestsToPrompt([twin], both)).toEqual([twin]);
  });
});

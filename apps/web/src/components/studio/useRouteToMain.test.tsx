// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { MainOffer } from "../../studio/makeMain";
import type { MainSwitchAfter } from "./useMakeMain";

const state = vi.hoisted(() => ({
  connected: new Set<string>(),
  operate: true,
  routeSend: vi.fn(),
}));

vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { send: "send" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.routeSend }));
vi.mock("../../state/environments", () => ({
  useEnvironment: (environmentId: string | null) =>
    environmentId === null
      ? null
      : {
          environmentId,
          connection: { phase: state.connected.has(environmentId) ? "connected" : "offline" },
        },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.operate }));

const { useCoordinatorBox } = await import("./useRouteToMain");
const { getProjectCoordinatorComposer } = await import("../../studio/projectCoordinatorComposer");
type Box = ReturnType<typeof useCoordinatorBox>;
type Props = Parameters<typeof useCoordinatorBox>[0];

const takeover: MainOffer = {
  key: "m5:p",
  machine: "M5",
  main: "M4",
  kind: "takeover",
  reason: null,
  note: null,
  block: null,
  silentMinutes: 14,
};
const move: MainOffer = {
  key: "m5:p",
  machine: "M5",
  main: "M4",
  kind: "move",
  reason: null,
  note: null,
  block: null,
};

let root: Root, container: HTMLDivElement;
let box: Box;
let composer: ReturnType<typeof getProjectCoordinatorComposer>;
let props: Props;
const onOpen = vi.fn<(key: string) => void>();
const onContinue = vi.fn<(key: string, after?: MainSwitchAfter) => void>();
const sendHere = vi.fn<(text: string) => Promise<unknown>>();

function Page(input: Props) {
  box = useCoordinatorBox(input);
  return null;
}
const render = (over: Partial<Props> = {}) => {
  props = { ...props, ...over };
  return act(async () => root.render(<Page {...props} />));
};
/** What `onContinue` was last told to call back. */
const after = () => onContinue.mock.calls.at(-1)![1]!;
const file = { id: "f1", type: "file", name: "plan.pdf" } as never;
/** How a send ended, caught at once so a refusal is never left unhandled. */
const outcomeOf = (sent: Promise<void>) =>
  sent.then(
    () => "sent",
    (cause: Error) => cause.message,
  );

let draft = 0;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.connected = new Set(["m4"]);
  state.operate = true;
  state.routeSend.mockReset();
  state.routeSend.mockResolvedValue({ _tag: "Success", value: {} });
  for (const mock of [onOpen, onContinue, sendHere]) mock.mockReset();
  sendHere.mockResolvedValue(undefined);
  // A fresh draft per test: drafts are kept per checkout for the window's life.
  composer = getProjectCoordinatorComposer("m5", `p${(draft += 1)}`);
  props = {
    mainKey: "m4:p",
    machine: "M4",
    project: "Atlas",
    copyOff: true,
    mainLive: true,
    onOpen,
    composer,
    offer: move,
    onContinue,
    sendHere,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("sends to the coordinator on its machine, then opens its page, while it answers", async () => {
  await render();
  expect(box.routes).toBe(true);
  expect(box.state?.kind).toBe("routes");
  expect(box.state?.send.text).toBe("Send");
  expect(box.primary).toBeNull();
  await act(async () => box.send("Plan the release"));
  expect(state.routeSend).toHaveBeenCalledTimes(1);
  expect(state.routeSend.mock.calls[0]![0]).toMatchObject({
    environmentId: "m4",
    input: { projectId: "p", prompt: "Plan the release" },
  });
  expect(onOpen).toHaveBeenCalledWith("m4:p");
  expect(sendHere).not.toHaveBeenCalled();
  expect(onContinue).not.toHaveBeenCalled();
});

it("has no box state while the coordinator is on the machine shown", async () => {
  await render({ copyOff: false, mainKey: null, machine: null });
  expect(box.state).toBeNull();
  expect(box.primary).toBeNull();
});

it("continues here and sends locally only once the page shows the coordinator here", async () => {
  state.connected = new Set();
  await render({ offer: takeover });
  expect(box.state?.kind).toBe("silent");
  expect(box.primary).toEqual({ text: "Continue here and send" });
  let settled = false;
  let sent!: Promise<void>;
  await act(async () => {
    sent = box.send("Pick up the plan").then(() => {
      settled = true;
    });
  });
  // The existing takeover runs first; nothing is routed to the silent machine.
  expect(onContinue).toHaveBeenCalledTimes(1);
  expect(onContinue.mock.calls[0]![0]).toBe("m5:p");
  expect(state.routeSend).not.toHaveBeenCalled();
  expect(sendHere).not.toHaveBeenCalled();
  // Continued, but this page still shows the coordinator elsewhere: no local send yet.
  await act(async () => after().continued());
  expect(sendHere).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  await render({ copyOff: false });
  expect(sendHere).toHaveBeenCalledTimes(1);
  expect(sendHere).toHaveBeenCalledWith("Pick up the plan");
  await act(async () => sent);
  expect(settled).toBe(true);
  expect(state.routeSend).not.toHaveBeenCalled();
});

it("sends nothing when the takeover is put away, refused or fails", async () => {
  state.connected = new Set();
  await render({ offer: takeover });
  let sent!: Promise<string>;
  await act(async () => {
    sent = outcomeOf(box.send("Pick up the plan"));
  });
  await act(async () => after().stopped());
  expect(await sent).toBe("Nothing was sent.");
  await render({ copyOff: false });
  expect(sendHere).not.toHaveBeenCalled();
  expect(state.routeSend).not.toHaveBeenCalled();
});

it("only continues here for a draft with files, which never travel in the same step", async () => {
  state.connected = new Set();
  await act(async () => composer.setAttachments([file]));
  await render({ offer: takeover });
  expect(box.state?.send.text).toBe("Continue here");
  expect(box.primary?.text).toBe("Continue here");
  // The button runs the switch on its own, and sends nothing.
  await act(async () => box.primary!.run!());
  expect(onContinue).toHaveBeenCalledWith("m5:p");
  expect(onContinue.mock.calls[0]).toHaveLength(1);
  // A send with the files continues the coordinator and keeps the draft, with the reason.
  let sent!: Promise<string>;
  await act(async () => {
    sent = outcomeOf(box.send("With the attachment", [file]));
  });
  await act(async () => after().continued());
  expect(await sent).toBe("The coordinator continues here. Send your message again.");
  await render({ copyOff: false });
  expect(sendHere).not.toHaveBeenCalled();
  expect(state.routeSend).not.toHaveBeenCalled();
});

it("gives a continued send up when the coordinator does not show here in time", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  state.connected = new Set();
  await render({ offer: takeover });
  let outcome!: Promise<string>;
  await act(async () => {
    outcome = outcomeOf(box.send("Pick up the plan"));
  });
  await act(async () => after().continued());
  await act(async () => vi.advanceTimersByTime(20_000));
  expect(await outcome).toBe("The coordinator continues here. Send your message again.");
  await render({ copyOff: false });
  expect(sendHere).not.toHaveBeenCalled();
});

it("refuses a routed draft with files before anything is sent", async () => {
  await render();
  await expect(box.send("With the attachment", [file])).rejects.toThrow(
    "Files stay on this machine. Remove them to send the text, or open Atlas on M4 to attach them there.",
  );
  expect(state.routeSend).not.toHaveBeenCalled();
});

it("says the routed send could not reach the coordinator's machine", async () => {
  state.connected = new Set();
  await render({ offer: null });
  await expect(box.send("Hello")).rejects.toThrow(
    "The coordinator's machine is not reachable from here.",
  );
  state.connected = new Set(["m4"]);
  state.routeSend.mockResolvedValue({ _tag: "Failure", cause: "no answer" });
  await render();
  await expect(box.send("Hello")).rejects.toThrow(
    "The coordinator's machine did not confirm the message. It may not have arrived.",
  );
  expect(onOpen).not.toHaveBeenCalled();
});

it("never says nothing was sent when the connection dropped under the send", async () => {
  // A lost socket may have carried the message: it is not that machine's refusal.
  const lost = Object.assign(new Error("Socket closed"), { _tag: "RpcClientError" });
  state.routeSend.mockResolvedValue({ _tag: "Failure", cause: lost });
  await render();
  let said = "";
  await act(async () => {
    said = await outcomeOf(box.send("Hello"));
  });
  expect(said).toBe("Socket closed");
  expect(box.state?.kind).toBe("routes");
  expect(onOpen).not.toHaveBeenCalled();
});

it("says why the coordinator's machine refused a message, until the next send", async () => {
  state.routeSend.mockResolvedValue({
    _tag: "Failure",
    cause: new Error("The coordinator is paused."),
  });
  await render();
  let said = "";
  await act(async () => {
    said = await outcomeOf(box.send("Hello"));
  });
  expect(said).toBe("The coordinator is paused.");
  expect(box.state?.kind).toBe("refused");
  expect(box.state?.line).toEqual({
    text: "{machine} did not take the message: {reason}. Nothing was sent.",
    values: { machine: "M4", reason: "The coordinator is paused" },
  });
  // Send and Continue here both stay on, and nothing opened another page.
  expect(box.state?.send.enabled).toBe(true);
  expect(box.state?.continueHere?.enabled).toBe(true);
  expect(onOpen).not.toHaveBeenCalled();
  state.routeSend.mockResolvedValue({ _tag: "Success", value: {} });
  await act(async () => box.send("Hello"));
  expect(box.state?.kind).toBe("routes");
  expect(onOpen).toHaveBeenCalledWith("m4:p");
});

it("says the coordinator moved while a message was typed, until it is sent or cleared", async () => {
  state.connected = new Set(["m4", "linux-mini"]);
  await render();
  await act(async () => composer.setPrompt("Half a thought"));
  await render({ mainKey: "linux-mini:p", machine: "linux-mini" });
  expect(box.state?.kind).toBe("moved");
  expect(box.state?.line).toEqual({
    text: "The coordinator moved to {new}. Nothing was sent.",
    values: { new: "linux-mini" },
  });
  // Send goes to the new machine, and the line is done.
  expect(box.state?.send).toMatchObject({ text: "Send", enabled: true });
  await act(async () => box.send("Half a thought"));
  expect(state.routeSend.mock.calls[0]![0]).toMatchObject({ environmentId: "linux-mini" });
  await render();
  expect(box.state?.kind).toBe("routes");
});

it("does not say the coordinator moved when nothing was typed, and forgets it once cleared", async () => {
  state.connected = new Set(["m4", "linux-mini"]);
  await render();
  await render({ mainKey: "linux-mini:p", machine: "linux-mini" });
  expect(box.state?.kind).toBe("routes");
  await act(async () => composer.setPrompt("Half a thought"));
  await render({ mainKey: "m4:p", machine: "M4" });
  expect(box.state?.kind).toBe("moved");
  await act(async () => composer.setPrompt(""));
  await render();
  expect(box.state?.kind).toBe("routes");
});

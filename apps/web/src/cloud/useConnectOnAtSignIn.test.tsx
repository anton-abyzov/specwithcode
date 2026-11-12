import { act } from "react";
import { create } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ConnectAtSignIn } from "./connectOnboarding";
import { useConnectOnAtSignIn } from "./useConnectOnAtSignIn";

type Api = ReturnType<typeof useConnectOnAtSignIn>;

function Harness(props: {
  readonly decision: ConnectAtSignIn;
  readonly busy?: boolean;
  readonly turnOn: () => Promise<boolean>;
  readonly onTurnedOn: (account: string) => void;
  readonly api: (api: Api) => void;
}) {
  const api = useConnectOnAtSignIn({
    decide: () => props.decision,
    busy: props.busy ?? false,
    turnOn: props.turnOn,
    onTurnedOn: props.onTurnedOn,
  });
  props.api(api);
  return null;
}

async function mount(decision: ConnectAtSignIn, turnOn: () => Promise<boolean>, busy = false) {
  const onTurnedOn = vi.fn();
  let api: Api | null = null;
  const element = (next: ConnectAtSignIn, nextBusy = busy) => (
    <Harness
      decision={next}
      busy={nextBusy}
      turnOn={turnOn}
      onTurnedOn={onTurnedOn}
      api={(value) => {
        api = value;
      }}
    />
  );
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(element(decision));
  });
  return {
    onTurnedOn,
    api: () => api!,
    rerender: (next: ConnectAtSignIn, nextBusy = false) =>
      act(async () => renderer!.update(element(next, nextBusy))),
    unmount: () => act(async () => renderer!.unmount()),
  };
}

describe("turning SpecWithCode Connect on at sign-in", () => {
  it("does nothing until a sign-in is named", async () => {
    const turnOn = vi.fn(async () => true);
    const view = await mount("turn-on", turnOn);
    expect(turnOn).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("turns it on once for a sign-in, however often the screen renders after", async () => {
    const turnOn = vi.fn(async () => true);
    const view = await mount("turn-on", turnOn);
    await act(async () => view.api().request("user_a"));
    expect(turnOn).toHaveBeenCalledOnce();
    expect(view.onTurnedOn).toHaveBeenCalledExactlyOnceWith("user_a");
    await view.rerender("turn-on");
    await view.rerender("turn-on");
    expect(turnOn).toHaveBeenCalledOnce();
    expect(view.api().applying).toBe(false);
    await view.unmount();
  });
  it("waits for the decision, then acts on it", async () => {
    const turnOn = vi.fn(async () => true);
    const view = await mount("wait", turnOn);
    await act(async () => view.api().request("user_a"));
    expect(turnOn).not.toHaveBeenCalled();
    await view.rerender("turn-on");
    expect(turnOn).toHaveBeenCalledOnce();
    await view.unmount();
  });
  it("ends the request on skip, so a later change of mind cannot turn it on", async () => {
    const turnOn = vi.fn(async () => true);
    const view = await mount("skip", turnOn);
    await act(async () => view.api().request("user_a"));
    await view.rerender("turn-on");
    expect(turnOn).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("holds back while another change to the link is in flight, and when cancelled", async () => {
    const turnOn = vi.fn(async () => true);
    const view = await mount("turn-on", turnOn, true);
    await act(async () => view.api().request("user_a"));
    expect(turnOn).not.toHaveBeenCalled();
    await act(async () => view.api().cancel());
    await view.rerender("turn-on", false);
    expect(turnOn).not.toHaveBeenCalled();
    await view.unmount();
  });
  it("decides a second account's request once the first turn-on ends", async () => {
    const calls: Array<(ok: boolean) => void> = [];
    const turnOn = vi.fn(() => new Promise<boolean>((resolve) => calls.push(resolve)));
    const view = await mount("turn-on", turnOn);
    await act(async () => view.api().request("user_a"));
    await act(async () => view.api().request("user_b"));
    expect(turnOn).toHaveBeenCalledOnce();
    await act(async () => calls[0]!(false));
    expect(turnOn).toHaveBeenCalledTimes(2);
    await act(async () => calls[1]!(true));
    expect(view.onTurnedOn).toHaveBeenCalledExactlyOnceWith("user_b");
    expect(view.api().applying).toBe(false);
    await view.unmount();
  });
  it("says nothing for an account that signed out while it was being turned on", async () => {
    const calls: Array<(ok: boolean) => void> = [];
    const turnOn = vi.fn(() => new Promise<boolean>((resolve) => calls.push(resolve)));
    const view = await mount("turn-on", turnOn);
    await act(async () => view.api().request("user_a"));
    await act(async () => view.api().cancel());
    await act(async () => calls[0]!(true));
    expect(view.onTurnedOn).not.toHaveBeenCalled();
    expect(view.api().applying).toBe(false);
    await view.unmount();
  });
  it("does not say it is on when turning it on failed", async () => {
    const failed = await mount(
      "turn-on",
      vi.fn(async () => false),
    );
    await act(async () => failed.api().request("user_a"));
    expect(failed.onTurnedOn).not.toHaveBeenCalled();
    expect(failed.api().applying).toBe(false);
    await failed.unmount();
    const threw = await mount(
      "turn-on",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await act(async () => threw.api().request("user_a"));
    expect(threw.onTurnedOn).not.toHaveBeenCalled();
    expect(threw.api().applying).toBe(false);
    await threw.unmount();
  });
});

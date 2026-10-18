// @vitest-environment jsdom
import { EnvironmentId, type ComputerUsePermissions } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  beginComputerUsePermissionWait,
  endComputerUsePermissionWait,
  useComputerUsePermissionWait,
} from "../../state/computerUsePermissionWait";
import {
  ComputerUsePermissionCard,
  ComputerUsePermissionSetup,
  ComputerUseRetryContext,
} from "./ComputerUsePermissions";

const local = EnvironmentId.make("m4");
const remote = EnvironmentId.make("m1");

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => local }));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: string | null) => ({ label: id === "m1" ? "M1" : "M4 Max" }),
}));

let status: ComputerUsePermissions;
const requestComputerUsePermission = vi.fn(async () => status);
const relaunchForComputerUse = vi.fn(async () => undefined);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = { screenRecording: false, accessibility: false };
  Object.assign(window, {
    desktopBridge: {
      getComputerUsePermissions: async () => status,
      requestComputerUsePermission,
      relaunchForComputerUse,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, "desktopBridge");
});

type RenderedNode = ReturnType<ReactTestRenderer["toJSON"]>;
const textOf = (node: RenderedNode | string): string => {
  if (node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return (node.children ?? []).map(textOf).join("");
};
const text = (renderer: ReactTestRenderer) => textOf(renderer.toJSON());
const buttons = (renderer: ReactTestRenderer, label: string) =>
  renderer.root.findAll(
    (node) => node.type === "button" && JSON.stringify(node.props.children).includes(label),
  );
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

it("asks macOS on Allow, then offers to ask the agent to try again once granted", async () => {
  const retry = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <ComputerUseRetryContext value={retry}>
        <ComputerUsePermissionCard permission="screen-recording" environmentId={local} />
      </ComputerUseRetryContext>,
    );
  });
  await flush();
  expect(text(renderer)).toContain("Computer use needs Screen Recording");
  expect(text(renderer)).toContain("The agent stopped waiting");

  await act(() => buttons(renderer, "Allow")[0]!.props.onClick());
  expect(requestComputerUsePermission).toHaveBeenCalledWith("screen-recording");
  await flush();
  // Still missing after Allow: offer the reopen macOS may need.
  expect(buttons(renderer, "Quit & Reopen")).toHaveLength(1);
  await act(() => buttons(renderer, "Quit & Reopen")[0]!.props.onClick());
  expect(relaunchForComputerUse).toHaveBeenCalled();

  status = { screenRecording: true, accessibility: false };
  await act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await flush();
  expect(text(renderer)).toContain("Screen Recording is allowed.");
  await act(() => buttons(renderer, "Ask the agent to try again")[0]!.props.onClick());
  expect(retry).toHaveBeenCalledWith(
    "Screen Recording is allowed for SpecWithCode now. Please try again.",
  );
  expect(text(renderer)).toContain("Asked the agent");
  await act(() => renderer.unmount());
});

it("explains where to allow it when the thread runs on another machine", async () => {
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      <ComputerUsePermissionCard permission="accessibility" environmentId={remote} />,
    );
  });
  expect(text(renderer)).toContain("On M1, open the SpecWithCode app");
  expect(buttons(renderer, "Allow")).toHaveLength(0);
  await act(() => renderer.unmount());
});

it("lists both permissions under Settings with their live status", async () => {
  status = { screenRecording: true, accessibility: false };
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<ComputerUsePermissionSetup environmentId={local} />);
  });
  await flush();
  expect(text(renderer)).toContain("Screen Recording");
  expect(text(renderer)).toContain("Allowed");
  expect(buttons(renderer, "Allow")).toHaveLength(1);
  await act(() => buttons(renderer, "Allow")[0]!.props.onClick());
  expect(requestComputerUsePermission).toHaveBeenCalledWith("accessibility");
  await act(() => renderer.unmount());
});

it("tracks which thread waits for a permission until its action settles", async () => {
  let seen: string | null = "unset";
  function Probe({ threadId }: { threadId: string }) {
    seen = useComputerUsePermissionWait(threadId);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<Probe threadId="t1" />);
  });
  expect(seen).toBe(null);
  let first!: symbol;
  await act(() => {
    first = beginComputerUsePermissionWait("t1", "accessibility");
  });
  expect(seen).toBe("accessibility");
  let second!: symbol;
  await act(() => {
    second = beginComputerUsePermissionWait("t1", "screen-recording");
  });
  // An older action settling does not clear the newer one's card.
  await act(() => endComputerUsePermissionWait("t1", first));
  expect(seen).toBe("screen-recording");
  await act(() => endComputerUsePermissionWait("t1", second));
  expect(seen).toBe(null);
  await act(() => renderer.unmount());
});

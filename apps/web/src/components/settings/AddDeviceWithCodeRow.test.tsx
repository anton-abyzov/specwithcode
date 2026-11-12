import { act } from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  primary: { environmentId: "env-here", label: "M4" } as { environmentId: string } | null,
  canApprove: true,
  acceptsBrowsers: true,
  scopeAskedFor: [] as Array<string | null>,
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironment: () => state.primary }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (environmentId: string | null) => {
    state.scopeAskedFor.push(environmentId);
    return state.canApprove;
  },
  useEnvironmentAcceptsBrowserSignIn: () => state.acceptsBrowsers,
}));
vi.mock("../account/SignInAnotherDeviceDialog", () => ({
  SignInAnotherDeviceDialog: (props: { open: boolean; acceptsBrowsers: boolean }) => (
    <div
      data-dialog=""
      data-open={String(props.open)}
      data-accepts={String(props.acceptsBrowsers)}
    />
  ),
}));

import type { EnvironmentId } from "@specweave-studio/contracts";

import {
  AddDeviceWithCodeRow,
  AddDeviceWithCodeRowView,
  useCanAddDeviceWithCode,
} from "./AddDeviceWithCodeRow";

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

async function mount(element: React.ReactElement) {
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(element);
  });
  return renderer!;
}

beforeEach(() => {
  state.primary = { environmentId: "env-here" };
  state.canApprove = true;
  state.acceptsBrowsers = true;
  state.scopeAskedFor = [];
});

describe("Add a device with a code, in Settings > Machines", () => {
  it("says the code path is for a browser and that the app on the same account needs no code", async () => {
    const onOpen = vi.fn();
    const renderer = await mount(<AddDeviceWithCodeRowView onOpen={onOpen} />);
    const text = textOf(renderer.root);
    expect(text).toContain("Add a device with a code");
    expect(text).toContain("from a browser on a phone or another computer");
    expect(text).toContain("also when SpecWithCode Connect is off or cannot be reached");
    expect(text).toContain(
      "The SpecWithCode app signed in to the same Connect account needs no code.",
    );
    // A browser that opens this machine's address always needs the code, with Connect too.
    expect(text).not.toContain("With Connect, sign in on the other device");
    const button = renderer.root.findByType("button");
    expect(textOf(button)).toBe("Add a device");
    await act(async () => button.props.onClick());
    expect(onOpen).toHaveBeenCalledOnce();
    // Settings search and the other device's instructions can point at the row.
    expect(renderer.root.findByProps({ id: "private-machines-device-code" })).toBeDefined();
  });

  it("opens the code dialog for this machine from its button", async () => {
    state.acceptsBrowsers = false;
    const renderer = await mount(<AddDeviceWithCodeRow />);
    const dialog = () => renderer.root.findByProps({ "data-dialog": "" });
    expect(dialog().props["data-open"]).toBe("false");
    expect(dialog().props["data-accepts"]).toBe("false");
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(dialog().props["data-open"]).toBe("true");
  });

  it("is offered only for the machine this window is served from, to a window that may approve", async () => {
    const answers: boolean[] = [];
    function Probe({ id }: { id: string | null }) {
      answers.push(useCanAddDeviceWithCode(id as EnvironmentId | null));
      return null;
    }
    const check = async (id: string | null) => {
      answers.length = 0;
      const renderer = await mount(<Probe id={id} />);
      await act(async () => renderer.unmount());
      return answers.at(-1);
    };
    expect(await check("env-here")).toBe(true);
    // Another machine's page: its own address and approvals are not this window's to offer.
    expect(await check("env-other")).toBe(false);
    expect(await check(null)).toBe(false);
    state.canApprove = false;
    expect(await check("env-here")).toBe(false);
    state.canApprove = true;
    state.primary = null;
    expect(await check("env-here")).toBe(false);
    // The permission asked about is this machine's, never the viewed machine's.
    state.primary = { environmentId: "env-here" };
    state.scopeAskedFor = [];
    await check("env-other");
    expect(new Set(state.scopeAskedFor)).toEqual(new Set(["env-here"]));
  });
});

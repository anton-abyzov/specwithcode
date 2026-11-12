import { act, type ReactNode } from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  setOpenMobile: vi.fn(),
  isMobile: false,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "env-here", label: "M4" }),
  usePullRequestsSupported: () => false,
}));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../keybindings", () => ({ shortcutLabelForCommand: () => null }));
vi.mock("../pullRequest/pullRequestIcons", () => ({
  PullRequestGlyph: { pullRequest: () => null },
}));
vi.mock("../pullRequest/pullRequestListPreferences", () => ({
  readPullRequestListPreferences: () => ({}),
}));
vi.mock("../settings/AddDeviceWithCodeRow", () => ({
  ADD_DEVICE_OR_MACHINE_ANCHOR: "machines-join-card",
}));
vi.mock("../ui/menu", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Menu: Pass,
    MenuGroup: Pass,
    MenuGroupLabel: Pass,
    MenuPopup: Pass,
    MenuSeparator: () => null,
    MenuShortcut: Pass,
    MenuTrigger: () => null,
    MenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("../ui/sidebar", () => ({
  SidebarMenuButton: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SidebarMenuItem: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useSidebar: () => ({ isMobile: state.isMobile, setOpenMobile: state.setOpenMobile }),
}));
vi.mock("../ui/tooltip", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Tooltip: Pass, TooltipPopup: () => null, TooltipTrigger: Pass };
});

import { AccountMenu, AccountMenuView } from "./AccountMenu";

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
const items = (renderer: ReturnType<typeof create>) =>
  renderer.root.findAllByType("button").map((button) => textOf(button));
const item = (renderer: ReturnType<typeof create>, label: string) =>
  renderer.root.findAllByType("button").find((button) => textOf(button) === label)!;

beforeEach(() => {
  state.navigate.mockReset();
  state.setOpenMobile.mockReset();
  state.isMobile = false;
});

describe("the account menu's way to add a device or a machine", () => {
  it("has one entry, named for both, and no code dialog of its own", async () => {
    const onAddDevice = vi.fn();
    const renderer = await mount(
      <AccountMenuView
        compact={false}
        machine="M4"
        connect={null}
        usageShortcut={null}
        pullRequestsSupported={false}
        onNavigate={vi.fn()}
        onOpenPullRequests={vi.fn()}
        onAddDevice={onAddDevice}
      />,
    );
    expect(items(renderer)).toContain("Add a device or machine");
    expect(items(renderer)).not.toContain("Add a device with a code");
    expect(items(renderer)).toContain("Machines and connections");
    await act(async () => item(renderer, "Add a device or machine").props.onClick());
    expect(onAddDevice).toHaveBeenCalledOnce();
  });

  it("opens Settings > Machines at the join card", async () => {
    const renderer = await mount(<AccountMenu compact={false} connect={null} />);
    await act(async () => item(renderer, "Add a device or machine").props.onClick());
    expect(state.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/settings/machines",
      hash: "machines-join-card",
    });
    expect(state.setOpenMobile).not.toHaveBeenCalled();
  });

  it("closes the phone sidebar before it opens Settings > Machines", async () => {
    state.isMobile = true;
    const renderer = await mount(<AccountMenu compact={false} connect={null} />);
    await act(async () => item(renderer, "Add a device or machine").props.onClick());
    expect(state.setOpenMobile).toHaveBeenCalledExactlyOnceWith(false);
    expect(state.navigate).toHaveBeenCalledOnce();
  });
});

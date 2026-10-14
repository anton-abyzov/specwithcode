import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, it, expect, vi, afterEach } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, type ManagedUpdateStatus } from "@specweave-studio/contracts";
const mock = vi.hoisted(() => ({
  query: { data: null as unknown, error: null, isPending: false, refresh: vi.fn() },
  enroll: vi.fn(),
  revoke: vi.fn(),
  check: vi.fn(),
  confirm: vi.fn(),
  native: vi.fn(),
}));
vi.mock("../../state/managedUpdates", () => ({
  managedUpdates: { status: () => null, enroll: "enroll", revoke: "revoke", check: "check" },
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => mock.query }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (action: "enroll" | "revoke" | "check") => mock[action],
}));
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: mock.confirm }));
vi.mock("../ServerUpdateAction", () => ({ ServerUpdateProgress: () => null }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));
import { ManagedUpdatesView, ManagedUpdatesSection } from "./ManagedUpdatesSection";
const status: ManagedUpdateStatus = {
  environmentId: EnvironmentId.make("dest"),
  installationId: "desk",
  support: "supported",
  localAutomation: "enabled",
  remoteConsent: "not-enrolled",
  revision: 0,
  operation: "up-to-date",
  currentVersion: "1.0.17",
  availableVersion: null,
  checkedAt: null,
};
const props = {
  label: "Office Mac",
  reachable: true,
  status,
  error: false,
  canManage: false,
  canCheck: true,
  pending: false,
  onAllow: vi.fn(),
  onRevoke: vi.fn(),
  onCheck: vi.fn(),
  onRefresh: vi.fn(),
};
describe("managed updates permission and reachability", () => {
  it("keeps existing automatic updates distinct from absent remote permission", () => {
    const html = renderToStaticMarkup(<ManagedUpdatesView {...props} />);
    expect(html).toContain("Automatic updates: enabled");
    expect(html).toContain("no update permission");
    expect(html).toContain("administrator must approve");
    expect(html).toMatch(/disabled="">Allow this connection/);
    expect(html).toMatch(/disabled="">Check only/);
    expect(props.onAllow).not.toHaveBeenCalled();
  });
  it("never labels unreachable or failed reads as unenrolled", () => {
    for (const changes of [{ reachable: false }, { error: true }]) {
      const html = renderToStaticMarkup(<ManagedUpdatesView {...props} {...changes} />);
      expect(html).not.toContain("no update permission");
      expect(html).not.toContain("Allow this connection");
    }
  });
  it("offers check-only and revocation for an approved reachable destination", () => {
    const html = renderToStaticMarkup(
      <ManagedUpdatesView {...props} canManage status={{ ...status, remoteConsent: "enrolled" }} />,
    );
    expect(html).toContain("Revoke permission");
    expect(html).not.toMatch(/disabled="">Check only/);
    expect(html).toContain("does not download or install");
  });
  it("does not offer mutation for unmanaged installs or unavailable updater defaults", () => {
    const html = renderToStaticMarkup(
      <ManagedUpdatesView {...props} status={{ ...status, support: "unmanaged" }} />,
    );
    expect(html).not.toContain("Allow this connection");
    const absent = renderToStaticMarkup(
      <ManagedUpdatesView {...props} status={{ ...status, localAutomation: "unavailable" }} />,
    );
    expect(absent).toContain("updater not installed");
    expect(absent).not.toContain("Automatic updates: enabled");
  });
});

let rendered: ReactTestRenderer | undefined;
afterEach(async () => {
  if (rendered) await act(async () => rendered!.unmount());
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("requires explicit confirmation and sends the displayed destination and revision", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.query.data = { ...status, revision: 7 };
  mock.query.error = null;
  mock.enroll.mockResolvedValue({ _tag: "Success", value: status });
  await act(async () => {
    rendered = create(
      <ManagedUpdatesSection environmentId={status.environmentId} label="Office" reachable />,
    );
  });
  expect(mock.enroll).not.toHaveBeenCalled();
  const allow = () =>
    rendered!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Allow this connection")!;
  mock.confirm.mockResolvedValue(false);
  await act(async () => allow().props.onClick());
  expect(mock.enroll).not.toHaveBeenCalled();
  mock.confirm.mockResolvedValue(true);
  await act(async () => allow().props.onClick());
  expect(mock.enroll).toHaveBeenCalledWith({
    environmentId: status.environmentId,
    input: {
      installationId: "desk",
      environmentId: status.environmentId,
      expectedRevision: 7,
      consent: true,
    },
  });
  expect(mock.query.refresh).toHaveBeenCalled();
});
it("native cancellation never falls through to a remote administrator request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: { requestManagedUpdateConsent: mock.native } });
  mock.native.mockResolvedValue(null);
  mock.query.data = status;
  mock.query.error = null;
  await act(async () => {
    rendered = create(
      <ManagedUpdatesSection environmentId={status.environmentId} label="Office" reachable local />,
    );
  });
  await act(async () =>
    rendered!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Allow this connection")!
      .props.onClick(),
  );
  expect(mock.native).toHaveBeenCalledWith({
    action: "enroll",
    installationId: "desk",
    environmentId: status.environmentId,
    expectedRevision: 0,
  });
  expect(mock.enroll).not.toHaveBeenCalled();
  expect(mock.confirm).not.toHaveBeenCalled();
});
it("check-only sends no enrollment, configuration or installation request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mock.query.data = { ...status, remoteConsent: "enrolled" };
  mock.query.error = null;
  mock.check.mockResolvedValue({ _tag: "Success", value: status });
  await act(async () => {
    rendered = create(
      <ManagedUpdatesSection environmentId={status.environmentId} label="Office" reachable />,
    );
  });
  await act(async () =>
    rendered!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Check only")!
      .props.onClick(),
  );
  expect(mock.check).toHaveBeenCalledWith({
    environmentId: status.environmentId,
    input: { environmentId: status.environmentId, installationId: "desk" },
  });
  expect(mock.enroll).not.toHaveBeenCalled();
  expect(mock.revoke).not.toHaveBeenCalled();
  expect(mock.native).not.toHaveBeenCalled();
});

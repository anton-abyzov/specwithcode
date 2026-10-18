import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  providers: [] as unknown[],
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "mac", serverConfig: { providers: state.providers } }],
  }),
}));
vi.mock("../../state/server", () => ({ EMPTY_SERVER_PROVIDERS: [] }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: { kind: "project" }, target: { environmentId: "mac" } }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./AddApiCreditAccountDialog", () => ({
  AddApiCreditAccountDialog: ({ open, driver }: { open: boolean; driver: string }) =>
    open ? <div role="dialog" aria-label="Add an API account" data-driver={driver} /> : null,
}));
vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    "aria-label": string;
  }) => (
    <input
      type="checkbox"
      aria-label={props["aria-label"]}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
  AlertDialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingsRow: ({
    title,
    control,
    status,
  }: {
    title: string;
    control: ReactNode;
    status?: string;
  }) => (
    <section aria-label={title} data-status={status}>
      {control}
    </section>
  ),
  SettingResetButton: () => null,
}));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string | null;
    onValueChange: (v: string) => void;
  }) => (
    <select value={value ?? "mixed"} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
import { ProviderLimitSettings } from "./ProviderLimitSettings";
let renderer: ReactTestRenderer | undefined;
function row(title: string) {
  return renderer!.root.find((node) => node.props["aria-label"] === title).findByType("select");
}
function toggle(title: string) {
  return renderer!.root.find((node) => node.props["aria-label"] === title).findByType("input");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = resolveProjectSettings(
    DEFAULT_SERVER_SETTINGS,
    ProjectId.make("p"),
    null,
    null,
  ).settings;
  state.update.mockReset();
  state.providers = [];
  act(() => {
    renderer = create(<ProviderLimitSettings />);
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("defaults to switching automatically at 95 percent and waiting for a reset under 30 minutes", () => {
  expect(row("When a provider runs out").props.value).toBe("switch");
  expect(row("Switch before the limit").props.value).toBe("95");
  expect(row("Wait when the reset is close").props.value).toBe("30");
});
it("writes the reset wait", () => {
  act(() => row("Wait when the reset is close").props.onChange({ target: { value: "60" } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitWaitUnderMinutes: 60 });
  act(() => row("Wait when the reset is close").props.onChange({ target: { value: "0" } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitWaitUnderMinutes: 0 });
});
it("writes the rule and the threshold", () => {
  act(() => row("When a provider runs out").props.onChange({ target: { value: "switch" } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitAction: "switch" });
  act(() => row("Switch before the limit").props.onChange({ target: { value: "off" } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: null });
  act(() => row("Switch before the limit").props.onChange({ target: { value: "85" } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 85 });
});
function confirmButton(label: string) {
  const dialog = renderer!.root.find((node) => node.props.role === "alertdialog");
  return dialog.findAll((node) => node.type === "button" && node.children.join("") === label)[0]!;
}
it("keeps resets and credits off until asked, and confirms both before turning them on", () => {
  expect(toggle("Redeem a banked reset first").props.checked).toBe(false);
  expect(toggle("Spend Codex credits first").props.checked).toBe(false);
  act(() => toggle("Redeem a banked reset first").props.onChange({ target: { checked: true } }));
  expect(state.update).not.toHaveBeenCalledWith({ providerLimitRedeemResets: true });
  act(() => confirmButton("Redeem resets").props.onClick());
  expect(state.update).toHaveBeenCalledWith({ providerLimitRedeemResets: true });
  act(() => toggle("Spend Codex credits first").props.onChange({ target: { checked: true } }));
  expect(state.update).not.toHaveBeenCalledWith({ providerLimitSpendCredits: true });
  act(() => confirmButton("Spend credits").props.onClick());
  expect(state.update).toHaveBeenCalledWith({ providerLimitSpendCredits: true });
  act(() => toggle("Redeem a banked reset first").props.onChange({ target: { checked: false } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitRedeemResets: false });
});
it("keeps API credits off until asked, and confirms before turning them on", () => {
  expect(toggle("Use API credits first").props.checked).toBe(false);
  act(() => toggle("Use API credits first").props.onChange({ target: { checked: true } }));
  expect(state.update).not.toHaveBeenCalled();
  act(() => confirmButton("Use API credits").props.onClick());
  expect(state.update).toHaveBeenCalledWith({ providerLimitUseApiCredits: true });
  act(() => toggle("Use API credits first").props.onChange({ target: { checked: false } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitUseApiCredits: false });
});
it("names the API-key instance the rule will use, and ignores a proxy token", () => {
  const status = () =>
    renderer!.root.find(
      (node) => node.type === "section" && node.props["aria-label"] === "Use API credits first",
    ).props["data-status"];
  expect(status()).toContain("Needs a Claude API account");
  const instance = (instanceId: string, auth: object, extra: object = {}) => ({
    instanceId,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    models: [],
    auth,
    ...extra,
  });
  state.providers = [
    instance("claudeAgent", { status: "authenticated", type: "Claude Max" }),
    instance("router", { status: "authenticated", type: "apiKey" }),
  ];
  act(() => renderer!.update(<ProviderLimitSettings />));
  expect(status()).toContain("Needs a Claude API account");
  state.providers = [
    ...state.providers,
    instance(
      "claudeApi",
      { status: "unknown", apiKeyBilling: true },
      { displayName: "Claude API" },
    ),
  ];
  act(() => renderer!.update(<ProviderLimitSettings />));
  expect(status()).toBe("Continues on Claude API when it lists the thread's model");
  // The server skips an instance that cannot take a turn, so the row does not name it.
  const notReady = instance(
    "claudeOld",
    { status: "unknown", apiKeyBilling: true },
    { status: "warning", displayName: "Old key" },
  );
  state.providers = [notReady, ...state.providers];
  act(() => renderer!.update(<ProviderLimitSettings />));
  expect(status()).toBe("Continues on Claude API when it lists the thread's model");
  state.providers = [notReady];
  act(() => renderer!.update(<ProviderLimitSettings />));
  expect(status()).toBe("Old key is not ready, so nothing moves");
});
it("adds API accounts from the row and counts every ready one", () => {
  const addButton = (label: string) =>
    renderer!.root.find((node) => node.type === "button" && node.props.children === label);
  const dialogs = () =>
    renderer!.root.findAll(
      (node) => node.type === "div" && node.props["aria-label"] === "Add an API account",
    );
  expect(dialogs()).toHaveLength(0);
  act(() => addButton("Add an API key").props.onClick());
  expect(dialogs()[0]?.props["data-driver"]).toBe("claudeAgent");
  const key = (instanceId: string, displayName: string) => ({
    instanceId,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    models: [],
    auth: { status: "authenticated", type: "apiKey", apiKeyBilling: true },
    displayName,
  });
  state.providers = [key("claudeApi", "Hackathon 1"), key("claudeApi2", "Hackathon 2")];
  act(() => renderer!.update(<ProviderLimitSettings />));
  expect(
    renderer!.root.find(
      (node) => node.type === "section" && node.props["aria-label"] === "Use API credits first",
    ).props["data-status"],
  ).toBe("Continues on Hackathon 1, then the next of 2 API accounts");
  expect(addButton("Add another")).toBeDefined();
});

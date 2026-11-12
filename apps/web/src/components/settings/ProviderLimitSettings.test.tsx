import {
  DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  update: vi.fn(),
  providers: [] as unknown[],
  mixed: [] as string[],
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
  useScopedSettingsMixed: (keys: readonly string[]) =>
    keys.some((key) => state.mixed.includes(key)),
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./MachineFallbackSettings", () => ({ MachineFallbackSettings: () => null }));
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
vi.mock("../ui/input", () => ({ Input: (props: object) => <input {...props} /> }));
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
  useRelativeTimeTick: () => Date.now(),
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
  state.mixed = [];
  act(() => {
    renderer = create(<ProviderLimitSettings />);
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
it("defaults to switching automatically at 99 percent and waiting for a reset under 30 minutes", () => {
  expect(DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT).toBe(99);
  expect(row("When a provider runs out").props.value).toBe("switch");
  expect(row("Switch before the limit").props.value).toBe("99");
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
it("offers thresholds from 50 to 99 percent used, marks the default, and a custom value", () => {
  const options = row("Switch before the limit")
    .findAllByType("option")
    .map((option) => option.props.value);
  expect(options).toEqual([
    "off",
    "50",
    "60",
    "70",
    "75",
    "80",
    "85",
    "90",
    "95",
    "98",
    "99",
    "custom",
  ]);
  const labels = row("Switch before the limit")
    .findAllByType("option")
    .map((option) => option.children.join(""));
  expect(labels.slice(-4)).toEqual(["At 5% left", "At 2% left", "At 1% left (default)", "Custom…"]);
  expect(options).toContain(String(DEFAULT_PROVIDER_LIMIT_SWITCH_AT_PERCENT));
  act(() => row("Switch before the limit").props.onChange({ target: { value: "50" } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 50 });
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
it("follows the model tiers when no fallback order is set, and offers Only these models", () => {
  const section = (title: string) =>
    renderer!.root.findAll((node) => node.type === "section" && node.props["aria-label"] === title);
  expect(section("Fallback order")[0]!.props["data-status"]).toBe("Any ready provider");
  expect(section("Only these models")).toHaveLength(0);
  state.settings = {
    ...state.settings,
    modelLanes: {
      complex: [{ instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" }],
      routine: [],
    },
  };
  act(() => renderer!.update(<ProviderLimitSettings />));
  expect(section("Fallback order")[0]!.props["data-status"]).toBe("Uses your model tiers");
  expect(section("Only these models")).toHaveLength(1);
});

const switchAtSection = () =>
  renderer!.root.find(
    (node) => node.type === "section" && node.props["aria-label"] === "Switch before the limit",
  );
const customField = () =>
  switchAtSection().findAll(
    (node) =>
      node.type === "input" && node.props["aria-label"] === "Usage to switch at, in percent",
  );
const switchAtAlert = () =>
  switchAtSection().findAll((node) => node.type === "p" && node.props.role === "alert");
function rerender() {
  act(() => renderer!.update(<ProviderLimitSettings />));
}
function typeCustom(text: string, commit: "enter" | "blur" = "enter") {
  act(() => customField()[0]!.props.onChange({ currentTarget: { value: text } }));
  act(() =>
    commit === "enter"
      ? customField()[0]!.props.onKeyDown({ key: "Enter", preventDefault: () => {} })
      : customField()[0]!.props.onBlur(),
  );
}
it("takes a typed whole number with Custom… and saves it on Enter or blur", () => {
  expect(customField()).toHaveLength(0);
  act(() => row("Switch before the limit").props.onChange({ target: { value: "custom" } }));
  expect(state.update).not.toHaveBeenCalled();
  expect(row("Switch before the limit").props.value).toBe("custom");
  expect(customField()[0]!.props.value).toBe("99");
  typeCustom("93");
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 93 });
  typeCustom(" 100 ", "blur");
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 100 });
  expect(switchAtAlert()).toHaveLength(0);
});
it("shows a stored custom value as the selection after a reload", () => {
  state.settings = { ...state.settings, providerLimitSwitchAtPercent: 93 };
  act(() => renderer!.unmount());
  act(() => {
    renderer = create(<ProviderLimitSettings />);
  });
  expect(row("Switch before the limit").props.value).toBe("custom");
  expect(customField()[0]!.props.value).toBe("93");
  // Picking a preset closes the field again.
  act(() => row("Switch before the limit").props.onChange({ target: { value: "95" } }));
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 95 });
  state.settings = { ...state.settings, providerLimitSwitchAtPercent: 95 };
  rerender();
  expect(row("Switch before the limit").props.value).toBe("95");
  expect(customField()).toHaveLength(0);
});
it("refuses a typed value that is not a whole number from 50 to 100", () => {
  act(() => row("Switch before the limit").props.onChange({ target: { value: "custom" } }));
  for (const text of ["abc", "49", "101", "95.5", "-60", ""]) {
    typeCustom(text);
    expect(switchAtAlert().map((node) => node.children.join(""))).toEqual([
      "Enter a whole number from 50 to 100.",
    ]);
    expect(customField()[0]!.props["aria-invalid"]).toBe(true);
    expect(customField()[0]!.props.value).toBe(text);
  }
  expect(state.update).not.toHaveBeenCalled();
  typeCustom("97");
  expect(switchAtAlert()).toHaveLength(0);
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 97 });
});
it("starts a custom value empty while the early switch is off", () => {
  state.settings = { ...state.settings, providerLimitSwitchAtPercent: null };
  rerender();
  expect(row("Switch before the limit").props.value).toBe("off");
  act(() => row("Switch before the limit").props.onChange({ target: { value: "custom" } }));
  expect(customField()[0]!.props.value).toBe("");
  act(() => customField()[0]!.props.onBlur());
  expect(state.update).not.toHaveBeenCalled();
  typeCustom("80");
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 80 });
});
it("keeps the mixed state until a custom value is typed for every target", () => {
  state.mixed = ["providerLimitSwitchAtPercent"];
  rerender();
  expect(row("Switch before the limit").props.value).toBe("mixed");
  expect(customField()).toHaveLength(0);
  act(() => row("Switch before the limit").props.onChange({ target: { value: "custom" } }));
  expect(customField()[0]!.props.value).toBe("");
  expect(state.update).not.toHaveBeenCalled();
  typeCustom("99");
  expect(state.update).toHaveBeenCalledWith({ providerLimitSwitchAtPercent: 99 });
});

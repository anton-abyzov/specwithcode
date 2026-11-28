import { EnvironmentId, ProviderInstanceId } from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const actions = vi.hoisted(() => ({
  toast: vi.fn(),
  canManageProviders: true,
}));

const settingsHooks = vi.hoisted(() => ({
  read: vi.fn(() => ({ providerInstances: {} as Record<string, unknown> })),
  mutate: vi.fn(),
  useMutation: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: () => new Error("The settings update failed."),
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: settingsHooks.read,
  usePersistEnvironmentProviderInstanceMutation: settingsHooks.useMutation,
}));

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  const hasScope = (environmentId: EnvironmentId, scope: string) =>
    environmentId === "remote-device" && scope === "providers:manage" && actions.canManageProviders;
  return { ...actual, useEnvironmentScope: hasScope, readEnvironmentScope: hasScope };
});

vi.mock("../ui/toast", () => ({ toastManager: { add: actions.toast } }));

import { AddOpenModelDialog } from "./AddOpenModelDialog";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const remoteEnvironmentId = EnvironmentId.make("remote-device");

function render(onOpenChange = vi.fn(), onCreated = vi.fn()) {
  hooks.beginRender();
  return AddOpenModelDialog({
    open: true,
    environmentId: remoteEnvironmentId,
    onOpenChange,
    onCreated,
  });
}

type Tree = ReturnType<typeof render>;

function find(tree: Tree, accept: (props: Record<string, unknown>) => boolean) {
  return visitElements(tree, (element) => accept(element.props));
}

function tile(tree: Tree, presetId: string) {
  const element = find(tree, (props) => props["data-open-model-preset"] === presetId);
  if (!element) throw new Error(`Missing tile: ${presetId}`);
  return element;
}

function input(tree: Tree, id: string) {
  return find(tree, (props) => props.id === id);
}

function type(tree: Tree, id: string, value: string) {
  const element = input(tree, id);
  if (!element) throw new Error(`Missing input: ${id}`);
  (element.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}

function addButton(tree: Tree) {
  const element = find(
    tree,
    (props) => props.children === "Add model" && typeof props.onClick === "function",
  );
  if (!element) throw new Error("Missing Add model button");
  return element;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AddOpenModelDialog", () => {
  beforeEach(() => {
    hooks.reset();
    actions.canManageProviders = true;
    actions.toast.mockReset();
    settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
    settingsHooks.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
  });

  it("lists the six presets with their marks and the no-resale note", () => {
    const tree = render();
    for (const [id, brand] of [
      ["deepseek", "deepseek"],
      ["kimi", "kimi"],
      ["zai", "zai"],
      ["openrouter", "openrouter"],
      ["ollama", "ollama"],
      ["lmstudio", "lmstudio"],
    ] as const) {
      const logo = visitElements(tile(tree, id), (element) => element.props.brand === brand);
      expect(logo).not.toBeNull();
    }
    expect(
      find(
        tree,
        (props) =>
          props.children ===
          "Your key goes from this machine straight to the vendor. SpecWithCode never sells, pools or resells model access.",
      ),
    ).not.toBeNull();
    expect(find(tree, (props) => props.children === "Add an open model")).not.toBeNull();
    // Nothing is asked before a preset is chosen, and nothing can be saved.
    expect(input(tree, "open-model-key")).toBeNull();
    expect(addButton(tree).props.disabled).toBe(true);
  });

  it("asks a keyed preset only for its key, then saves it as a sensitive row", async () => {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    let tree = render(onOpenChange, onCreated);
    (tile(tree, "deepseek").props.onClick as () => void)();
    tree = render(onOpenChange, onCreated);
    expect(input(tree, "open-model-key")?.props.type).toBe("password");
    expect(input(tree, "open-model-model")).toBeNull();
    expect(input(tree, "open-model-address")).toBeNull();
    expect(find(tree, (props) => props.children === "Get a key")?.props.href).toBe(
      "https://platform.deepseek.com/api_keys",
    );
    expect(addButton(tree).props.disabled).toBe(true);

    type(tree, "open-model-key", "sk-test-deepseek");
    tree = render(onOpenChange, onCreated);
    expect(addButton(tree).props.disabled).toBe(false);
    (addButton(tree).props.onClick as () => void)();
    await flush();

    expect(settingsHooks.useMutation).toHaveBeenCalledWith(remoteEnvironmentId);
    expect(settingsHooks.mutate).toHaveBeenCalledOnce();
    const payload = settingsHooks.mutate.mock.calls[0]![0];
    expect(payload).toMatchObject({
      operation: "create",
      instanceId: "claudeAgent_deepseek",
      instance: {
        driver: "claudeAgent",
        enabled: true,
        displayName: "DeepSeek",
        config: { customModels: ["deepseek-flash"] },
      },
    });
    expect(payload.instance.environment).toContainEqual({
      name: "SPECWITHCODE_OPEN_MODEL_PRESET",
      value: "deepseek",
      sensitive: false,
    });
    expect(payload.instance.environment).toContainEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "sk-test-deepseek",
      sensitive: true,
    });
    expect(onCreated).toHaveBeenCalledWith("claudeAgent_deepseek");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "DeepSeek added" }),
    );
  });

  it("asks OpenRouter for a model id as well, and saves it", async () => {
    let tree = render();
    (tile(tree, "openrouter").props.onClick as () => void)();
    tree = render();
    type(tree, "open-model-key", "sk-test-or");
    tree = render();
    expect(addButton(tree).props.disabled).toBe(true);
    type(tree, "open-model-model", "vendor/model-1");
    tree = render();
    (addButton(tree).props.onClick as () => void)();
    await flush();
    const payload = settingsHooks.mutate.mock.calls[0]![0];
    expect(payload.instanceId).toBe("claudeAgent_openrouter");
    expect(payload.instance.config).toEqual({ customModels: ["vendor/model-1"] });
  });

  it("adds a local runtime with nothing typed, the address and model optional", async () => {
    settingsHooks.read.mockReturnValue({
      providerInstances: { claudeAgent_ollama: { driver: "claudeAgent" } },
    });
    let tree = render();
    (tile(tree, "ollama").props.onClick as () => void)();
    tree = render();
    expect(input(tree, "open-model-key")).toBeNull();
    expect(input(tree, "open-model-address")?.props.placeholder).toBe("http://localhost:11434");
    expect(addButton(tree).props.disabled).toBe(false);
    (addButton(tree).props.onClick as () => void)();
    await flush();
    const payload = settingsHooks.mutate.mock.calls[0]![0];
    expect(payload.instanceId).toBe("claudeAgent_ollama_2");
    expect(payload.instance.environment).toContainEqual({
      name: "ANTHROPIC_BASE_URL",
      value: "http://localhost:11434",
      sensitive: false,
    });
    expect(payload.instance.environment.some((row: { sensitive: boolean }) => row.sensitive)).toBe(
      false,
    );
  });

  it("saves a changed local address and model id", async () => {
    let tree = render();
    (tile(tree, "lmstudio").props.onClick as () => void)();
    tree = render();
    type(tree, "open-model-address", "http://127.0.0.1:1300");
    tree = render();
    type(tree, "open-model-local-model", "qwen-local");
    tree = render();
    (addButton(tree).props.onClick as () => void)();
    await flush();
    const payload = settingsHooks.mutate.mock.calls[0]![0];
    expect(payload.instanceId).toBe("claudeAgent_lmstudio");
    expect(payload.instance.config).toEqual({ customModels: ["qwen-local"] });
    expect(payload.instance.environment).toContainEqual({
      name: "ANTHROPIC_BASE_URL",
      value: "http://127.0.0.1:1300",
      sensitive: false,
    });
    expect(payload.instance.environment).toContainEqual({
      name: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      value: "qwen-local",
      sensitive: false,
    });
  });

  it("keeps the dialog open when the save fails, and saves nothing without the grant", async () => {
    settingsHooks.mutate.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Conflict") });
    const onOpenChange = vi.fn();
    let tree = render(onOpenChange);
    (tile(tree, "lmstudio").props.onClick as () => void)();
    tree = render(onOpenChange);
    (addButton(tree).props.onClick as () => void)();
    await flush();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(actions.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Could not add the open model" }),
    );

    actions.canManageProviders = false;
    settingsHooks.mutate.mockClear();
    tree = render(onOpenChange);
    expect(addButton(tree).props.disabled).toBe(true);
    (addButton(tree).props.onClick as () => void)();
    expect(settingsHooks.mutate).not.toHaveBeenCalled();
  });
});

describe("Add provider wizard", () => {
  beforeEach(() => {
    hooks.reset();
    settingsHooks.read.mockReset().mockReturnValue({ providerInstances: {} });
    settingsHooks.useMutation.mockReset().mockReturnValue(settingsHooks.mutate);
  });

  it("opens Add an open model from the first step and closes the wizard with it", () => {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    const renderWizard = () => {
      hooks.beginRender();
      return AddProviderInstanceDialog({
        open: true,
        environmentId: remoteEnvironmentId,
        environmentLabel: "Remote device",
        onOpenChange,
        onCreated,
      });
    };
    const entry = visitElements(
      renderWizard(),
      (element) =>
        element.props.children === "Add an open model" &&
        typeof element.props.onClick === "function",
    );
    expect(entry).not.toBeNull();
    (entry!.props.onClick as () => void)();
    const dialog = renderWizard();
    expect(dialog.type).toBe(AddOpenModelDialog);
    expect(dialog.props).toMatchObject({ open: true, environmentId: remoteEnvironmentId });
    (dialog.props.onCreated as (id: ProviderInstanceId) => void)(
      ProviderInstanceId.make("claudeAgent_kimi"),
    );
    expect(onCreated).toHaveBeenCalledWith("claudeAgent_kimi");
    (dialog.props.onOpenChange as (open: boolean) => void)(false);
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

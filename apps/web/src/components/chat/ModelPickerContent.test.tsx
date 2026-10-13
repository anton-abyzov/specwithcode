// @vitest-environment jsdom
import { act, type ChangeEvent, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";
import { deriveProviderInstanceEntries } from "../../providerInstances";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => [],
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
  }: {
    data: string[];
    renderItem: (input: { item: string; index: number }) => ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={item}>{renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));
vi.mock("./ModelPickerSidebar", () => ({ ModelPickerSidebar: () => null }));
vi.mock("../ui/combobox", () => ({
  Combobox: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComboboxListVirtualized: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComboboxEmpty: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  ComboboxItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComboboxSearchInput: ({ onChange, ...props }: ComponentProps<"input">) => (
    <input {...props} onInput={(event) => onChange?.(event as ChangeEvent<HTMLInputElement>)} />
  ),
}));
vi.mock("./ModelListRow", () => ({
  ModelListRow: ({ model }: { model: { name: string } }) => <div data-model-row>{model.name}</div>,
}));

import { ModelPickerContent } from "./ModelPickerContent";

const instanceId = ProviderInstanceId.make("copilot");
const ready = deriveProviderInstanceEntries([
  {
    instanceId,
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName: "GitHub Copilot",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-10-12T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    setup: { canAuthenticate: true, canInstall: false },
  },
])[0]!;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(
  overrides: Partial<ComponentProps<typeof ModelPickerContent>> = {},
  manage = true,
) {
  const calls: string[] = [];
  const onInstanceModelChange = vi.fn();
  await act(async () =>
    root.render(
      <ModelPickerContent
        activeInstanceId={instanceId}
        model="default"
        lockedProvider={null}
        instanceEntries={[ready]}
        modelOptionsByInstance={
          new Map([[instanceId, [{ slug: "default", name: "Provider default" }]]])
        }
        terminalOpen={false}
        onRequestClose={() => calls.push("close")}
        {...(manage
          ? {
              onManageProviders: () => {
                calls.push("manage");
              },
            }
          : {})}
        onInstanceModelChange={onInstanceModelChange}
        {...overrides}
      />,
    ),
  );
  return { calls, onInstanceModelChange };
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);

describe("model picker provider management", () => {
  it("keeps provider management visible with ready models and closes the picker first", async () => {
    const { calls, onInstanceModelChange } = await mount();
    expect(container.querySelector("[data-model-row]")?.textContent).toBe("Provider default");
    await act(async () => button("Add or manage providers")!.click());
    expect(calls).toEqual(["close", "manage"]);
    expect(onInstanceModelChange).not.toHaveBeenCalled();
  });

  it("keeps the management action after a search with no model matches", async () => {
    const { calls } = await mount();
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "no-model-has-this-name",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector("[data-model-row]")).toBeNull();
    await act(async () => button("Add or manage providers")!.click());
    expect(calls).toEqual(["close", "manage"]);
  });

  it("offers setup for an unavailable provider without offering its cached models", async () => {
    const onOpenProviderSetup = vi.fn();
    const unavailable = {
      ...ready,
      status: "warning" as const,
      snapshot: {
        ...ready.snapshot,
        status: "warning" as const,
        auth: { status: "unauthenticated" as const },
      },
    };
    const { calls, onInstanceModelChange } = await mount({
      instanceEntries: [unavailable],
      onOpenProviderSetup,
    });
    expect(container.querySelector("[data-model-row]")).toBeNull();
    expect(container.textContent).toContain("Open provider setup to sign in.");
    await act(async () => button("Open provider setup")!.click());
    expect(calls).toEqual(["close"]);
    expect(onOpenProviderSetup).toHaveBeenCalledWith(instanceId);
    expect(onInstanceModelChange).not.toHaveBeenCalled();
    expect(button("Add or manage providers")).toBeDefined();
  });

  it("offers management when no providers have been configured", async () => {
    const { calls } = await mount({ instanceEntries: [], modelOptionsByInstance: new Map() });
    await act(async () => button("Add or manage providers")!.click());
    expect(calls).toEqual(["close", "manage"]);
  });

  it("does not render a management action without a destination", async () => {
    await mount({}, false);
    expect(button("Add or manage providers")).toBeUndefined();
  });
});

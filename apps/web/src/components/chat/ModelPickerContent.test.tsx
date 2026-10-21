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
vi.mock("./ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
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
  ModelListRow: ({
    model,
    disabledReason,
  }: {
    model: { name: string };
    disabledReason?: string | null;
  }) => (
    <div data-model-row data-disabled-reason={disabledReason ?? undefined}>
      {model.name}
    </div>
  ),
}));

import { ModelPickerContent } from "./ModelPickerContent";
import type { ModelPickerUsage } from "./ModelUsage";

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

describe("model picker one-click setup", () => {
  const quickSetup = (
    overrides: Partial<NonNullable<ComponentProps<typeof ModelPickerContent>["quickSetup"]>> = {},
  ) => ({
    installable: new Map(),
    elsewhere: [],
    canManage: true,
    pending: new Set<string>(),
    errors: new Map<string, string>(),
    install: vi.fn(),
    enableHere: vi.fn(),
    ...overrides,
  });

  it("installs an unprepared registry agent from the picker without leaving the chat", async () => {
    const unprepared = {
      ...ready,
      installed: false,
      status: "warning" as const,
      snapshot: { ...ready.snapshot, installed: false, status: "warning" as const },
    };
    const setup = quickSetup({ installable: new Map([[instanceId, "github-copilot-cli"]]) });
    const onOpenProviderSetup = vi.fn();
    const { calls } = await mount({
      instanceEntries: [unprepared],
      onOpenProviderSetup,
      quickSetup: setup,
    });
    expect(container.textContent).toContain("not installed on this machine yet");
    await act(async () => button("Install GitHub Copilot")!.click());
    expect(setup.install).toHaveBeenCalledWith(instanceId);
    expect(onOpenProviderSetup).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("offers providers from other machines and turns one on here", async () => {
    const grok = {
      identity: "driver:grok",
      driverKind: ProviderDriverKind.make("grok"),
      displayName: "Grok",
      agentId: null,
      entry: ready,
      machineLabels: ["M4 Max"],
    };
    const setup = quickSetup({ elsewhere: [grok] });
    await mount({ quickSetup: setup });
    expect(container.textContent).toContain("On your other machines");
    expect(container.textContent).toContain("Grok · ready on M4 Max");
    await act(async () => button("Turn on here")!.click());
    expect(setup.enableHere).toHaveBeenCalledWith(grok);
  });

  it("keeps the action disabled without permission to manage providers", async () => {
    const grok = {
      identity: "driver:grok",
      driverKind: ProviderDriverKind.make("grok"),
      displayName: "Grok",
      agentId: null,
      entry: ready,
      machineLabels: ["M4 Max"],
    };
    await mount({ quickSetup: quickSetup({ elsewhere: [grok], canManage: false }) });
    expect(button("Turn on here")!.disabled).toBe(true);
  });
});

describe("model picker when the chosen provider can't run here", () => {
  it("lists ready providers' models under the unprepared one instead of an empty picker", async () => {
    const codexId = ProviderInstanceId.make("codex");
    const [codex] = deriveProviderInstanceEntries([
      {
        ...ready.snapshot,
        instanceId: codexId,
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        status: "ready",
        auth: { status: "authenticated" },
      },
    ]);
    const unprepared = {
      ...ready,
      displayName: "Copilot managed",
      installed: false,
      isAvailable: false,
      status: "warning" as const,
      snapshot: { ...ready.snapshot, installed: false, status: "warning" as const },
    };
    const install = vi.fn();
    const { onInstanceModelChange } = await mount({
      model: "claude-opus-5.5",
      instanceEntries: [unprepared, codex!],
      modelOptionsByInstance: new Map([
        [instanceId, [{ slug: "claude-opus-5.5", name: "Claude Opus 5.5" }]],
        [codexId, [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }]],
      ]),
      onOpenProviderSetup: vi.fn(),
      quickSetup: {
        installable: new Map([[instanceId, "github-copilot-cli"]]),
        elsewhere: [],
        canManage: true,
        pending: new Set<string>(),
        errors: new Map<string, string>(),
        install,
        enableHere: vi.fn(),
      },
    });
    const rows = [...container.querySelectorAll("[data-model-row]")].map((row) => row.textContent);
    expect(rows).toEqual(["GPT-6.1-Sol"]);
    expect(container.textContent).toContain("Copilot managed can't run on this machine yet.");
    // Installing stays the user's choice.
    expect(button("Install Copilot managed")).toBeDefined();
    expect(install).not.toHaveBeenCalled();
    expect(onInstanceModelChange).not.toHaveBeenCalled();
  });
});

describe("model picker usage limits", () => {
  const spent: ModelPickerUsage = {
    connected: true,
    machineLabel: "Studio Mac",
    running: null,
    nowMs: Date.parse("2026-10-12T12:00:00.000Z"),
    availability: () => ({
      kind: "exhausted",
      binding: { label: "Weekly", scope: "account", family: null, resetsAt: null },
      checkedAt: 0,
      providerAllows: false,
    }),
    text: () => ({
      short: "Weekly limit reached",
      long: "The weekly limit is used up.",
      tone: "full",
    }),
    blockedReason: () => "The weekly limit is used up.",
    formatAt: () => "6:00 PM",
  };
  const options = new Map([
    [
      instanceId,
      [
        { slug: "alpha", name: "Alpha" },
        { slug: "beta", name: "Beta" },
      ],
    ],
  ]);
  const rowReason = (name: string) =>
    [...container.querySelectorAll("[data-model-row]")]
      .find((node) => node.textContent === name)
      ?.getAttribute("data-disabled-reason") ?? null;

  it("disables a spent model and names why", async () => {
    await mount({ model: "alpha", modelOptionsByInstance: options, usage: spent });
    expect(rowReason("Beta")).toBe("The weekly limit is used up.");
  });

  it("lets a spent model already in a multi-selection be taken out", async () => {
    await mount({
      model: "alpha",
      modelOptionsByInstance: options,
      usage: spent,
      selectedModels: [{ instanceId, model: "alpha" }],
      onToggleModel: vi.fn(),
    });
    expect(rowReason("Alpha")).toBeNull();
    expect(rowReason("Beta")).toBe("The weekly limit is used up.");
  });
});

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
  usePrimarySettings: () => undefined,
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
vi.mock("./ModelPickerProviderChips", () => ({
  ModelPickerProviderChips: ({
    selected,
    onSelect,
  }: {
    selected: string;
    onSelect: (view: string) => void;
  }) => (
    <div data-model-picker-chips data-selected-view={selected}>
      <button type="button" data-view="all" onClick={() => onSelect("all")}>
        All chip
      </button>
    </div>
  ),
}));
vi.mock("./ProviderGroupHeader", () => ({
  ProviderGroupHeader: ({ entry }: { entry: { instanceId: string } }) => (
    <div data-model-picker-group={entry.instanceId} />
  ),
}));
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
    warningReason,
    providerAsTitle,
    status,
    ...rest
  }: {
    model: { name: string };
    disabledReason?: string | null;
    warningReason?: string | null;
    providerAsTitle?: { label: string | null };
    status?: ReadonlyArray<{ kind: string }>;
  }) => (
    <div
      data-model-row
      data-disabled-reason={disabledReason ?? undefined}
      data-warning-reason={warningReason ?? undefined}
      data-effort={"effort" in rest ? "" : undefined}
      data-provider-as-title={providerAsTitle ? (providerAsTitle.label ?? "") : undefined}
      data-status={status?.map((icon) => icon.kind).join(" ")}
    >
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
    expect(container.textContent).toContain(
      "GitHub Copilot is installed on this machine but not signed in.",
    );
    expect(container.textContent).not.toContain("No models found");
    await act(async () => button("Set up GitHub Copilot")!.click());
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
    expect(container.textContent).toContain("GitHub Copilot isn't installed on this machine yet.");
    // One install offer, in the note over the list; the footer does not repeat it.
    expect(container.querySelectorAll("[data-model-picker-install]")).toHaveLength(1);
    await act(async () => button("Install GitHub Copilot on this machine")!.click());
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

describe("model picker Turn on here outcome", () => {
  const geminiId = ProviderInstanceId.make("acpRegistry_gemini");
  const gemini = {
    identity: "acp:gemini",
    driverKind: ProviderDriverKind.make("acpRegistry"),
    displayName: "Gemini CLI",
    agentId: "gemini",
    entry: ready,
    machineLabels: ["Anton's MacBook"],
  };
  const geminiHere = (snapshot: Partial<(typeof ready)["snapshot"]>) =>
    deriveProviderInstanceEntries([
      {
        ...ready.snapshot,
        instanceId: geminiId,
        displayName: "Gemini CLI",
        ...snapshot,
      },
    ])[0]!;
  const setupFor = (overrides: Record<string, unknown> = {}) => ({
    installable: new Map(),
    elsewhere: [],
    canManage: true,
    pending: new Set<string>(),
    errors: new Map<string, string>(),
    install: vi.fn(),
    enableHere: vi.fn(),
    machineLabel: "ministorm",
    turnedOn: [{ provider: gemini, instanceId: geminiId }],
    ...overrides,
  });
  const row = () => container.querySelector("[data-model-picker-turned-on='acp:gemini']");

  it("shows the running step on the machine instead of dropping the row", async () => {
    await mount({
      quickSetup: setupFor({
        pending: new Set(["acp:gemini"]),
        steps: new Map([["acp:gemini", "installing"]]),
      }),
    });
    expect(container.textContent).toContain("Turned on on ministorm");
    expect(row()?.getAttribute("data-turn-on-state")).toBe("running");
    expect(row()?.textContent).toContain("Installing…");
  });

  it("says which sign-in the machine needs and opens that machine's setup", async () => {
    const onOpenProviderSetup = vi.fn();
    const { calls } = await mount({
      instanceEntries: [
        ready,
        geminiHere({
          status: "warning",
          auth: { status: "unauthenticated", type: "agent", label: "Log in with Google" },
        }),
      ],
      onOpenProviderSetup,
      quickSetup: setupFor(),
    });
    expect(row()?.getAttribute("data-turn-on-state")).toBe("sign-in");
    expect(row()?.textContent).toContain(
      'Sign in on ministorm: open Gemini CLI setup and choose "Log in with Google".',
    );
    await act(async () => button("Sign in")!.click());
    expect(calls).toContain("close");
    expect(onOpenProviderSetup).toHaveBeenCalledWith(geminiId);
  });

  it("on a remote machine, offers a Gemini API key from here and opens its setup", async () => {
    const onOpenProviderSetup = vi.fn();
    await mount({
      instanceEntries: [
        ready,
        geminiHere({
          status: "warning",
          auth: { status: "unauthenticated", type: "agent", label: "Log in with Google" },
        }),
      ],
      onOpenProviderSetup,
      quickSetup: setupFor({ remote: true }),
    });
    expect(row()?.textContent).toContain(
      '"Log in with Google" opens a browser on ministorm. From here: add a Gemini API key (aistudio.google.com/apikey); it stays on ministorm.',
    );
    expect(button("Sign in")).toBeUndefined();
    await act(async () => button("Add API key")!.click());
    expect(onOpenProviderSetup).toHaveBeenCalledWith(geminiId);
  });

  it("shows the real error with a retry", async () => {
    const setup = setupFor({
      errors: new Map([
        ["acp:gemini", "ACP executable 'npm' is not available on this environment's PATH."],
      ]),
    });
    await mount({ quickSetup: setup });
    expect(row()?.textContent).toContain("'npm' is not available");
    await act(async () => button("Retry")!.click());
    expect(setup.enableHere).toHaveBeenCalledWith(gemini);
  });

  it("drops the row once the provider is turned off again, leaving one offer", async () => {
    await mount({
      instanceEntries: [ready, { ...geminiHere({ enabled: false }), enabled: false }],
      quickSetup: setupFor({ elsewhere: [gemini] }),
    });
    expect(row()).toBeNull();
    expect(container.querySelectorAll("[data-model-picker-enable-here='acp:gemini']")).toHaveLength(
      1,
    );
  });

  it("offers Check again when the machine has not reported the provider yet", async () => {
    const setup = setupFor({
      turnedOn: [{ provider: gemini, instanceId: geminiId }],
      errors: new Map(),
    });
    await mount({
      instanceEntries: [ready, geminiHere({ status: "warning", auth: { status: "unknown" } })],
      quickSetup: setup,
    });
    await act(async () => button("Check again")!.click());
    expect(setup.enableHere).toHaveBeenCalledWith(gemini);
  });

  it("reports a provider that is ready once it lists models", async () => {
    await mount({
      instanceEntries: [
        ready,
        geminiHere({
          status: "ready",
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gemini-4",
              name: "Gemini 4",
              isCustom: false,
              capabilities: { optionDescriptors: [] },
            },
          ],
        }),
      ],
      quickSetup: setupFor(),
    });
    expect(row()?.getAttribute("data-turn-on-state")).toBe("ready");
    expect(button("Sign in")).toBeUndefined();
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
    expect(container.textContent).toContain("Copilot managed isn't installed on this machine yet.");
    expect(container.textContent).toContain(
      "Ready now instead. Picking one switches this chat to that provider.",
    );
    // Installing stays the user's choice.
    expect(button("Install Copilot managed on this machine")).toBeDefined();
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
    warningReason: () => "The weekly limit is used up.",
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

  it("keeps a spent model selectable and names its warning", async () => {
    await mount({ model: "alpha", modelOptionsByInstance: options, usage: spent });
    expect(rowReason("Beta")).toBeNull();
    expect(
      container.querySelector("[data-warning-reason]")?.getAttribute("data-warning-reason"),
    ).toBe("The weekly limit is used up.");
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
    expect(rowReason("Beta")).toBeNull();
    expect(
      container.querySelector("[data-warning-reason]")?.getAttribute("data-warning-reason"),
    ).toBe("The weekly limit is used up.");
  });
});

it("explains the fallback above search without stealing initial focus", async () => {
  await mount({
    stateHeader: {
      title: "Running on a fallback",
      detail: "Opus 5.5 hit its usage limit.",
      now: "GPT-6-Astra · Codex",
      pick: { label: "Opus 5.5 · Claude Code", why: "Hit its usage limit." },
      returns: { mode: "auto", text: "Goes back on its own after it resets at 3:40 PM." },
      back: {
        label: "Return to Opus 5.5 now",
        onClick: vi.fn(),
        disabledReason: "Available at 3:40 PM",
      },
      chain: [],
    },
  });
  const status = container.querySelector('[role="status"]');
  expect(status?.querySelector("[data-fallback-now]")?.textContent).toBe("GPT-6-Astra · Codex");
  expect(status?.querySelector("[data-fallback-pick]")?.textContent).toContain("Opus 5.5");
  expect(status?.querySelector('[data-fallback-return="auto"]')?.textContent).toContain(
    "Automatic",
  );
  expect(button("Return to Opus 5.5 now")?.disabled).toBe(true);
  expect(button("Return to Opus 5.5 now")?.title).toBe("Available at 3:40 PM");
  // One way back: nothing else in the picker offers it.
  expect(container.textContent).not.toMatch(/Switch back|Back to /);
  expect(document.activeElement).toBe(container.querySelector("input"));
});

describe("Weave grouped list", () => {
  const codexId = ProviderInstanceId.make("codex");
  const codex = deriveProviderInstanceEntries([
    {
      instanceId: codexId,
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-12T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
  const options = new Map([
    [
      instanceId,
      [
        { slug: "default", name: "Provider default" },
        { slug: "old", name: "Old Copilot", isLegacy: true },
      ],
    ],
    [codexId, [{ slug: "gpt", name: "GPT Codex" }]],
  ]);
  const rows = () =>
    [...container.querySelectorAll("[data-model-row]")].map((row) => row.textContent);
  const groups = () =>
    [...container.querySelectorAll("[data-model-picker-group]")].map((node) =>
      node.getAttribute("data-model-picker-group"),
    );
  const keyDown = (init: KeyboardEventInit) =>
    act(async () => {
      container
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    });

  it("shows every provider under its own header in All, with each legacy section in place", async () => {
    await mount({ instanceEntries: [ready, codex], modelOptionsByInstance: options });
    // One provider: no headers, the row keeps its provider line.
    expect(groups()).toEqual([]);
    expect(rows()).toEqual(["Provider default"]);
    await act(async () => button("All chip")!.click());
    expect(
      container.querySelector("[data-model-picker-chips]")?.getAttribute("data-selected-view"),
    ).toBe("all");
    expect(groups()).toEqual([instanceId, codexId]);
    expect(rows()).toEqual(["Provider default", "GPT Codex"]);
    expect(container.textContent).toContain("Legacy models");
    // The group header names the provider, so its rows name the model.
    expect(container.querySelector("[data-provider-as-title]")).toBeNull();
  });

  it("steps through the provider chips with Cmd+Up and Cmd+Down", async () => {
    await mount({ instanceEntries: [ready, codex], modelOptionsByInstance: options });
    const view = () =>
      container.querySelector("[data-model-picker-chips]")?.getAttribute("data-selected-view");
    expect(view()).toBe(instanceId);
    await keyDown({ key: "ArrowDown", metaKey: true });
    expect(view()).toBe(codexId);
    await keyDown({ key: "ArrowUp", metaKey: true });
    await keyDown({ key: "ArrowUp", metaKey: true });
    await keyDown({ key: "ArrowUp", metaKey: true });
    expect(view()).toBe("all");
  });

  it("sets the picked model's effort from the strip and with Left and Right", async () => {
    const select = vi.fn();
    const toggle = vi.fn();
    await mount({
      effort: {
        options: [
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "max", label: "Max" },
        ],
        value: "medium",
        locked: null,
        select,
        fast: { on: false, toggle },
      },
    });
    const strip = container.querySelector("[data-model-picker-effort]")!;
    expect(
      [...strip.querySelectorAll('[role="radio"]')].map((node) => [
        node.textContent,
        node.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["Low", "false"],
      ["Medium", "true"],
      ["Max", "false"],
    ]);
    // The strip is the one place effort shows: no row is given one.
    expect(container.querySelector("[data-model-row][data-effort]")).toBeNull();
    await keyDown({ key: "ArrowRight" });
    expect(select).toHaveBeenLastCalledWith("max");
    await keyDown({ key: "ArrowLeft" });
    expect(select).toHaveBeenLastCalledWith("low");
    await act(async () =>
      strip.querySelector<HTMLButtonElement>('[data-effort-option="low"]')!.click(),
    );
    expect(select).toHaveBeenLastCalledWith("low");
    await act(async () =>
      strip.querySelector<HTMLButtonElement>("[data-model-picker-fast]")!.click(),
    );
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("leaves the effort strip out of a multi-selection", async () => {
    await mount({
      selectedModels: [{ instanceId, model: "default" }],
      onToggleModel: vi.fn(),
      effort: {
        options: [{ id: "low", label: "Low" }],
        value: "low",
        locked: null,
        select: vi.fn(),
        fast: null,
      },
    });
    expect(container.querySelector("[data-model-picker-effort]")).toBeNull();
  });

  it("brings focus back to the search with Cmd+K", async () => {
    await mount();
    const chip = button("All chip")!;
    chip.focus();
    expect(document.activeElement).toBe(chip);
    await act(async () => {
      chip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(container.querySelector("input"));
  });
});

describe("calm picker search", () => {
  const provider = (
    id: string,
    driver: string,
    displayName: string,
    extra: Record<string, unknown> = {},
  ) =>
    deriveProviderInstanceEntries([
      {
        instanceId: ProviderInstanceId.make(id),
        driver: ProviderDriverKind.make(driver),
        displayName,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-12T12:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
        ...extra,
      } as never,
    ])[0]!;
  const enterprise = provider(
    "copilot_work",
    "acpRegistry",
    "Copilot Enterprise (abycrash-robotics-on)",
  );
  const claude = provider("claudeAgent", "claudeAgent", "Claude Code");
  const cursor = provider("cursor", "cursor", "Cursor", {
    auth: { status: "unauthenticated" },
    status: "warning",
  });
  const catalog = new Map([
    [
      enterprise.instanceId,
      [
        { slug: "gemini-4-carbon", name: "Gemini 4 Carbon" },
        { slug: "claude-opus-5.5", name: "Claude Opus 5.5" },
        { slug: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
      ],
    ],
    [
      claude.instanceId,
      [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { slug: "claude-fable-5", name: "Claude Fable 5" },
      ],
    ],
  ]);
  const type = (value: string) =>
    act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const rows = () =>
    [...container.querySelectorAll("[data-model-row]")].map((row) => row.textContent);
  const mountCatalog = (overrides: Partial<ComponentProps<typeof ModelPickerContent>> = {}) =>
    mount({
      activeInstanceId: claude.instanceId,
      model: "claude-opus-5-5",
      instanceEntries: [claude, enterprise, cursor],
      modelOptionsByInstance: catalog,
      ...overrides,
    });

  it("lists only Gemini 4 Carbon for carbon and marks the matched characters", async () => {
    await mountCatalog();
    await type("carbon");
    expect(rows()).toEqual(["Gemini 4 Carbon"]);
    expect(container.querySelector("[data-model-search-mark]")?.textContent).toBe("Carbon");
    expect(container.querySelector("[data-model-search-closest]")).toBeNull();
  });

  it("offers a signed-out provider known to have the model as a sign-in", async () => {
    const onOpenProviderSetup = vi.fn();
    const { calls } = await mountCatalog({ onOpenProviderSetup });
    await type("carbon");
    const offer = container.querySelector("[data-model-search-sign-in]")!;
    expect(offer.textContent).toContain(
      "Cursor also offers Gemini 4 Carbon. It's signed out here.",
    );
    await act(async () =>
      offer.querySelector<HTMLButtonElement>("[data-model-search-sign-in-action]")!.click(),
    );
    expect(calls).toEqual(["close"]);
    expect(onOpenProviderSetup).toHaveBeenCalledWith(cursor.instanceId);
  });

  it("labels near-misses as closest matches and says when nothing is close", async () => {
    await mountCatalog();
    await type("cabron");
    expect(container.querySelector("[data-model-search-closest]")?.textContent).toBe(
      "Closest matches",
    );
    expect(rows()).toEqual(["Gemini 4 Carbon"]);
    await type("zzzzzz");
    expect(rows()).toEqual([]);
    expect(container.querySelector("[data-model-search-empty]")?.textContent).toContain(
      "No model matches “zzzzzz”",
    );
  });

  it("shows a capability word as a chip that takes the word back out", async () => {
    await mountCatalog();
    await type("opus 1m");
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-model-search-capability="long"]',
    )!;
    expect(chip.textContent).toBe("1M context");
    // No model here reports a 1M window, so the filter leaves nothing.
    expect(rows()).toEqual([]);
    await act(async () => chip.click());
    expect(container.querySelector("input")!.value).toBe("opus");
    expect(rows()).toEqual(["Claude Opus 5.5", "Claude Opus 5.5"]);
  });

  it("names the choice it makes", async () => {
    await mountCatalog({ title: "Model for new threads", titleContext: "carbon-test" });
    expect(container.querySelector("[data-model-picker-title]")?.textContent).toBe(
      "Choosing Model for new threads · carbon-test",
    );
  });

  it("gives search rows the provider's short label and status icons, never effort", async () => {
    await mountCatalog();
    await type("opus");
    const titled = [...container.querySelectorAll("[data-provider-as-title]")].map((row) =>
      row.getAttribute("data-provider-as-title"),
    );
    expect(titled).toEqual(["Claude Code", "Copilot Enterprise"]);
    expect(container.querySelector("[data-model-row][data-effort]")).toBeNull();
  });
});

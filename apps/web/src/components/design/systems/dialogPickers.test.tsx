// @vitest-environment jsdom
import type {
  DesignOwnerInput,
  DesignSystemId,
  DesignSystemSummary,
  ProjectId,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DesignFromCodeDialog, type DesignFromCodeRequest } from "../DesignFromCodeDialog";
import { FoundSystemCard } from "../gallery/CreationSystemPicker";
import type { ScanState } from "../gallery/creationSystem";
import type { FoundSystem } from "../gallery/foundSystems";
import { NewDesignDialog, type NewDesignRequest } from "../gallery/NewDesignDialog";
import type { CopyOptions, CopyOutcome } from "./DesignSystemPicker";
import { PROJECTS, SYSTEMS } from "./fixtureData";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function openSelect(trigger: HTMLElement) {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  await flush();
}

const openSystemPicker = () => openSelect(byTestId("creation-system-trigger")!);
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  )!;

const copied = () =>
  vi.fn(
    async (
      _system: DesignSystemSummary,
      _to: DesignOwnerInput,
      _options?: CopyOptions,
    ): Promise<CopyOutcome> => ({
      ok: true,
      systemId: "weave-2" as DesignSystemId,
      name: "Weave",
    }),
  );

const UIKIT: FoundSystem = {
  key: "ec-uikit",
  name: "ec-uikit",
  description: null,
  paths: ["repositories/acme/ec-uikit/src/styles/tokens.css"],
  sources: [
    { path: "repositories/acme/ec-uikit/src/styles/tokens.css", tokens: 283, components: 0 },
    { path: "repositories/acme/ec-uikit/src/primitives/index.ts", tokens: 0, components: 321 },
  ],
  tokens: 283,
  components: 321,
  modes: ["light", "dark"],
  swatches: [
    { name: "ec-primary", value: "#1d4ed8", darkValue: "#93c5fd" },
    { name: "ec-bad", value: "url(https://example.invalid/x.png)" },
  ],
  copies: [],
};
const SNAP: FoundSystem = { ...UIKIT, key: "ec-snap", name: "ec-snap", tokens: 12, components: 3 };

// Atlas web and Borealis API own systems in the fixture; Cosmos app owns none.
const COSMOS = { id: "cosmos-app" as ProjectId, title: "Cosmos app" };
const WITH_COSMOS = [...PROJECTS, COSMOS] as typeof PROJECTS;

const found = (systems: readonly FoundSystem[], truncated = false): ScanState => ({
  status: "done",
  found: systems,
  truncated,
});

function renderFromCode(props: Partial<Parameters<typeof DesignFromCodeDialog>[0]> = {}) {
  const onStart = vi.fn(async (_request: DesignFromCodeRequest) => null as string | null);
  act(() =>
    root.render(
      <DesignFromCodeDialog
        open
        onOpenChange={() => undefined}
        initialProjectId={COSMOS.id as never}
        projects={WITH_COSMOS}
        systems={SYSTEMS}
        workerLabelFor={() => "Claude Opus 5.5"}
        onStart={onStart}
        {...props}
      />,
    ),
  );
  return onStart;
}

describe("creation dialogs copy another owner's system only on Create or Start (C6)", () => {
  it("New design copies into the Playground when Create is pressed, not on selection", async () => {
    const onCopySystem = copied();
    const onCreate = vi.fn(async (_request: NewDesignRequest) => null as string | null);
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          onCreate={onCreate}
          onCopySystem={onCopySystem}
        />,
      ),
    );
    await openSystemPicker();
    const weave = options().find((option) => option.textContent?.startsWith("Weave"))!;
    expect(weave.textContent).toContain("copied into Playground when you create");
    await act(async () => weave.click());
    await flush();
    expect(onCopySystem).not.toHaveBeenCalled();
    expect(byTestId("creation-system-hint")?.textContent).toContain("Cancel copies nothing");

    await act(async () => button("Create design").click());
    await flush();
    expect(onCopySystem).toHaveBeenCalledOnce();
    expect(onCopySystem.mock.calls[0]![1]).toEqual({ kind: "playground" });
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      designSystem: "weave-2",
      designSystemName: "Weave",
    });
  });

  it("Cancel copies nothing", async () => {
    const onCopySystem = copied();
    const onOpenChange = vi.fn();
    renderFromCode({ onCopySystem, onOpenChange });
    await openSystemPicker();
    await act(async () =>
      options()
        .find((option) => option.textContent?.startsWith("Weave"))!
        .click(),
    );
    await flush();
    await act(async () => button("Cancel").click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCopySystem).not.toHaveBeenCalled();
  });

  it("Design from code copies once, and a retry after a failed start reuses the copy", async () => {
    const onCopySystem = copied();
    const onStart = vi.fn(
      async (_request: DesignFromCodeRequest) => "The provider did not respond.",
    );
    renderFromCode({ onCopySystem, onStart });
    await openSystemPicker();
    await act(async () =>
      options()
        .find((option) => option.textContent?.startsWith("Weave"))!
        .click(),
    );
    await flush();
    await act(async () => button("Start design").click());
    await flush();
    await act(async () => button("Start design").click());
    await flush();
    expect(onCopySystem).toHaveBeenCalledOnce();
    expect(onCopySystem.mock.calls[0]![1]).toEqual({ kind: "project", projectId: "cosmos-app" });
    expect(onStart.mock.calls.map((call) => call[0].designSystem)).toEqual(["weave-2", "weave-2"]);
  });

  it("says when the owner's copy predates the source and makes a fresh one once", async () => {
    const weave = SYSTEMS.find((system) => system.ref.systemId === "weave")!;
    // Cosmos app copied revision 1 of Weave, which is at revision 3 now.
    const cosmosCopy = {
      ...weave,
      ref: {
        ...weave.ref,
        owner: { kind: "project", environmentId: "host", projectId: COSMOS.id },
        systemId: "weave-old" as DesignSystemId,
      },
      ownerLabel: "Cosmos app",
      copiedFrom: { owner: weave.ref.owner, id: "weave", revision: 1, copiedAt: "" },
    } as DesignSystemSummary;
    const onCopySystem = copied();
    const onStart = vi.fn(
      async (_request: DesignFromCodeRequest) => "The provider did not respond.",
    );
    renderFromCode({ onCopySystem, onStart, systems: [...SYSTEMS, cosmosCopy] });
    await openSystemPicker();
    const reuse = options().find(
      (option) =>
        option.dataset.testid === "creation-system-copy" && option.textContent?.startsWith("Weave"),
    )!;
    expect(reuse.textContent).toBe(
      "WeaveFrom Atlas web · Use the copy in Cosmos app, copied before the latest change",
    );
    await act(async () => reuse.click());
    await flush();
    expect(byTestId("creation-system-hint")?.textContent).toBe(
      "Cosmos app already has a copy of Weave, made before its latest change. The design uses that copy.",
    );

    await openSystemPicker();
    const fresh = byTestId("creation-system-fresh")!;
    expect(fresh.textContent).toBe(
      "WeaveFrom Atlas web · Make a fresh copy in Cosmos app when you start",
    );
    await act(async () => fresh.click());
    await flush();
    expect(byTestId("creation-system-hint")?.textContent).toContain(
      "A fresh copy of Weave is made in Cosmos app when you start.",
    );
    await act(async () => button("Start design").click());
    await flush();
    await act(async () => button("Start design").click());
    await flush();
    expect(onCopySystem).toHaveBeenCalledOnce();
    expect(onCopySystem.mock.calls[0]!.slice(1)).toEqual([
      { kind: "project", projectId: "cosmos-app" },
      { fresh: true },
    ]);
    expect(onStart.mock.calls.map((call) => call[0].designSystem)).toEqual(["weave-2", "weave-2"]);
  });

  it("offers no copies when the caller cannot copy", async () => {
    renderFromCode();
    await openSystemPicker();
    expect(options().some((option) => option.textContent?.includes("copied into"))).toBe(false);
  });
});

describe("Found in this repository (AC-02)", () => {
  it("scans a project without its own system once, and not one that has a system", async () => {
    const onScan = vi.fn();
    renderFromCode({ onScan });
    await flush();
    expect(onScan).toHaveBeenCalledExactlyOnceWith("cosmos-app");

    const owned = vi.fn();
    act(() => root.unmount());
    root = createRoot(container);
    renderFromCode({ onScan: owned, initialProjectId: "atlas-web" as never });
    await flush();
    expect(owned).not.toHaveBeenCalled();
  });

  it("waits for the system list before scanning", async () => {
    const onScan = vi.fn();
    renderFromCode({ onScan, systemsReady: false });
    await flush();
    expect(onScan).not.toHaveBeenCalled();
  });

  it("defaults to the best found system, shows where it lives, and starts with it", async () => {
    const onStart = renderFromCode({
      scanFor: () => found([UIKIT, SNAP]),
      onScan: () => undefined,
    });
    expect(byTestId("creation-system-trigger")?.textContent).toContain("ec-uikit");
    const card = byTestId("creation-system-found-card")!;
    expect(card.textContent).toContain("repositories/acme/ec-uikit");
    expect(card.textContent).toContain("283 tokens, 321 components, light and dark modes");
    // Only plain color syntax is painted.
    expect(card.querySelectorAll('[data-testid="creation-system-swatches"] > span')).toHaveLength(
      1,
    );

    await openSystemPicker();
    const rows = options().map((option) => option.textContent ?? "");
    expect(rows[0]).toContain("ec-uikit");
    expect(rows[1]).toContain("ec-snap");
    expect(document.body.textContent).toContain("Found in this repository");

    await act(async () => options()[0]!.click());
    await act(async () => button("Start design").click());
    await flush();
    expect(onStart.mock.calls[0]![0]).toMatchObject({
      designSystem: null,
      found: { key: "ec-uikit" },
    });
  });

  it("keeps the person's choice of no design system", async () => {
    const onStart = renderFromCode({ scanFor: () => found([UIKIT]), onScan: () => undefined });
    await openSystemPicker();
    await act(async () =>
      options()
        .find((option) => option.textContent === "No design system")!
        .click(),
    );
    await flush();
    expect(byTestId("creation-system-found-card")).toBeNull();
    await act(async () => button("Start design").click());
    await flush();
    expect(onStart.mock.calls[0]![0]).toMatchObject({ designSystem: null, found: null });
  });

  it("reads scanning, nothing found and a failed scan plainly, and never blocks Start", async () => {
    let state: ScanState = { status: "scanning" };
    const onScan = vi.fn();
    const onStart = renderFromCode({ scanFor: () => state, onScan });
    expect(byTestId("creation-system-scanning")?.textContent).toContain(
      "Looking for a design system in Cosmos app",
    );
    expect((byTestId("design-from-code-start") as HTMLButtonElement).disabled).toBe(false);

    state = found([], true);
    renderFromCode({ scanFor: () => state, onScan, onStart });
    expect(byTestId("creation-system-hint")?.textContent).toContain(
      "No tokens or component libraries found in Cosmos app",
    );
    expect(byTestId("creation-system-hint")?.textContent).toContain("skipped some folders");

    state = { status: "failed", message: "The folder is not readable." };
    renderFromCode({ scanFor: () => state, onScan, onStart });
    expect(byTestId("creation-system-hint")?.textContent).toContain(
      "Could not scan Cosmos app: The folder is not readable.",
    );
    await act(async () => byTestId("creation-system-scan-again")!.click());
    expect(onScan).toHaveBeenLastCalledWith("cosmos-app", true);
  });

  it("New design offers found systems for a code project only", async () => {
    const onScan = vi.fn();
    const projects = [
      ...PROJECTS,
      { id: "aide" as ProjectId, title: "Aide", kind: "personal" as const },
    ];
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={projects}
          systems={[]}
          initialOwner={{ kind: "project", projectId: "aide" as ProjectId }}
          scanFor={() => found([UIKIT])}
          onScan={onScan}
          onCreate={async () => null}
        />,
      ),
    );
    await flush();
    expect(onScan).not.toHaveBeenCalled();
    expect(byTestId("creation-system-found-card")).toBeNull();
  });
});

describe("a preselected project that is not offered (AC-04)", () => {
  const archived = {
    id: "old-site" as ProjectId,
    title: "Old site",
    reason: "Archived project, not available here",
  };

  it("Design from code shows it as disabled context and waits for a code project", async () => {
    const onStart = renderFromCode({ initialProjectId: archived.id, unavailable: archived });
    expect(byTestId("design-from-code-project")?.textContent).toContain(
      "Old siteArchived project, not available here",
    );
    expect((byTestId("design-from-code-start") as HTMLButtonElement).disabled).toBe(true);
    await openSelect(byTestId("design-from-code-project")!);
    const row = byTestId("design-from-code-project-unavailable")!;
    expect(row.getAttribute("aria-disabled") ?? row.getAttribute("data-disabled")).not.toBeNull();
    expect(options().filter((option) => option.textContent?.includes("Old site"))).toHaveLength(1);
    await act(async () => row.click());
    await act(async () => button("Start design").click());
    expect(onStart).not.toHaveBeenCalled();
  });

  it("New design shows it as disabled context and Create waits for a choice", async () => {
    const onCreate = vi.fn(async () => null);
    act(() =>
      root.render(
        <NewDesignDialog
          open
          onOpenChange={() => undefined}
          projects={PROJECTS}
          systems={SYSTEMS}
          initialOwner={{ kind: "project", projectId: archived.id }}
          unavailable={archived}
          onCreate={onCreate}
        />,
      ),
    );
    expect(byTestId("new-design-where")?.textContent).toContain("Archived project");
    expect(byTestId("new-design-where-hint")).not.toBeNull();
    expect((byTestId("new-design-create") as HTMLButtonElement).disabled).toBe(true);

    await openSelect(byTestId("new-design-where")!);
    await act(async () =>
      options()
        .find((option) => option.textContent === "Atlas web")!
        .click(),
    );
    await flush();
    expect((byTestId("new-design-create") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => byTestId("new-design-create")!.click());
    await flush();
    expect(onCreate).toHaveBeenCalledOnce();
  });
});

describe("the found-system card says what choosing it does", () => {
  it("New design imports it into the project; Design from code only reads it", () => {
    act(() =>
      root.render(
        <FoundSystemCard found={UIKIT} truncated={false} project="Atlas web" verb="create" />,
      ),
    );
    expect(byTestId("creation-system-found-card")?.textContent).toContain(
      "imported into Atlas web as a design system",
    );
    act(() =>
      root.render(
        <FoundSystemCard found={UIKIT} truncated={false} project="Atlas web" verb="start" />,
      ),
    );
    const card = byTestId("creation-system-found-card")?.textContent ?? "";
    expect(card).toContain("The agent reads these files");
    expect(card).not.toContain("imported into");
  });
});

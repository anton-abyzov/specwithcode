// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { HandoffFolderPicker } from "./HandoffFolderPicker";

const browsed = vi.hoisted(() => [] as unknown[]);
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true, error: null }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    if (query) browsed.push(query);
    return { data: null, isPending: false, error: null };
  },
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

const machine = (id: string, unavailable: string | null = null) => ({
  id: id as EnvironmentId,
  label: id.toUpperCase(),
  online: unavailable === null,
  unavailable,
  workersAllowed: false,
  hasProjectFolder: false,
  lastOnlineAt: null,
});
let root: Root;
let container: HTMLDivElement;
const select = () => container.querySelector<HTMLSelectElement>("select")!;
const render = (props: Partial<Parameters<typeof HandoffFolderPicker>[0]>) =>
  act(async () =>
    root.render(
      <HandoffFolderPicker
        title="Project"
        machines={[machine("m2", "Connect first"), machine("m1"), machine("m3")]}
        machine={null}
        onMachineChange={() => {}}
        onSaved={() => {}}
        {...props}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  browsed.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows the suggested machine instead of an empty choice", async () => {
  await render({ suggestedMachine: "m3" as EnvironmentId, defaultOpen: true });
  expect(select().value).toBe("m3");
  expect([...select().options].map((option) => option.value)).toEqual(["m2", "m1", "m3"]);
  expect(browsed).not.toHaveLength(0);
});

it("falls back to the first available machine and reads nothing while collapsed", async () => {
  await render({ suggestedMachine: "m2" as EnvironmentId });
  expect(select().value).toBe("m1");
  expect(browsed).toHaveLength(0);
});

it("keeps the placeholder only when no machine can take the folder", async () => {
  await render({ machines: [machine("m2", "Connect first")] });
  expect(select().value).toBe("");
  expect(select().options[0]?.textContent).toBe("Choose a machine");
});

it("keeps the opened machine when the suggestion changes", async () => {
  await render({ suggestedMachine: "m3" as EnvironmentId, defaultOpen: true });
  await render({
    suggestedMachine: "m1" as EnvironmentId,
    defaultOpen: true,
    machines: [machine("m2", "Connect first"), machine("m1"), machine("m3", "Connect first")],
  });
  expect(select().value).toBe("m3");
  expect(container.querySelector<HTMLButtonElement>("button:last-of-type")?.disabled).toBe(true);
});

it("adopts a machine that connects while the picker is open", async () => {
  await render({ defaultOpen: true, machines: [machine("m2", "Connect first")] });
  expect(container.querySelector('[aria-label="Remote project folder"]')).toBeNull();
  await render({ defaultOpen: true, machines: [machine("m2", "Connect first"), machine("m1")] });
  expect(select().value).toBe("m1");
  expect(container.querySelector('[aria-label="Remote project folder"]')).not.toBeNull();
});

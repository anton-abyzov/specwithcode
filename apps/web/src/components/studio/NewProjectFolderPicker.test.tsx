// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import { NewProjectFolderPicker } from "./NewProjectFolderPicker";
import { useProjectFolderChoice } from "../../hooks/useProjectFolderChoice";
const state = vi.hoisted(() => ({
  allowed: true,
  pending: false,
  error: null as string | null,
  requests: [] as any[],
}));
vi.mock("../../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({
    canReadFiles: state.allowed,
    error: state.allowed ? null : "No filesystem permission",
  }),
  filesystemEnvironment: {
    browse: (input: any) => {
      state.requests.push(input);
      return input;
    },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: any) => ({
    isPending: state.pending,
    error: state.error,
    data: input
      ? {
          parentPath: input.input.partialPath === "~/" ? "/Users/test" : "/Users/test/Projects",
          entries: [{ name: "Projects", fullPath: "/Users/test/Projects" }],
        }
      : null,
  }),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  state.allowed = true;
  state.pending = false;
  state.error = null;
  state.requests = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
const machine = EnvironmentId.make("m1");
it("starts with no implicit selection, browses the destination and explicitly chooses a parent", async () => {
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <NewProjectFolderPicker
        environmentId={machine}
        selectedPath={null}
        disabled={false}
        onSelect={onSelect}
      />,
    ),
  );
  expect(onSelect).not.toHaveBeenCalled();
  expect(state.requests.at(-1).environmentId).toBe("m1");
  await act(async () => button("Projects").click());
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => button("Use this folder").click());
  expect(onSelect).toHaveBeenCalledWith("/Users/test/Projects");
});
it.each(["pending", "error", "denied"])(
  "does not select a stale directory while %s",
  async (mode) => {
    state.pending = mode === "pending";
    state.error = mode === "error" ? "Offline" : null;
    state.allowed = mode !== "denied";
    await act(async () =>
      root.render(
        <NewProjectFolderPicker
          environmentId={machine}
          selectedPath={null}
          disabled={false}
          onSelect={vi.fn()}
        />,
      ),
    );
    expect(button("Use this folder")).toBeUndefined();
  },
);
it("blocks folder controls while creating", async () => {
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <NewProjectFolderPicker
        environmentId={machine}
        selectedPath={null}
        disabled
        onSelect={onSelect}
      />,
    ),
  );
  expect(button("Use this folder").disabled).toBe(true);
  await act(async () => button("Use this folder").click());
  expect(onSelect).not.toHaveBeenCalled();
});
it("does not reuse a folder from a different machine", async () => {
  function Fixture({ id }: { id: string }) {
    const choice = useProjectFolderChoice(EnvironmentId.make(id), false);
    return (
      <>
        <output>{choice.path ?? "unselected"}</output>
        {choice.picker}
      </>
    );
  }
  await act(async () => root.render(<Fixture id="m1" />));
  await act(async () => button("Use this folder").click());
  expect(container.querySelector("output")!.textContent).toBe("/Users/test");
  await act(async () => root.render(<Fixture id="m3" />));
  expect(container.querySelector("output")!.textContent).toBe("unselected");
  expect(state.requests.at(-1).environmentId).toBe("m3");
});

it("clears an explicit selection for a new creation flow", async () => {
  function Fixture() {
    const choice = useProjectFolderChoice(machine, false);
    return (
      <>
        <output>{choice.path ?? "unselected"}</output>
        <button onClick={choice.reset}>Start again</button>
        {choice.picker}
      </>
    );
  }
  await act(async () => root.render(<Fixture />));
  await act(async () => button("Use this folder").click());
  expect(container.querySelector("output")!.textContent).toBe("/Users/test");
  await act(async () => button("Start again").click());
  expect(container.querySelector("output")!.textContent).toBe("unselected");
});

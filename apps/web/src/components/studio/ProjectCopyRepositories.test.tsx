// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ tag: string; environmentId: string; input: Record<string, any> }>,
  /** Environments this device may write source control in. */
  writable: new Set<string>(),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (environmentId: string) => state.writable.has(environmentId),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => options.tag,
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
const api = {
  path: "repositories/acme/api",
  name: "acme/api",
  key: "github.com/acme/api",
  remoteUrl: "git@github.com:acme/api.git",
};
const web = { ...api, path: "repositories/acme/web", name: "acme/web", key: "github.com/acme/web" };
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (tag: string) => async (request: { environmentId: string; input: Record<string, any> }) => {
      state.calls.push({ tag, ...request });
      if (tag === "projects.repositoriesRead")
        return {
          _tag: "Success",
          value: {
            projectId: "here",
            repositories: [api, web],
            withoutRemote: [],
            truncated: false,
          },
        };
      return {
        _tag: "Success",
        value: {
          projectId: "copy",
          workspaceRoot: "/there",
          results: [
            { path: api.path, status: "present", detail: null },
            {
              path: web.path,
              status: request.input.clone ? "cloned" : "missing",
              detail: null,
            },
          ],
        },
      };
    },
}));

import { ProjectCopyRepositories, useRepositoryInventory } from "./ProjectCopyRepositories";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.calls = [];
  state.writable = new Set(["m1"]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const source = { environmentId: "m4", id: "here" } as never;
const copy = { environmentId: "m1", id: "copy" } as never;

function Row() {
  const inventory = useRepositoryInventory(source, true);
  return <ProjectCopyRepositories copy={copy} inventory={inventory} label="m1" problem={null} />;
}

it("lists what the copy lacks and clones it there from origin", async () => {
  await act(async () => root.render(<Row />));
  await act(async () => {});
  expect(host.textContent).toContain("Missing acme/web.");
  expect(state.calls.map((call) => [call.tag, call.environmentId])).toEqual([
    ["projects.repositoriesRead", "m4"],
    ["projects.repositoriesCheck", "m1"],
  ]);
  expect(state.calls[1]?.input).toEqual({
    projectId: "copy",
    repositories: [api, web],
    clone: false,
  });
  const button = [...host.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Clone from origin on m1"),
  );
  await act(async () => button!.click());
  expect(state.calls.at(-1)?.input.clone).toBe(true);
  expect(host.textContent).toContain("Cloned acme/web.");
  expect(host.querySelector("button")).toBeNull();
});

it("asks nothing of a machine that cannot be reached", async () => {
  function Offline() {
    const inventory = useRepositoryInventory(source, true);
    return (
      <ProjectCopyRepositories
        copy={copy}
        inventory={inventory}
        label="m1"
        problem="m1 is offline."
      />
    );
  }
  await act(async () => root.render(<Offline />));
  await act(async () => {});
  expect(state.calls.map((call) => call.tag)).toEqual(["projects.repositoriesRead"]);
  expect(host.textContent).toBe("");
});

it("leaves the check out where this device may not change source control", async () => {
  state.writable = new Set();
  await act(async () => root.render(<Row />));
  await act(async () => {});
  expect(state.calls.map((call) => call.tag)).toEqual(["projects.repositoriesRead"]);
  expect(host.textContent).toBe("");
});

// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vite-plus/test";
import { state, root, container, click } from "./ProjectWorkspace.test-fixtures";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { UnreachableHostsContext } from "../../studio/unreachableHosts";

vi.mock("../../studio/machineNickname", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/machineNickname")>();
  const nicknames: Record<string, string> = { host: "Studio M4", laptop: "Anna's Air" };
  const resolve = (environmentId: string, fallbackLabel?: string | null) =>
    nicknames[environmentId] ??
    actual.resolveMachineNickname({}, environmentId, fallbackLabel ?? undefined);
  return {
    ...actual,
    useMachineNicknames: () => resolve,
    useMachineNickname: (
      environmentId: string | null | undefined,
      fallbackLabel?: string | null,
    ) => (environmentId ? resolve(environmentId, fallbackLabel) : (fallbackLabel ?? "")),
  };
});

const menuItem = (role: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((element) =>
    element.textContent?.includes(text),
  );

it("names each orchestrator by its nickname, as typed", async () => {
  state.otherCheckouts = [{ id: "project", environmentId: "laptop", workspaceRoot: "/w/atlas" }];
  await act(async () =>
    root.render(<ProjectWorkspace projectKey="atlas" onSelectCheckout={vi.fn()} />),
  );
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("Studio M4");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Viewing Studio M4"]')!.click(),
  );
  expect(menuItem("menuitemradio", "View Studio M4's orchestrator")).toBeDefined();
  expect(menuItem("menuitemradio", "View Anna's Air's orchestrator")).toBeDefined();
});

it("says which nicknamed machine is unreachable", async () => {
  state.otherCheckouts = [
    { id: "remote-project", environmentId: "laptop", workspaceRoot: "/w/atlas" },
  ];
  state.offlineHosts = ["laptop"];
  state.savedMachines = { atlas: "laptop:remote-project" };
  await act(async () =>
    root.render(
      <UnreachableHostsContext.Provider value={new Set(["laptop"])}>
        <ProjectWorkspace projectKey="atlas" />
      </UnreachableHostsContext.Provider>,
    ),
  );
  expect(container.querySelector("[data-orchestrator-status]")?.textContent).toContain(
    "Anna's Air unreachable",
  );
  expect(container.textContent).toContain(
    "Anna's Air is unreachable, so its coordinator cannot take messages.",
  );
});

it("offers a missing checkout's replacement by nickname", async () => {
  state.savedMachines = { atlas: "host:project" };
  const onSelectCheckout = vi.fn();
  await act(async () =>
    root.render(
      <ProjectWorkspace
        projectKey="atlas"
        checkoutKey="host:removed-project"
        onSelectCheckout={onSelectCheckout}
      />,
    ),
  );
  await click("Use Studio M4 · /scratch/atlas");
  expect(onSelectCheckout).toHaveBeenCalledWith("host:project");
});

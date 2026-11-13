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
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("Runs on Studio M4");
  expect(container.querySelectorAll("[data-coordinator-machine]")).toHaveLength(1);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Viewing Studio M4"]')!.click(),
  );
  expect(menuItem("menuitemradio", "Studio M4")).toBeDefined();
  expect(menuItem("menuitemradio", "Anna's Air")).toBeDefined();
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
  expect(container.querySelector("[data-host-status]")?.textContent).toContain(
    "Anna's Air is offline",
  );
  expect(container.textContent).not.toContain("cannot take messages");
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

it("names the machine of a coordinator that asks from another machine", async () => {
  const { shell } = await import("./ProjectWorkspace.test-fixtures");
  const domain = {
    id: "atlas-domain",
    title: "Atlas",
    coordinatorId: "atlas-coordinator",
    members: [
      { environmentId: "host", projectId: "project", coordinatorThreadId: "coord" },
      { environmentId: "laptop", projectId: "remote-project", coordinatorThreadId: "laptop-coord" },
    ],
  };
  Object.assign(state.project, {
    workspaceSettings: { logicalProject: domain, coordinatorThreadId: "coord" },
  });
  state.pairedHosts = ["laptop"];
  state.otherCheckouts = [
    {
      id: "remote-project",
      environmentId: "laptop",
      workspaceRoot: "/w/atlas",
      workspaceSettings: { logicalProject: domain, coordinatorThreadId: "laptop-coord" },
    } as never,
  ];
  state.shells = [
    shell("coord"),
    shell("laptop-coord", {
      environmentId: "laptop" as never,
      projectId: "remote-project" as never,
      hasPendingUserInput: true,
    }),
  ];
  try {
    await act(async () => root.render(<ProjectWorkspace projectKey="atlas" />));
    // Answering it opens that machine's coordinator, so the chip says which one.
    const ask = container.querySelector<HTMLButtonElement>("[data-coordinator-ask]");
    expect(ask?.textContent).toContain("Anna's Air coordinator · Answer needed");
  } finally {
    delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
  }
});

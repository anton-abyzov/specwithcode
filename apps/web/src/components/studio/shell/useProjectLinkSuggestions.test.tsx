// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";

const dialogs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("../../../state/environments", () => ({ usePrimaryEnvironmentId: () => "m4" }));
vi.mock("../../../studio/machineNickname", () => ({
  useMachineNicknames: () => (environmentId: string) => environmentId,
}));
vi.mock("../../../studio/projectListVisibility", () => ({ isOrdinaryProjectChoice: () => true }));
vi.mock("../ProjectLinkDialog", () => ({
  ProjectLinkDialog: (props: Record<string, unknown>) => {
    dialogs.push(props);
    return null;
  },
}));

const { useProjectLinkSuggestions } = await import("./useProjectLinkSuggestions");

const REPO = "github.com/acme/atlas";
const copy = (environmentId: string, linked?: readonly string[]) =>
  ({
    environmentId,
    id: `p-${environmentId}`,
    title: "Atlas",
    workspaceRoot: `/w/${environmentId}/atlas`,
    repositoryIdentity: {
      canonicalKey: REPO,
      rootPath: `/w/${environmentId}/atlas`,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${REPO}.git` },
      displayName: "acme/atlas",
    },
    workspaceSettings: linked
      ? {
          logicalProject: {
            id: "logical:atlas",
            members: linked.map((machine) => ({
              environmentId: machine,
              projectId: `p-${machine}`,
              workspaceRoot: `/w/${machine}/atlas`,
            })),
          },
        }
      : undefined,
  }) as unknown as EnvironmentProject;
const row = (projectKey: string, ...members: EnvironmentProject[]) =>
  ({
    projectKey,
    displayName: "Atlas",
    memberProjects: members,
  }) as unknown as SidebarProjectSnapshot;

let root: Root, container: HTMLDivElement;
let offers: ReturnType<typeof useProjectLinkSuggestions>;
function Sidebar({ groups }: { groups: SidebarProjectSnapshot[] }) {
  offers = useProjectLinkSuggestions(groups, () => null);
  return <>{offers.dialog}</>;
}
const show = (groups: SidebarProjectSnapshot[]) =>
  act(async () => root.render(<Sidebar groups={groups} />));

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  dialogs.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("names every unlinked copy a row holds, and links one at a time", async () => {
  const groups = [row("atlas", copy("m4"), copy("m1"), copy("m3"))];
  await show(groups);
  const offer = offers.suggestionFor(groups[0]!)!;
  expect(offer.label).toBe("Same repository (acme/atlas) also added on m1 and m3, not linked");
  expect(offer.action).toBe("Link with Atlas on m1…");
  await act(async () => offer.onLink());
  expect(dialogs.at(-1)).toMatchObject({
    project: { environmentId: "m4" },
    initialCandidate: { environmentId: "m1", projectId: "p-m1" },
    // Nothing is shared yet, so which coordinator stays is still the person's choice.
    joining: false,
  });
});

it("offers each unlinked row of a repository on three machines its own link", async () => {
  const groups = [row("a", copy("m4")), row("b", copy("m1")), row("c", copy("m3"))];
  await show(groups);
  expect(offers.suggestionFor(groups[0]!)).toBeUndefined();
  expect(offers.suggestionFor(groups[1]!)?.label).toBe(
    "Same repository (acme/atlas) as Atlas on m4",
  );
  expect(offers.suggestionFor(groups[2]!)?.label).toBe(
    "Same repository (acme/atlas) as Atlas on m4",
  );
});

it("keeps main where it is when a copy joins a project already shared", async () => {
  const shared = ["m4", "m1"];
  const groups = [row("a", copy("m4", shared), copy("m1", shared)), row("b", copy("m3"))];
  await show(groups);
  const offer = offers.suggestionFor(groups[1]!)!;
  await act(async () => offer.onLink());
  expect(dialogs.at(-1)).toMatchObject({
    initialCandidate: { environmentId: "m3", projectId: "p-m3" },
    joining: true,
  });
});

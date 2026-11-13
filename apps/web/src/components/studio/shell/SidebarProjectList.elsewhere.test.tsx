// @vitest-environment jsdom
import { DndContext } from "@dnd-kit/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";

const state = vi.hoisted(() => ({ dialogs: [] as Array<[string, unknown]> }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useRouter: () => ({ routesById: {} }),
  useNavigate: () => () => undefined,
}));
vi.mock("../../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./Tip", () => ({
  Tip: ({ children, label }: React.PropsWithChildren<{ label: string }>) => (
    <div data-tip={label}>{children}</div>
  ),
}));
vi.mock("../../../studio/machineNickname", () => ({
  useMachineNicknames: () => (id: string) => ({ m4: "M4", m5: "M5" })[id] ?? id,
}));
vi.mock("../../../studio/machineIdentity", () => ({
  useMachineIdentities: () => () => ({ color: "teal" }),
}));
vi.mock("../../../state/environments", () => ({ usePrimaryEnvironmentId: () => "m4" }));
vi.mock("../../chat/AddToMachineDialog", () => ({
  AddToMachineDialog: (props: { destinationEnvironmentId: string; source: { id: string } }) => {
    state.dialogs.push(["clone", props]);
    return <div data-add-dialog={props.destinationEnvironmentId} />;
  },
}));
vi.mock("../../chat/DraftFolderCopy", () => ({
  DraftFolderCopy: (props: { machine: string }) => {
    state.dialogs.push(["copy", props]);
    return <div data-copy-dialog={props.machine} />;
  },
}));

const { ProjectRow } = await import("./SidebarProjectList");

const project = (environmentId: string, remote: boolean) => ({
  environmentId,
  id: `p-${environmentId}`,
  title: "firstproject",
  workspaceRoot: `/work/${environmentId}/firstproject`,
  environmentLabel: environmentId,
  repositoryIdentity: remote
    ? {
        canonicalKey: "github.com/acme/first",
        locator: { remoteUrl: "git@github.com:acme/first.git" },
      }
    : null,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.dialogs = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render(
  presence: SidebarProjectSnapshot["environmentPresence"],
  members: ReturnType<typeof project>[],
) {
  const group = {
    projectKey: "first",
    displayName: "firstproject",
    workspaceRoot: members[0]!.workspaceRoot,
    environmentPresence: presence,
    allRemoteMembersAreDesktopLocal: false,
    memberProjects: members,
  } as unknown as SidebarProjectSnapshot;
  await act(async () =>
    root.render(
      <DndContext>
        <ul>
          <ProjectRow
            group={group}
            displayedProject={members[0] as never}
            archived={false}
            waiting={0}
            current={false}
            onOpen={() => {}}
            onArchive={() => {}}
          />
        </ul>
      </DndContext>,
    ),
  );
}

const row = () => container.querySelector<HTMLElement>(".sws-project-row");
async function pick(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    "button[aria-label='Actions for firstproject']",
  )!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.click();
  });
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (entry) => entry.textContent === label,
  );
  return item;
}

it("tags a project with no copy on this device with its machine, mutes it, and says why", async () => {
  await render("remote-only", [project("m5", false)]);
  expect(row()?.hasAttribute("data-elsewhere")).toBe(true);
  expect(container.querySelector("[data-project-elsewhere]")?.textContent).toBe("M5");
  expect(container.querySelector("[data-tip]")?.getAttribute("data-tip")).toContain(
    "Runs on M5. No copy on this device.",
  );
  // It still opens: the row stays a link to the project.
  expect(container.querySelector("a.sws-side-row")).not.toBeNull();
});

it("shows no tag on a project this device has a copy of", async () => {
  await render("mixed", [project("m4", false), project("m5", false)]);
  expect(row()?.hasAttribute("data-elsewhere")).toBe(false);
  expect(container.querySelector("[data-project-elsewhere]")).toBeNull();
  expect(await pick("Add to this machine…")).toBeUndefined();
});

it("copies a project with no Git remote to this device from Add to this machine", async () => {
  await render("remote-only", [project("m5", false)]);
  const item = await pick("Add to this machine…");
  await act(async () => item!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(document.querySelector("[data-copy-dialog='m4']")).not.toBeNull();
  expect(state.dialogs.at(-1)?.[0]).toBe("copy");
});

it("clones a project with a Git remote to this device from Add to this machine", async () => {
  await render("remote-only", [project("m5", true)]);
  const item = await pick("Add to this machine…");
  await act(async () => item!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  expect(document.querySelector("[data-add-dialog='m4']")).not.toBeNull();
  expect(state.dialogs.at(-1)?.[0]).toBe("clone");
});

// @vitest-environment jsdom
import { DndContext } from "@dnd-kit/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";

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

const { ProjectRow } = await import("./SidebarProjectList");
type ProjectLinkSuggestion = import("./SidebarProjectList").ProjectLinkSuggestion;

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

async function render(linkSuggestion: ProjectLinkSuggestion, onOpen: () => void) {
  const members = [project("m4", true)];
  const group = {
    projectKey: "first",
    displayName: "firstproject",
    workspaceRoot: members[0]!.workspaceRoot,
    environmentPresence: "local-only",
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
            onOpen={onOpen}
            onArchive={() => {}}
            linkSuggestion={linkSuggestion}
          />
        </ul>
      </DndContext>,
    ),
  );
}

const suggestion = () => ({
  label: "Same repository (acme/first) as firstproject on M5",
  action: "Link with firstproject on M5…",
  onLink: vi.fn<() => void>(),
  onDismiss: vi.fn<() => void>(),
});
const offer = () => container.querySelector<HTMLElement>("[data-link-suggestion]")!;

it("shows the offer as a labeled Link that names the other project and machine", async () => {
  await render(suggestion(), () => {});
  expect(offer().textContent).toBe("Link");
  expect(offer().title).toBe(
    "Same repository (acme/first) as firstproject on M5. Link with firstproject on M5…",
  );
  // The row is a link: the shortcut is for the mouse, and the row's name carries the offer.
  expect(offer().getAttribute("aria-hidden")).toBe("true");
  expect(offer().closest("a")?.querySelector("[role='button'], button, [tabindex]")).toBeNull();
  expect(offer().closest("a")?.textContent).toContain(
    ", Same repository (acme/first) as firstproject on M5",
  );
});

it("opens the link dialog from a click without opening the project", async () => {
  const link = suggestion();
  const onOpen = vi.fn<() => void>();
  await render(link, onOpen);
  await act(async () => offer().click());
  expect(link.onLink).toHaveBeenCalledTimes(1);
  expect(onOpen).not.toHaveBeenCalled();
});

it("holds the same action in the row's menu, for the keyboard and screen readers", async () => {
  const link = suggestion();
  await render(link, () => {});
  const trigger = container.querySelector<HTMLButtonElement>(
    "button[aria-label='Actions for firstproject']",
  )!;
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.click();
  });
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (entry) => entry.textContent === "Link with firstproject on M5…",
  );
  await act(async () => item!.click());
  expect(link.onLink).toHaveBeenCalledTimes(1);
});

import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { EnvironmentId } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../chat/AddToMachineDialog", () => ({ AddToMachineDialog: () => null }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => <div data-menu>{children}</div>,
  MenuTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  MenuPopup: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
  MenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <li>
      <button type="button" data-item onClick={onClick}>
        {children}
      </button>
    </li>
  ),
}));

import { AddProjectToMachineView } from "./AddProjectToMachine";

const here = EnvironmentId.make("env-here");
const project = (title: string) =>
  ({ environmentId: here, id: `p-${title}`, title }) as unknown as EnvironmentProject;

describe("Add a project to a joined machine", () => {
  it("names the one project on the button when there is only one", async () => {
    const onChoose = vi.fn();
    const only = project("specweave");
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<AddProjectToMachineView name="M5" choices={[only]} onChoose={onChoose} />);
    });
    const button = view.root.findByType("button");
    expect(renderToStaticMarkup(<>{button.props.children}</>)).toContain("Add specweave to M5");
    await act(async () => button.props.onClick());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(only);
    expect(JSON.stringify(view.toJSON())).toContain(
      "A project's workers skip a machine that has no copy of it. Add one so M5 can take work.",
    );
    await act(async () => view.unmount());
  });

  it("offers a list when there are several", async () => {
    const onChoose = vi.fn();
    const choices = [project("alpha"), project("zeta")];
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(<AddProjectToMachineView name="M5" choices={choices} onChoose={onChoose} />);
    });
    const html = renderToStaticMarkup(
      <AddProjectToMachineView name="M5" choices={choices} onChoose={onChoose} />,
    );
    expect(html).toContain("Add a project to M5");
    const items = view.root.findAllByProps({ "data-item": true });
    expect(items).toHaveLength(2);
    await act(async () => items[1]!.props.onClick());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(choices[1]);
    await act(async () => view.unmount());
  });

  it("says what to do first when this machine has no project to add", () => {
    const html = renderToStaticMarkup(
      <AddProjectToMachineView name="M5" choices={[]} onChoose={vi.fn()} />,
    );
    expect(html).toContain("Open a project on this machine first, then add it to M5 here.");
    expect(html).not.toContain("<button");
  });
});

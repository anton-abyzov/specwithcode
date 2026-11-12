import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { EnvironmentId } from "@specweave-studio/contracts";
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const here = EnvironmentId.make("env-here");
const there = EnvironmentId.make("env-there");
const runtime = vi.hoisted(() => ({
  here: null as string | null,
  projects: [] as unknown[],
  live: new Set<string>(),
  dialog: null as null | {
    source: { id: string };
    destinationEnvironmentId: string;
    onOpenChange: (open: boolean) => void;
    onAdded: (target: unknown) => void;
  },
}));

vi.mock("../chat/AddToMachineDialog", () => ({
  AddToMachineDialog: (props: NonNullable<typeof runtime.dialog>) => {
    runtime.dialog = props;
    return <div data-dialog />;
  },
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => runtime.projects,
  useServerConfigs: () => new Map(),
  useEnvironmentShellLive: (environmentId: string | null) =>
    environmentId !== null && runtime.live.has(environmentId),
}));
vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => runtime.here }));
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

import { AddProjectToMachine, AddProjectToMachineView } from "./AddProjectToMachine";

const project = (title: string) =>
  ({
    environmentId: here,
    id: `p-${title}`,
    title,
    workspaceRoot: `/Users/a/${title}`,
    workspaceSettings: { kind: "code" },
  }) as unknown as EnvironmentProject;

let view: ReactTestRenderer | null = null;
async function mount(node: ReactElement) {
  await act(async () => {
    view = create(node);
  });
  return view!;
}
const prompts = () => view!.root.findAllByProps({ "data-testid": "add-project-to-machine" });
const dialogs = () => view!.root.findAllByProps({ "data-dialog": true });

afterEach(async () => {
  if (view) await act(async () => view!.unmount());
  view = null;
  runtime.here = null;
  runtime.projects = [];
  runtime.live = new Set();
  runtime.dialog = null;
});

describe("Add a project to a joined machine", () => {
  it("opens the add dialog for the chosen project and keeps it open once the machine has it", async () => {
    runtime.here = here;
    runtime.projects = [project("specweave")];
    runtime.live = new Set([here, there]);
    await mount(<AddProjectToMachine environmentId={there} name="M5" empty />);
    expect(prompts()).toHaveLength(1);
    expect(dialogs()).toHaveLength(0);

    await act(async () => view!.root.findByType("button").props.onClick());
    expect(dialogs()).toHaveLength(1);
    expect(runtime.dialog?.source.id).toBe("p-specweave");
    expect(runtime.dialog?.destinationEnvironmentId).toBe(there);

    // The project arrives on the machine: the prompt goes, the dialog must not.
    await act(async () =>
      view!.update(<AddProjectToMachine environmentId={there} name="M5" empty={false} />),
    );
    expect(prompts()).toHaveLength(0);
    expect(dialogs()).toHaveLength(1);

    await act(async () => runtime.dialog!.onAdded({}));
    expect(dialogs()).toHaveLength(0);
  });

  it("closes the dialog when it is dismissed", async () => {
    runtime.here = here;
    runtime.projects = [project("specweave")];
    runtime.live = new Set([here, there]);
    await mount(<AddProjectToMachine environmentId={there} name="M5" empty />);
    await act(async () => view!.root.findByType("button").props.onClick());
    await act(async () => runtime.dialog!.onOpenChange(false));
    expect(dialogs()).toHaveLength(0);
    expect(prompts()).toHaveLength(1);
  });

  it("says nothing until both machines' project lists are in", async () => {
    runtime.here = here;
    runtime.projects = [];
    runtime.live = new Set([here]);
    await mount(<AddProjectToMachine environmentId={there} name="M5" empty />);
    expect(prompts()).toHaveLength(0);
    runtime.live = new Set([there]);
    await act(async () =>
      view!.update(<AddProjectToMachine environmentId={there} name="M5" empty />),
    );
    expect(prompts()).toHaveLength(0);
    runtime.live = new Set([here, there]);
    await act(async () =>
      view!.update(<AddProjectToMachine environmentId={there} name="M5" empty />),
    );
    expect(prompts()).toHaveLength(1);
  });

  it("offers nothing for this machine itself, or while this machine is unknown", async () => {
    runtime.projects = [project("specweave")];
    runtime.live = new Set([here, there]);
    runtime.here = here;
    await mount(<AddProjectToMachine environmentId={here} name="M4" empty />);
    expect(view!.toJSON()).toBeNull();
    runtime.here = null;
    await act(async () =>
      view!.update(<AddProjectToMachine environmentId={there} name="M5" empty />),
    );
    expect(view!.toJSON()).toBeNull();
  });

  it("names the one project on the button when there is only one", async () => {
    const onChoose = vi.fn();
    const only = project("specweave");
    await mount(<AddProjectToMachineView name="M5" choices={[only]} onChoose={onChoose} />);
    const button = view!.root.findByType("button");
    expect(renderToStaticMarkup(<>{button.props.children}</>)).toContain("Add specweave to M5");
    await act(async () => button.props.onClick());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(only);
    expect(JSON.stringify(view!.toJSON())).toContain(
      "M5 can only run a project it has a copy of. Add one, then choose M5 under Run on in a chat",
    );
  });

  it("offers a list when there are several", async () => {
    const onChoose = vi.fn();
    const choices = [project("alpha"), project("zeta")];
    await mount(<AddProjectToMachineView name="M5" choices={choices} onChoose={onChoose} />);
    expect(
      renderToStaticMarkup(
        <AddProjectToMachineView name="M5" choices={choices} onChoose={onChoose} />,
      ),
    ).toContain("Add a project to M5");
    const items = view!.root.findAllByProps({ "data-item": true });
    expect(items).toHaveLength(2);
    await act(async () => items[1]!.props.onClick());
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(choices[1]);
  });

  it("says what to do first when this machine has no project to add", () => {
    const html = renderToStaticMarkup(
      <AddProjectToMachineView name="M5" choices={[]} onChoose={vi.fn()} />,
    );
    expect(html).toContain("Open a project on this machine first, then add it to M5 here.");
    expect(html).not.toContain("<button");
  });
});

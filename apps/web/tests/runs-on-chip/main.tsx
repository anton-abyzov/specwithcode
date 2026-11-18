/* Synthetic data only. The "Runs on <machine>" chip in each place it shows, for every
   machine color and for a machine with no color:
   - `coordinator`: a project coordinator's message box with the machine menu (a Button).
   - `percy`: a message box with no menu to offer, as Percy's (the plain chip).
   - `local`: a sent chat's chip on this computer (ThreadMachineComposerChip).
   - `remote`: a sent chat's chip on another machine.
   `?theme=dark` for the dark theme. */
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { MachineColorId } from "@specweave-studio/contracts";
import { ThreadMachineComposerChip } from "../../src/components/chat/ThreadMachineComposerChip";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import type { OrchestratorCopy } from "../../src/studio/projectCoordinatorMachine";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const COLORS: ReadonlyArray<MachineColorId | null> = [
  "violet",
  "teal",
  "amber",
  "rose",
  "blue",
  "green",
  "orange",
  "slate",
  null,
];

const copy = (machine: string, main: boolean): OrchestratorCopy => ({
  key: `${machine}:p`,
  machine,
  folder: "/w/atlas",
  role: main ? "coordinator" : "workers",
  main,
  label: main ? { text: "Main" } : { text: "Copy · main on {machine}", values: { machine: "m4" } },
  canStart: false,
});

/** The coordinator message box's foot, holding the chip where CoordinatorComposer puts it. */
function Foot({ children }: { children: React.ReactNode }) {
  return (
    <div className="project-composer sws-composer">
      <div className="sws-composer-foot">
        <span className="sws-composer-meta">{children}</span>
      </div>
    </div>
  );
}

function Switcher({ color, menu }: { color: MachineColorId | null; menu: boolean }) {
  const identity = color ? ({ color } as never) : null;
  return (
    <Foot>
      <OrchestratorSwitcher
        identity={identity}
        label="m1"
        hostLabel="Fixture laptop"
        connected
        statusDetail=""
        current="m1:p"
        copies={menu ? [copy("m1", true), copy("m4", false)] : [copy("m1", true)]}
        unknown={[]}
        savedMachineMissing={false}
        onView={menu ? () => {} : null}
        onAllowWorkers={null}
      />
    </Foot>
  );
}

function ThreadChip({ color, here }: { color: MachineColorId | null; here: boolean }) {
  return (
    <div className="flex min-w-0 items-center">
      <ThreadMachineComposerChip
        size="sm"
        machine={{
          kind: "laptop",
          label: here ? "m4" : "m1",
          short: here ? "M4" : "M1",
          tip: here ? "Runs on this computer, m4." : "Runs on m1.",
          warning: null,
          isThisMachine: here,
          ...(color ? { color } : {}),
        }}
      />
    </div>
  );
}

const CASES = [
  ["coordinator", (color: MachineColorId | null) => <Switcher color={color} menu />],
  ["percy", (color: MachineColorId | null) => <Switcher color={color} menu={false} />],
  ["local", (color: MachineColorId | null) => <ThreadChip color={color} here />],
  ["remote", (color: MachineColorId | null) => <ThreadChip color={color} here={false} />],
] as const;

function Page() {
  return (
    <div className="fixture-grid">
      {CASES.map(([name, render]) =>
        COLORS.map((color) => (
          <div
            key={`${name}-${color ?? "none"}`}
            className="fixture-row"
            data-case={name}
            data-color={color ?? "none"}
          >
            <b>
              {name} · {color ?? "no color"}
            </b>
            {render(color)}
          </div>
        )),
      )}
    </div>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            <Page />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

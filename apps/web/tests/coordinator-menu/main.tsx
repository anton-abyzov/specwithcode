// The project machine menu from the "Runs on m4" chip, over fictional machines:
// m4 is viewed and runs the coordinator, m1 only runs workers and kept its coordinator
// from before, linux-mini runs its own. `?theme=dark` for dark.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import type { OrchestratorCopy } from "../../src/studio/projectCoordinatorMachine";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");

const linkedCopies: OrchestratorCopy[] = [
  {
    key: "m1:p",
    machine: "m1",
    folder: "/w/specweave",
    role: "workers",
    main: false,
    label: { text: "Copy · main on {machine}", values: { machine: "m4" } },
    canStart: true,
  },
  {
    key: "mini:p",
    machine: "linux-mini",
    folder: "/w/specweave",
    role: "coordinator",
    main: false,
    label: { text: "Copy · main on {machine}", values: { machine: "m4" } },
    canStart: false,
  },
  {
    key: "m4:p",
    machine: "m4",
    folder: "/w/specweave",
    role: "coordinator",
    main: true,
    label: { text: "Main" },
    canStart: false,
  },
];
// `?case=unlinked`: the same repository registered on three machines, never linked.
const unlinkedCopies: OrchestratorCopy[] = ["m1", "m3", "m4"].map((machine) => ({
  key: `${machine}:p`,
  machine,
  folder: "/w/easychamp",
  role: "independent",
  main: false,
  label: { text: "not linked" },
  canStart: false,
}));
// Link offers for the other machines, as the page passes them for unlinked copies.
const unlinkedLinks = unlinkedCopies.map(({ key, machine }) => ({ key, machine }));
const unlinked = params.get("case") === "unlinked";
const copies = unlinked ? unlinkedCopies : linkedCopies;

function Page() {
  const [current, setCurrent] = useState("m4:p");
  const label = copies.find((copy) => copy.key === current)!.machine;
  return (
    <div className="fixture-page" data-viewing={current}>
      <OrchestratorSwitcher
        identity={{ color: "teal" } as never}
        label={label}
        connected
        statusDetail=""
        current={current}
        copies={copies}
        unknown={[]}
        savedMachineMissing={false}
        onView={setCurrent}
        onMove={() => {}}
        onAllowWorkers={() => {}}
        onMigrate={() => {}}
        onCopy={() => {}}
        onLeave={() => {}}
        links={unlinked ? unlinkedLinks.filter((link) => link.key !== current) : []}
        onLink={unlinked ? () => {} : null}
      />
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

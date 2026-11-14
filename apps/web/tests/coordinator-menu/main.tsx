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

const copies: OrchestratorCopy[] = [
  { key: "m1:p", machine: "m1", folder: "/w/specweave", role: "workers", canStart: true },
  {
    key: "mini:p",
    machine: "linux-mini",
    folder: "/w/specweave",
    role: "coordinator",
    canStart: false,
  },
  { key: "m4:p", machine: "m4", folder: "/w/specweave", role: "coordinator", canStart: false },
];

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
        onStart={async () => true}
        onAllowWorkers={() => {}}
        onMigrate={() => {}}
        onCopy={() => {}}
        onLeave={() => {}}
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

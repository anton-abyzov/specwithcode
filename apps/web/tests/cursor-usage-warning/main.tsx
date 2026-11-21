// The Usage page's Cursor card with its warning. Query: ?theme=light|dark
import { EnvironmentId } from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { CursorEnableLimits } from "~/components/usage/CursorUsageEnable";
import { TooltipProvider } from "~/components/ui/tooltip";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <CursorEnableLimits
        environments={[{ environmentId: EnvironmentId.make("build-mac"), label: "Build Mac" }]}
        onEnabled={() => window.fixtureCalls.push({ enabled: true })}
      />
    </main>
  </TooltipProvider>,
);

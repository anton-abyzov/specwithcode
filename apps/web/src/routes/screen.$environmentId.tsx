import type { EnvironmentId } from "@specweave-studio/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ScreenViewerRun } from "../components/screenShare/ScreenViewerRun";

const NAME_MAX = 120;

function ScreenViewerRoute() {
  const { environmentId } = Route.useParams();
  const { name } = Route.useSearch();
  const machine = name === "" ? "another machine" : name;
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      {/* Room for the window's own buttons; the page cannot be dragged elsewhere. */}
      <div className="h-11 shrink-0 [-webkit-app-region:drag]" aria-hidden />
      <ScreenViewerRun
        environmentId={environmentId as EnvironmentId}
        machine={machine}
        onClose={() => window.close()}
      />
    </div>
  );
}

// A machine's screen in a window of its own (1519); __root.tsx gives this route a bare layout.
export const Route = createFileRoute("/screen/$environmentId")({
  validateSearch: (raw: Record<string, unknown>): { name: string } => ({
    // The router reads search values as JSON: a machine named 42 arrives as a number.
    name:
      typeof raw.name === "string" || typeof raw.name === "number" || typeof raw.name === "boolean"
        ? String(raw.name).slice(0, NAME_MAX)
        : "",
  }),
  component: ScreenViewerRoute,
});

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { FolderIcon, LayersIcon } from "lucide-react";
import { CompactFilterMenu } from "../../src/components/pullRequest/CompactFilterMenu";
import {
  PullRequestFiltersMenu,
  pullRequestProjectKey,
} from "../../src/components/pullRequest/PullRequestListFilters";
import { pullRequestScopeFilterProjects } from "../../src/components/pullRequest/pullRequestProjectFilter.logic";
import { ineligibleProjectLabel } from "../../src/studio/projectListVisibility";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";
const local = EnvironmentId.make("machine-a");
const remote = EnvironmentId.make("machine-b");
const make = (
  id: string,
  title: string,
  workspaceSettings = {},
  workspaceRoot = `/work/${id}`,
  environmentId = local,
) => ({
  id: ProjectId.make(id),
  title,
  workspaceSettings,
  workspaceRoot,
  environmentId,
  repositoryIdentity: { canonicalKey: "github.com/example/app" },
});
const catalog = [
  make("active", "App"),
  make("second", "App"),
  make("active", "App", {}, "/work/app", remote),
  make("inactive-twin", "App", { archived: true }, "/work/old", remote),
  make("personal", "Assistant", { kind: "personal" }),
  make("old", "Archived", { archived: true }),
  make("auto", "Automated", { origin: "automated" }),
  make("inferred", "Fixture", {}, "/work/fixtures/demo"),
  make("scratch", "No project", {}, "/scratch"),
];
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
function Fixture() {
  const [selection, setSelection] = useState(params.get("selected") ?? "");
  const selected = catalog.find(
    (p) => pullRequestProjectKey(p) === selection || p.id === selection,
  );
  const { projects, unavailable } = pullRequestScopeFilterProjects(
    catalog,
    () => "/scratch",
    new Map([
      [local, "Laptop"],
      [remote, "Desktop"],
    ]),
    selected,
  );
  const unavailableMap = new Map(
    unavailable
      ? [[pullRequestProjectKey(unavailable.project), ineligibleProjectLabel(unavailable.reason)]]
      : [],
  );
  const options = [
    { value: "", label: "All projects", Icon: LayersIcon },
    ...projects.map((p) => ({
      value: pullRequestProjectKey(p),
      label: p.title,
      Icon: FolderIcon,
      ...(unavailableMap.has(pullRequestProjectKey(p))
        ? { unavailable: unavailableMap.get(pullRequestProjectKey(p)) }
        : {}),
    })),
  ];
  return (
    <TooltipProvider>
      <main className="fixture">
        <h1>Code Review</h1>
        <div className="fixture-row">
          <span>Project</span>
          <div className="wide-controls">
            <CompactFilterMenu
              label="Filter by project"
              value={selected ? pullRequestProjectKey(selected) : ""}
              options={options}
              onChange={setSelection}
              outlined
            />
          </div>
          <div className="narrow-controls">
            <PullRequestFiltersMenu
              state="open"
              stateOptions={[]}
              onState={() => {}}
              involvement="all"
              involvementOptions={[]}
              onInvolvement={() => {}}
              filters={{}}
              onFilters={() => {}}
              host={undefined}
              hostOptions={[]}
              onHost={() => {}}
              server={undefined}
              serverOptions={[]}
              onServer={() => {}}
              projects={projects}
              projectId={selected?.id}
              projectEnvironmentId={selected?.environmentId}
              unavailable={unavailableMap}
              onProject={(id, env) =>
                setSelection(id && env ? pullRequestProjectKey({ id, environmentId: env }) : "")
              }
            />
          </div>
        </div>
        <p>Open a project filter to choose a checkout.</p>
        <output data-testid="selected-project">
          {selected ? `${selected.environmentId}:${selected.id}` : "All projects"}
        </output>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

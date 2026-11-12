// Two steps of first-run setup in their real frame, over stand-ins (mocks.tsx):
// `view=connection` and `view=projects` (`found=0` when nothing was found).
// `platform=macos|windows|linux` draws keys and button order as that system
// does, `theme=dark` the dark theme, and `lang=ru` (any app language) the words.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@specweave-studio/contracts";
import { ConnectionStep } from "../../src/components/onboarding/ConnectionStep";
import { ImportStep } from "../../src/components/onboarding/ProjectsStep";
import { FirstRunFrame, shownStages } from "../../src/components/onboarding/WizardFrame";
import { t } from "../../src/i18n";
import { isLocale, setLocalePreference } from "../../src/i18n/locale";
import { calls, useProjectScans } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const platform = params.get("platform");
if (platform) document.documentElement.dataset.platform = platform;
const lang = params.get("lang");
setLocalePreference(isLocale(lang) ? lang : "en");
const view = params.get("view") === "projects" ? "projects" : "connection";
const HERE = EnvironmentId.make("here");

function Setup() {
  const [selected, setSelected] = useState<ReadonlySet<EnvironmentId>>(new Set([HERE]));
  const [importing, setImporting] = useState(false);
  const scans = useProjectScans(view === "projects" ? [HERE] : []);
  const stages = shownStages([
    { id: "connect", label: t("wizard.stage.connect") },
    { id: "agents", label: t("wizard.stage.agents") },
    { id: "projects", label: t("wizard.stage.projects") },
  ]);
  return (
    <FirstRunFrame
      stages={stages}
      currentStage={view === "projects" ? 2 : 0}
      stagesLocked={importing}
      onStageChange={(stage) => calls.push(["stage", stage.id])}
      canClose={!importing}
      onLeave={() => calls.push(["leave"])}
    >
      {view === "connection" ? (
        <ConnectionStep
          expandPairingInitially={false}
          connectOptional
          selectedIds={selected}
          autoSelectedComputers={new Set()}
          onSelectionChange={setSelected}
          onToggleEnvironment={(environmentId, checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(environmentId);
              else next.delete(environmentId);
              return next;
            })
          }
          onContinue={() => calls.push(["continue"])}
          onPaired={(environmentId) => calls.push(["paired", environmentId])}
        />
      ) : (
        <ImportStep
          scans={scans as never}
          isImporting={importing}
          setIsImporting={setImporting}
          onBack={() => calls.push(["back"])}
          onDone={async (projectRef) => {
            calls.push(["done", projectRef?.projectId ?? null]);
            return true;
          }}
        />
      )}
    </FirstRunFrame>
  );
}
createRoot(document.getElementById("root")!).render(<Setup />);

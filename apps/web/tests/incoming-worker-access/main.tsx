// The join card of Settings > Machines by itself, with the folded join line
// section under it. See mocks.tsx for the query parameters; `variant=first-run`
// shows the card as a first-run step and `fold=open` opens the section.
// `view=setup` shows the first step of setup, which holds the card: sign in,
// this machine links by itself, then the choice and its Allow. `view=frame`
// shows a long step in the same frame, with every part of the shared footer.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@specweave-studio/contracts";
import { SignInFirstStep } from "../../src/components/onboarding/SignInFirstStep";
import { AccountJoinCard } from "../../src/components/settings/AccountJoinCard";
import { OtherAccountJoinFold } from "../../src/components/settings/OtherAccountJoinFold";
import {
  FirstRunFrame,
  shownStages,
  StepShell,
  WizardStepFooter,
} from "../../src/components/onboarding/WizardFrame";
import { calls } from "./mocks";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
// `platform=macos|windows|linux` draws key labels and button order as that system does.
const platform = params.get("platform");
if (platform) document.documentElement.dataset.platform = platform;
const firstRun = params.get("variant") === "first-run";
const root = createRoot(document.getElementById("root")!);

/** A step longer than the window, with every part of the shared footer. */
function FrameStep() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fails = params.get("save") === "fails";
  return (
    <StepShell title="A long step" description="The panel scrolls; the footer stays in view.">
      <input
        aria-label="Folder"
        className="mt-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        placeholder="A field in the step"
      />
      <ul className="mt-4 space-y-2">
        {Array.from({ length: 24 }, (_, index) => (
          <li
            key={index}
            className="rounded-lg border border-border bg-background px-3 py-3 text-sm"
          >
            Row {index + 1}
          </li>
        ))}
      </ul>
      <WizardStepFooter
        error={error}
        note={saving ? "Saving. Setup goes on when this finishes." : null}
        back={{ onClick: () => calls.push(["back"]), disabled: saving }}
        skip={{ label: "Keep Supervised", onClick: () => calls.push(["skip"]), disabled: saving }}
        primary={{
          label: saving ? "Saving…" : "Use Full access",
          busy: saving,
          onClick: () => {
            calls.push(["primary"]);
            if (!fails) return;
            setSaving(true);
            setError(null);
            setTimeout(() => {
              setSaving(false);
              setError("That was not saved. Try again.");
            }, 300);
          },
        }}
      />
    </StepShell>
  );
}
const view = params.get("view");
if (view === "setup" || view === "frame") {
  // The real frame of setup: stage bar, scrolling panel, the step's footer below it.
  const stages = shownStages([
    { id: "connect", label: "Sign in" },
    { id: "agents", label: "Agents" },
    { id: "access", label: "Access", when: params.get("access") === "on" },
    { id: "projects", label: "Projects" },
  ]);
  root.render(
    <FirstRunFrame
      stages={stages}
      currentStage={view === "frame" ? 1 : 0}
      onStageChange={(stage) => calls.push(["stage", stage.id])}
      canClose={params.get("close") !== "off"}
      onLeave={() => calls.push(["leave"])}
    >
      {view === "frame" ? (
        <FrameStep />
      ) : (
        <SignInFirstStep
          environmentId={EnvironmentId.make("m5")}
          machineNoun="Mac"
          rulesKnown
          onContinue={() => calls.push(["continue"])}
          onOtherComputers={() => calls.push(["other-computers"])}
        />
      )}
    </FirstRunFrame>,
  );
} else
  root.render(
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <p className="text-xs text-muted-foreground">
        {firstRun ? "First run / Your machines" : "Settings / Machines"}
      </p>
      <AccountJoinCard
        environmentId={EnvironmentId.make("m5")}
        variant={firstRun ? "first-run" : "settings"}
        onDone={(allowed) => calls.push(["done", allowed])}
        onSkip={() => calls.push(["skip"])}
        onShowConnectSwitch={() => calls.push(["show-switch"])}
      />
      {firstRun ? null : (
        <section className="overflow-hidden rounded-xl border border-border/60 bg-card/60">
          <p className="px-3 py-2.5 text-sm font-medium sm:px-4">Your private machines</p>
          <OtherAccountJoinFold
            openFor={params.get("fold") === "open"}
            targetIds={["private-machines-add", "private-machines-invite"]}
          >
            {/* The real rows need the whole page; these stand in for them. */}
            <div
              id="private-machines-add"
              className="border-t border-border/60 px-3 py-3 text-sm sm:px-4"
            >
              Add a machine
            </div>
            <div
              id="private-machines-invite"
              className="border-t border-border/60 px-3 py-2.5 text-sm sm:px-4"
            >
              Join a main machine
            </div>
          </OtherAccountJoinFold>
        </section>
      )}
    </main>,
  );

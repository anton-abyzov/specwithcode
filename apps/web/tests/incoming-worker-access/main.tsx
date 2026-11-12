// The join card of Settings > Machines by itself, with the folded join line
// section under it. See mocks.tsx for the query parameters; `variant=first-run`
// shows the card as a first-run step and `fold=open` opens the section.
// `view=setup` shows the first step of setup, which holds the card: sign in,
// this machine links by itself, then the choice and its Allow.
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@specweave-studio/contracts";
import { SignInFirstStep } from "../../src/components/onboarding/SignInFirstStep";
import { AccountJoinCard } from "../../src/components/settings/AccountJoinCard";
import { OtherAccountJoinFold } from "../../src/components/settings/OtherAccountJoinFold";
import { StudioWordmark } from "../../src/components/StudioWordmark";
import { Dialog } from "../../src/components/ui/dialog";
import {
  WizardHeader,
  WizardPanel,
  WizardPopup,
  WizardSteps,
} from "../../src/components/ui/wizard";
import { calls } from "./mocks";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const firstRun = params.get("variant") === "first-run";
const root = createRoot(document.getElementById("root")!);
if (params.get("view") === "setup") {
  root.render(
    <Dialog open>
      <WizardPopup size="wide" bottomStickOnMobile={false} showCloseButton={false}>
        <WizardHeader
          title="Set up SpecWithCode"
          identity={
            <div className="flex items-center gap-2" role="img" aria-label="SpecWithCode">
              <StudioWordmark className="size-6 shrink-0" aria-hidden />
              <span className="text-2xl font-medium tracking-tight text-muted-foreground">
                SpecWithCode
              </span>
            </div>
          }
        >
          <WizardSteps
            steps={["Computers", "Agents", "Projects"]}
            currentStep={0}
            isStepDisabled={() => true}
            onStepChange={() => undefined}
          />
        </WizardHeader>
        <WizardPanel>
          <SignInFirstStep
            environmentId={EnvironmentId.make("m5")}
            machineNoun="Mac"
            rulesKnown
            onContinue={() => calls.push(["continue"])}
            onOtherComputers={() => calls.push(["other-computers"])}
          />
        </WizardPanel>
      </WizardPopup>
    </Dialog>,
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

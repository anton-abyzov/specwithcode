import { createRoot } from "react-dom/client";
import { MachineRoleStep } from "../../src/components/onboarding/JoinMachineSteps";
import {
  FirstRunUpdateNoticeView,
  type FirstRunUpdateView,
} from "../../src/components/onboarding/FirstRunUpdateNotice";
import { firstStepControl } from "../../src/components/onboarding/wizardFocus";
import { StudioWordmark } from "../../src/components/StudioWordmark";
import { Dialog } from "../../src/components/ui/dialog";
import { DialogCloseButton } from "../../src/components/ui/dialog-close-button";
import { WizardHeader, WizardPanel, WizardPopup } from "../../src/components/ui/wizard";
import "./fixture.css";

// The welcome wizard's first-run choice as it renders on a machine with a
// server (desktop): the real step, close button and update notice.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const noop = () => {};
const updates: Record<string, FirstRunUpdateView | null> = {
  none: null,
  available: { kind: "download", version: "1.0.136" },
  downloading: { kind: "downloading", percent: 42 },
  ready: { kind: "install", version: "1.0.136" },
};
const update = updates[params.get("update") ?? "none"] ?? null;

createRoot(document.getElementById("root")!).render(
  <Dialog open disablePointerDismissal onOpenChange={(_, event) => event.cancel()}>
    <WizardPopup
      size="wide"
      bottomStickOnMobile={false}
      showCloseButton={false}
      initialFocus={() => firstStepControl() ?? true}
    >
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
        {update ? (
          <FirstRunUpdateNoticeView
            view={update}
            downloading={false}
            onDownload={noop}
            onInstall={noop}
          />
        ) : null}
      </WizardHeader>
      <WizardPanel>
        <MachineRoleStep
          machineNoun={params.get("os") === "darwin" ? "Mac" : "machine"}
          onJoin={noop}
          onMain={noop}
          onLater={noop}
        />
      </WizardPanel>
      {/* Last, as in every dialog: setup opens focused on its content. */}
      <DialogCloseButton aria-label="Close setup" title="Close setup" />
    </WizardPopup>
  </Dialog>,
);

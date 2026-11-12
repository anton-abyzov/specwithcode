import type { EnvironmentId, ScopedProjectRef } from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import { SignInFirstStep } from "./SignInFirstStep";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useProjectScans } from "../../onboarding/useProjectScans";
import { ChatGptWelcomeCoordinator } from "../settings/ChatGptWelcomeCoordinator";
import { toastManager } from "../ui/toast";
import { useT, useTx } from "../../i18n";
import { AgentsStep } from "./AgentsStep";
import { ConnectionStep } from "./ConnectionStep";
import { ImportStep } from "./ProjectsStep";
import {
  FirstRunFrame,
  shownStages,
  stageAfter,
  stageBefore,
  type WizardStage,
} from "./WizardFrame";
/**
 * First-run welcome wizard. Rendered over the workspace at `/welcome` on a
 * fresh install (no completed-onboarding flag, empty workspace). Flow per the
 * onboarding overhaul spec: connection choice → sign-in/pair (remote paths) →
 * managed Codex setup or an inline CLI terminal → project import → main screen.
 * Every step past the connection gate is skippable; the whole wizard is
 * re-runnable by clearing the flag.
 *
 * The frame is shared (`WizardFrame.tsx`): the stage bar is built from one list
 * of stages, each step draws the same footer below the scrolling panel, Enter
 * presses the step's primary, and Escape leaves setup as the close button does.
 *
 * Setup asks no question about what this machine is for. On a first run in
 * the desktop app with SpecWithCode Connect it starts at the sign-in
 * (`SignInFirstStep`): that links this machine, lists the account's other
 * machines and lets one start work here. In a browser, or in a build without
 * Connect, it starts at the connection step. The close button, on any step,
 * leaves setup for the app with nothing chosen: there the sidebar can update
 * an old install first. Closing completes onboarding, so it does not come
 * back on the next launch.
 */

type WizardStep = "start" | "connection" | "agents" | "import";
/** A stage of the bar. Several steps can belong to one stage. */
type WizardStageId = "connect" | "agents" | "projects";
const STAGE_OF_STEP: Record<WizardStep, WizardStageId> = {
  start: "connect",
  connection: "connect",
  agents: "agents",
  import: "projects",
};

const NO_ENVIRONMENTS: readonly EnvironmentId[] = [];

export function WelcomeWizard({
  localAvailable,
  onDone,
  resumeEnvironmentId,
  firstRun = false,
}: {
  /** Whether this client is authenticated to the server serving the app. */
  readonly localAvailable: boolean;
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
  /** A first run (setup not finished before) with a server on this machine. */
  readonly firstRun?: boolean | undefined;
}) {
  const t = useT();
  const tx = useTx();
  const completeOnboarding = useCompleteOnboarding();
  // Until the person moves, the step follows saved settings, which can
  // finish loading after the first render.
  const [chosenStep, setStep] = useState<WizardStep | null>(resumeEnvironmentId ? "agents" : null);
  // A first run in the desktop app with SpecWithCode Connect starts at the
  // sign-in, which links this machine and lists the account's others.
  const signInFirst = hasCloudPublicConfig() && window.desktopBridge !== undefined;
  const entryStep: WizardStep = firstRun && signInFirst ? "start" : "connection";
  const step: WizardStep = chosenStep ?? entryStep;
  const { environments } = useEnvironments();
  const [selection, setSelection] = useState<ReadonlySet<EnvironmentId> | null>(null);
  const autoSelectedComputers = useRef(new Set<EnvironmentId>());
  const [setupIds, setSetupIds] = useState<readonly EnvironmentId[]>(
    resumeEnvironmentId ? [resumeEnvironmentId] : [],
  );
  const [isImporting, setIsImporting] = useState(false);
  const finishingPromiseRef = useRef<Promise<boolean> | null>(null);
  const completionErrorToastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  const machineNoun = t(
    primaryEnvironment?.serverConfig?.environment.platform.os === "darwin"
      ? "wizard.noun.mac"
      : "wizard.noun.machine",
  );
  // The whole bar, in order. A stage that does not apply sets `when: false` and
  // drops out of the bar, of Back and of Continue.
  const stages: readonly WizardStage<WizardStageId>[] = [
    {
      id: "connect",
      label: entryStep === "start" ? tx("Sign in") : t("wizard.stage.connect"),
    },
    { id: "agents", label: t("wizard.stage.agents") },
    { id: "projects", label: t("wizard.stage.projects") },
  ];
  const barStages = shownStages(stages);
  // Back and the bar return to the connect step the person went on from, so the
  // computers picked there are still the ones being set up.
  const [leftConnectFrom, setLeftConnectFrom] = useState<"start" | "connection" | null>(null);
  const stepOfStage = (stage: WizardStageId): WizardStep =>
    stage === "connect"
      ? (leftConnectFrom ?? (entryStep === "start" ? "start" : "connection"))
      : stage === "agents"
        ? "agents"
        : "import";
  const goToStage = (stage: WizardStageId | null) => {
    if (stage !== null) setStep(stepOfStage(stage));
  };
  useEffect(() => {
    const newComputers = environments.filter(
      (environment) => !autoSelectedComputers.current.has(environment.environmentId),
    );
    if (newComputers.length === 0) return;
    for (const environment of newComputers) {
      autoSelectedComputers.current.add(environment.environmentId);
    }
    setSelection(
      (current) =>
        new Set([
          ...(current ?? []),
          ...newComputers.map((environment) => environment.environmentId),
        ]),
    );
  }, [environments]);
  const selectedIds =
    selection ?? new Set(primaryEnvironment ? [primaryEnvironment.environmentId] : []);
  const scans = useProjectScans(step === "import" ? setupIds : NO_ENVIRONMENTS);
  const isLoadingProjects =
    step === "import" &&
    scans.every((scan) => scan.data === null) &&
    scans.some((scan) => scan.isPending);
  const startSetup = (ids: readonly EnvironmentId[], from: "start" | "connection") => {
    if (ids.length === 0) return;
    setSetupIds(ids);
    setLeftConnectFrom(from);
    goToStage(stageAfter(stages, "connect"));
  };
  const stageIndex = Math.max(
    0,
    barStages.findIndex((stage) => stage.id === STAGE_OF_STEP[step]),
  );
  const finish = useCallback(
    (projectRef?: ScopedProjectRef, importWarning?: string, importedThreadCount = 0) => {
      if (finishingPromiseRef.current !== null) return finishingPromiseRef.current;
      if (completionErrorToastIdRef.current !== null) {
        toastManager.close(completionErrorToastIdRef.current);
        completionErrorToastIdRef.current = null;
      }

      const completion = completeOnboarding()
        .then(async () => {
          if (completionErrorToastIdRef.current !== null) {
            toastManager.close(completionErrorToastIdRef.current);
            completionErrorToastIdRef.current = null;
          }
          await onDone(projectRef);
          if (importWarning) {
            toastManager.add({
              type: "warning",
              title: t("wizard.toast.historyNotImported"),
              description: importWarning,
              timeout: 0,
            });
          } else if (importedThreadCount > 0) {
            toastManager.add({
              type: "success",
              title: t("wizard.toast.imported", { count: importedThreadCount }),
            });
          }
          return true;
        })
        .catch(() => {
          const errorToast = {
            type: "error",
            title: t("wizard.toast.finishFailed"),
            description: t("wizard.toast.settingsNotSaved"),
          } as const;
          if (completionErrorToastIdRef.current === null) {
            completionErrorToastIdRef.current = toastManager.add(errorToast);
          } else {
            toastManager.update(completionErrorToastIdRef.current, errorToast);
          }
          return false;
        })
        .finally(() => {
          if (finishingPromiseRef.current === completion) {
            finishingPromiseRef.current = null;
          }
        });
      finishingPromiseRef.current = completion;
      return completion;
    },
    [completeOnboarding, onDone, t],
  );

  // Without a server here there is nothing to open yet, so pairing stays
  // required; an import in flight finishes first.
  const canClose = localAvailable && !isImporting;
  const leaveSetup = () => {
    void finish();
  };

  return (
    <FirstRunFrame
      stages={barStages}
      currentStage={stageIndex}
      stagesLocked={isImporting}
      onStageChange={(stage) => goToStage(stage.id)}
      canClose={canClose}
      onLeave={leaveSetup}
      holdHeight={isLoadingProjects}
      after={<ChatGptWelcomeCoordinator />}
    >
      {step === "start" ? (
        primaryEnvironmentId ? (
          <SignInFirstStep
            environmentId={primaryEnvironmentId}
            machineNoun={machineNoun}
            rulesKnown={primaryEnvironment?.serverConfig != null}
            onContinue={() => startSetup([primaryEnvironmentId], "start")}
            onOtherComputers={() => setStep("connection")}
          />
        ) : null
      ) : step === "connection" ? (
        <ConnectionStep
          // Reached from the sign-in step: that step is one press back.
          onBack={entryStep === "start" ? () => setStep("start") : undefined}
          expandPairingInitially={!localAvailable && !hasCloudPublicConfig()}
          connectOptional={localAvailable}
          selectedIds={selectedIds}
          autoSelectedComputers={autoSelectedComputers.current}
          onSelectionChange={setSelection}
          onToggleEnvironment={(environmentId, checked) =>
            setSelection((current) => {
              const next = new Set(current ?? selectedIds);
              if (checked) next.add(environmentId);
              else next.delete(environmentId);
              return next;
            })
          }
          onContinue={() =>
            startSetup(
              environments
                .filter((environment) => selectedIds.has(environment.environmentId))
                .map((environment) => environment.environmentId),
              "connection",
            )
          }
          onPaired={(environmentId) => {
            setSelection(new Set([...selectedIds, environmentId]));
          }}
        />
      ) : step === "agents" ? (
        <AgentsStep
          environmentIds={setupIds}
          onBack={() => goToStage(stageBefore(stages, "agents"))}
          onContinue={() => goToStage(stageAfter(stages, "agents"))}
        />
      ) : (
        <ImportStep
          scans={scans}
          isImporting={isImporting}
          setIsImporting={setIsImporting}
          onBack={() => goToStage(stageBefore(stages, "projects"))}
          onDone={finish}
        />
      )}
    </FirstRunFrame>
  );
}

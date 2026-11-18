import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@specweave-studio/contracts";
import { isMacPlatform } from "@specweave-studio/shared/keybindings";
import { teamRulesModeAllowed } from "@specweave-studio/shared/teamRules";
import { useCallback, useEffect, useRef, useState } from "react";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useCompleteOnboarding } from "../../onboarding/firstRun";
import {
  useFullAccessRecommendation,
  type AcceptedFullAccess,
} from "../../onboarding/accessRecommendation";
import { shouldRecommendFullAccess } from "../../onboarding/accessRecommendation.logic";
import { accessRows } from "../../onboarding/accessRows.logic";
import { teamRulesFromSummary } from "../../teamRules/teamRulesView";
import { AccessStep } from "./AccessStep";
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

type WizardStep = "start" | "connection" | "agents" | "access" | "import";
/** A stage of the bar. Several steps can belong to one stage. */
type WizardStageId = "connect" | "agents" | "access" | "projects";
const STAGE_OF_STEP: Record<WizardStep, WizardStageId> = {
  start: "connect",
  connection: "connect",
  agents: "agents",
  access: "access",
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
  // Access is recommended once, for the machines being set up, while new chats
  // there would start below Full access and nothing else has decided it.
  const fullAccess = useFullAccessRecommendation();
  // A chat on another machine starts with this machine's access, so this
  // machine is always one of them.
  const accessMachineIds = [
    ...new Set([...(primaryEnvironmentId ? [primaryEnvironmentId] : []), ...setupIds]),
  ];
  const accessEnvironments = accessMachineIds.map((id) =>
    environments.find((environment) => environment.environmentId === id),
  );
  const accessMachines = accessEnvironments.map((environment) => environment?.serverConfig);
  const startingMode =
    accessMachines
      .map((config) => config?.settings.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE)
      .find((mode) => mode !== "full-access") ?? "full-access";
  // Answered on this run: the row keeps its place, and Change can take the answer back.
  const [accessAnswer, setAccessAnswer] = useState<{
    readonly accepted: AcceptedFullAccess | null;
  } | null>(null);
  // Each machine is decided once its own settings and rules have loaded; a
  // guess made before that could show the row and then take it away.
  const recommendedNow = accessMachineIds.filter((_id, index) => {
    const config = accessMachines[index];
    return shouldRecommendFullAccess({
      answer: fullAccess.answer,
      settingsKnown: fullAccess.hydrated && config != null,
      machineRole: fullAccess.machineRole,
      mode: config?.settings.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE,
      projectSetsMode: false,
      fullAccessAllowed: teamRulesModeAllowed(
        teamRulesFromSummary(config?.teamRules).state,
        "full-access",
      ),
      fullAccessOffered: true,
      chatStarted: false,
    });
  });
  // Once recommended on this run, a machine keeps its place in the row, even
  // after an answer turns the recommendation off.
  const [recommendedIds, setRecommendedIds] = useState<ReadonlySet<EnvironmentId>>(new Set());
  if (recommendedNow.some((id) => !recommendedIds.has(id))) {
    setRecommendedIds(new Set([...recommendedIds, ...recommendedNow]));
  }
  // Before the machines are picked, this one is set up by default, so the bar
  // does not grow a stage once the person goes on.
  const desktopApp = typeof window !== "undefined" && window.desktopBridge !== undefined;
  const ownSetUp =
    primaryEnvironmentId !== null &&
    (setupIds.length === 0 || setupIds.includes(primaryEnvironmentId));
  // `useComputerUsePermissionsAreLocal` for this window's own machine: the desktop app can read them.
  const computerUseLocal =
    typeof window !== "undefined" && window.desktopBridge?.getComputerUsePermissions != null;
  // 1386's rule for its first-run item (`useCanOpenSettingsFor`): the desktop app on this Mac.
  const fullDiskAccessLocal =
    typeof window !== "undefined" &&
    isMacPlatform(window.navigator.platform) &&
    window.desktopBridge?.openSystemSettings !== undefined;
  const rows = accessRows({
    desktopApp,
    machines: accessMachineIds.map((id, index) => {
      const own = ownSetUp && id === primaryEnvironmentId;
      return {
        id,
        own,
        platform: accessEnvironments[index]?.serverConfig?.environment?.platform?.os ?? null,
        recommended: recommendedIds.has(id) || recommendedNow.includes(id),
        computerUseLocal: own && computerUseLocal,
        fullDiskAccessLocal: own && fullDiskAccessLocal,
      };
    }),
  });
  const filesMachineIds = rows.find((row) => row.id === "files")?.machineIds ?? [];
  // Once in the bar, the stage stays for the rest of this run, whatever loads later.
  const [accessStageShown, setAccessStageShown] = useState(false);
  if (rows.length > 0 && !accessStageShown) setAccessStageShown(true);
  const showAccess = accessStageShown || rows.length > 0 || step === "access";
  // The whole bar, in order. A stage that does not apply sets `when: false` and
  // drops out of the bar, of Back and of Continue.
  const stages: readonly WizardStage<WizardStageId>[] = [
    {
      id: "connect",
      label: entryStep === "start" ? tx("Sign in") : t("wizard.stage.connect"),
    },
    { id: "agents", label: t("wizard.stage.agents") },
    { id: "access", label: t("wizard.stage.access"), when: showAccess },
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
        : stage === "access"
          ? "access"
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
      stepId={step}
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
      ) : step === "access" ? (
        <AccessStep
          title={
            desktopApp && ownSetUp
              ? tx("What agents can use on this {machine}", { machine: machineNoun })
              : tx("What agents can use")
          }
          rows={rows}
          files={{
            machineNames: filesMachineIds.map(
              (id) =>
                environments.find((environment) => environment.environmentId === id)?.label ?? id,
            ),
            keepsSupervised:
              (accessAnswer?.accepted != null
                ? [...accessAnswer.accepted.values()][0]
                : startingMode) === "approval-required",
            answer:
              accessAnswer === null
                ? null
                : accessAnswer.accepted !== null
                  ? "accepted"
                  : "declined",
            onAccept: async () => {
              const accepted = await fullAccess.accept(filesMachineIds);
              if (accepted === null) return t("wizard.access.saveFailed");
              // Accepting again after an earlier accept on this run keeps the first access to undo.
              setAccessAnswer((current) => ({ accepted: current?.accepted ?? accepted }));
              return null;
            },
            onKeep: async () => {
              // After an accept on this run, Keep puts the earlier access back.
              const accepted = accessAnswer?.accepted;
              if (accepted != null) {
                if (!(await fullAccess.undo(accepted))) return t("wizard.access.undoFailed");
              } else {
                await fullAccess.decline();
              }
              setAccessAnswer({ accepted: null });
              return null;
            },
          }}
          onBack={() => goToStage(stageBefore(stages, "access"))}
          onContinue={() => goToStage(stageAfter(stages, "access"))}
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

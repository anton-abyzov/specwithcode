import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAdministrativeScopes,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthSessionState,
} from "@specweave-studio/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import {
  CONNECT_ACCOUNT_AUTH,
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  CONNECT_TURNED_OFF_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  ConnectTurnedOffSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
  EMPTY_CONNECT_TURNED_OFF_STATE,
  connectAtSignIn,
  connectTurnedOffReadable,
  replaceUnreadableConnectChoices,
  withConnectChoice,
} from "~/cloud/connectOnboarding";
import { signInDialogFollowsUp, takeConnectSignInStarted } from "~/cloud/connectSignInStarted";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useConnectOnAtSignIn } from "~/cloud/useConnectOnAtSignIn";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { environmentSession, readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { teamRulesReachLock } from "~/teamRules/teamRulesView";
import { useTeamRules } from "~/teamRules/useTeamRules";
import { PHONE_CONNECT_PENDING_KEY } from "../settings/PhoneConnect.logic";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog } from "../ui/dialog";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WizardSteps, WizardPopup, WizardHeader, WizardPanel, WizardFooter } from "../ui/wizard";

/**
 * Post-sign-in onboarding wizard for Studio Connect. Opens on every in-session
 * sign-in — sign-out removes the connected relay environments, so each new
 * session starts with no devices to reach. The same sign-in turns Studio
 * Connect on for this machine by itself (see `connectAtSignIn`), so the first
 * step shows what is on and lets the owner turn it off, when the current
 * session is authorized to manage the relay link. It then lists the account's
 * Studio Connect environments so every device can be connected right away. A
 * cold load with a restored session does not count as a sign-in; a load that
 * completes a sign-in started in this window does. A sign-in started in the
 * first-run setup is left to setup, which links this machine in its own step.
 */
export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

type OnboardingStep = "publish" | "devices";

/** Said in the wizard and its toast once a sign-in turned Connect on by itself. */
const TURNED_ON_NOTICE =
  "This machine is now reachable from your other devices on this account. Turn it off here or any time in Settings > Machines > SpecWithCode Connect.";

function phoneCardPending(): boolean {
  try {
    return window.sessionStorage.getItem(PHONE_CONNECT_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

function ConfiguredConnectOnboardingDialog() {
  // Mirrors ManagedRelayAuthProvider: a pending Clerk session must not read as
  // signed-out, or its later activation would look like a fresh sign-in.
  const { isLoaded, isSignedIn, userId } = useAuth(CONNECT_ACCOUNT_AUTH);
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const [turnedOffState, setTurnedOffState] = useLocalStorage(
    CONNECT_TURNED_OFF_STORAGE_KEY,
    EMPTY_CONNECT_TURNED_OFF_STATE,
    ConnectTurnedOffSchema,
  );

  const { isReady: environmentsReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const { summary: teamRules } = useTeamRules(primaryEnvironmentId);
  const primarySessionState = useAtomValue(
    primaryEnvironmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(primaryEnvironmentId),
  );
  const canReadRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope);
  const canWriteRelay = useEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope);
  const canManageRelay = canReadRelay && canWriteRelay;
  // The publish step is only offered when we know the answer; opening the
  // wizard before the session state resolves would let the step set change
  // mid-flight. A failed session read still opens the wizard — it just means
  // no publish step.
  const sessionScopesKnown =
    primaryEnvironmentId === null ? environmentsReady : primarySessionState._tag !== "Initial";

  const controller = useCloudLinkController();
  const showPublishStep = canManageRelay && controller.linkState.target !== null;
  const steps: ReadonlyArray<OnboardingStep> = showPublishStep
    ? ["publish", "devices"]
    : ["devices"];

  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  const [step, setStep] = useState<OnboardingStep>("devices");
  const [exposeEnvironment, setExposeEnvironment] = useState(true);
  const [publishAgentActivity, setPublishAgentActivity] = useState(true);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  // The account whose sign-in turned Connect on here, so the wizard says so.
  const [turnedOnForAccount, setTurnedOnForAccount] = useState<string | null>(null);
  const prefilledFromLinkStateRef = useRef(false);
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (step === "publish" && sessionScopesKnown && !showPublishStep && !isApplying) {
      setStep("devices");
    }
  }, [isApplying, sessionScopesKnown, showPublishStep, step]);

  const optOutAccounts = optOutState.optOutAccounts;
  const turnedOffAccounts = turnedOffState.accounts;

  // A manageable session implies a primary environment, so when the scopes
  // allow publishing, wait for the connection target too — otherwise the
  // wizard could open on the devices step moments before the publish step
  // becomes available and freeze there.
  const publishStepDecided = !canManageRelay || controller.linkState.target !== null;

  // The sign-in itself turns Connect on, so a new machine is reachable from the
  // owner's other machines without a second step. The wizard then shows it.
  const autoConnect = useConnectOnAtSignIn({
    decide: (account) =>
      connectAtSignIn({
        account,
        desktopApp: window.desktopBridge !== undefined,
        sessionKnown: sessionScopesKnown && publishStepDecided,
        canManageLink: canManageRelay && controller.linkState.target !== null,
        rulesKnown: primaryEnvironment?.serverConfig != null,
        rulesLockConnect: teamRulesReachLock(teamRules, "connect") !== null,
        linkState: controller.linkState.data,
        linkStatePending: controller.linkState.isPending,
        linkStateFailed: controller.linkState.error !== null,
        turnedOffAccounts,
        turnedOffUnreadable: !connectTurnedOffReadable(),
        wizardOptOutAccounts: optOutAccounts,
        phoneCardPending: phoneCardPending(),
      }),
    busy: isApplying,
    turnOn: () => controller.reconcileCloudState({ managedTunnel: true, publish: true }),
    onTurnedOn: (account) => {
      setTurnedOnForAccount(account);
      setExposeEnvironment(true);
      setPublishAgentActivity(true);
      toastManager.add({
        type: "success",
        title: "SpecWithCode Connect is on",
        description: TURNED_ON_NOTICE,
      });
    },
  });
  const applying = isApplying || autoConnect.applying;

  // Every sign-in or account switch that completes during this session
  // requests the wizard — account transitions clear the connected relay
  // environments, so each new session starts with no devices to reach. A cold
  // load observes undefined → account and must not re-prompt, unless a sign-in
  // was started in this window just before it.
  useEffect(() => {
    if (!isLoaded) return;
    // A loaded-but-incomplete snapshot (signed in, user id not yet populated)
    // must not be recorded as signed-out — the next render would then look
    // like a fresh sign-in on a cold load.
    if (isSignedIn && !userId) return;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    if (previousAccount === nextAccount) return;
    if (nextAccount === null) {
      if (previousAccount !== undefined) {
        autoConnect.cancel();
        setTurnedOnForAccount(null);
      }
      return;
    }
    // Signing in through another site reloads the window, so that sign-in is
    // first seen at load. The note left when it was started tells it from a
    // restored session, and says when setup shows the link itself.
    if (
      signInDialogFollowsUp({
        sawSignedOut: previousAccount !== undefined,
        started: takeConnectSignInStarted(),
      })
    ) {
      setRequestedAccount(nextAccount);
      autoConnect.request(nextAccount);
    }
  }, [isLoaded, isSignedIn, userId]);

  // Open once the session scopes resolve so the step set is stable. Accounts
  // that chose "Don't show this again" are skipped.
  useEffect(() => {
    if (requestedAccount === null || openForAccount !== null) return;
    if (optOutAccounts.includes(requestedAccount)) {
      setRequestedAccount(null);
      return;
    }
    if (!sessionScopesKnown || !publishStepDecided) return;
    setRequestedAccount(null);
    prefilledFromLinkStateRef.current = false;
    // An owner who turned Connect off here is not asked to turn it back on. Saved
    // choices that cannot be read may hold exactly that, so they propose nothing.
    setExposeEnvironment(
      connectTurnedOffReadable() && !turnedOffAccounts.includes(requestedAccount),
    );
    setPublishAgentActivity(true);
    setDontShowAgain(false);
    setStep(canManageRelay && controller.linkState.target !== null ? "publish" : "devices");
    setOpenForAccount(requestedAccount);
  }, [
    canManageRelay,
    controller.linkState.target,
    openForAccount,
    optOutAccounts,
    publishStepDecided,
    requestedAccount,
    sessionScopesKnown,
    turnedOffAccounts,
  ]);

  // Signing out (or switching accounts) mid-wizard invalidates everything the
  // wizard would do — close it and let the sign-in trigger re-evaluate.
  useEffect(() => {
    if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
      setOpenForAccount(null);
    }
    if (requestedAccount !== null && (!isSignedIn || userId !== requestedAccount)) {
      setRequestedAccount(null);
    }
  }, [isSignedIn, openForAccount, requestedAccount, userId]);

  // Toggles default on, but an environment that is already linked should show
  // its actual configuration instead of silently proposing to rewrite it.
  // Only when the link belongs to the account being onboarded, though — after
  // an account switch the cached link state can still describe the previous
  // account's setup.
  const linkStateData = controller.linkState.data;
  useEffect(() => {
    if (openForAccount === null || prefilledFromLinkStateRef.current || linkStateData === null) {
      return;
    }
    prefilledFromLinkStateRef.current = true;
    if (linkStateData.linked && linkStateData.cloudUserId === openForAccount) {
      setExposeEnvironment(linkStateData.managedTunnelActive ?? linkStateData.linked);
      setPublishAgentActivity(linkStateData.publishAgentActivity);
    }
  }, [linkStateData, openForAccount]);

  const complete = () => {
    // Keep the wizard up while a link request is in flight so its outcome
    // (and any failure) stays visible.
    if (applying) return;
    const account = openForAccount;
    setOpenForAccount(null);
    if (account !== null && dontShowAgain) {
      setOptOutState((state) =>
        state.optOutAccounts.includes(account)
          ? state
          : { optOutAccounts: [...state.optOutAccounts, account] },
      );
    }
  };

  const applyPublishSelection = async () => {
    if (applying) return;
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    ) {
      setStep("devices");
      return;
    }
    if (linkStateData === null || controller.linkState.error !== null) return;
    const account = openForAccount;
    // Unticking Publish this environment is the owner's choice: the next
    // sign-in must not turn it back on. Ticking it forgets that choice.
    const rememberChoice = () => {
      if (account !== null) {
        // The owner's own choice also replaces saved choices that cannot be read.
        replaceUnreadableConnectChoices(account, exposeEnvironment);
        setTurnedOffState((state) => withConnectChoice(state, account, exposeEnvironment));
      }
    };
    // With both toggles off there is nothing to enable, and a link from before
    // this sign-in must not be torn down from onboarding. One this sign-in
    // made by itself is the owner's to undo right here.
    if (!exposeEnvironment && !publishAgentActivity && turnedOnForAccount !== account) {
      // A link left running is not an off choice; Settings still shows it on.
      if (!linkStateData.linked) rememberChoice();
      setStep("devices");
      return;
    }
    setIsApplying(true);
    const ok = await controller.reconcileCloudState({
      managedTunnel: exposeEnvironment,
      publish: publishAgentActivity,
    });
    setIsApplying(false);
    if (!ok) return;
    rememberChoice();
    if (!exposeEnvironment) setTurnedOnForAccount(null);
    toastManager.add(
      exposeEnvironment || publishAgentActivity
        ? {
            type: "success",
            title: "SpecWithCode Connect enabled",
            description: exposeEnvironment
              ? "This environment is available to your other devices through SpecWithCode Connect."
              : "This environment publishes agent activity to your mobile clients.",
          }
        : {
            type: "success",
            title: "SpecWithCode Connect turned off",
            description:
              "This machine is no longer reachable through SpecWithCode Connect. Turn it on in Settings > Machines > SpecWithCode Connect.",
          },
    );
    setStep("devices");
  };

  return (
    <Dialog
      open={openForAccount !== null}
      onOpenChange={(open) => {
        // Keep the dialog up while a link request is in flight so its outcome
        // (and any failure) stays visible.
        if (!open && !applying) complete();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Set up SpecWithCode Connect"
          description={
            <>
              Mesh your devices together — publish this environment and connect the rest, all in one
              place.
            </>
          }
        >
          {steps.length > 1 ? (
            <WizardSteps
              steps={steps.map((id) => STEP_LABELS[id])}
              currentStep={steps.indexOf(step)}
              isStepDisabled={() => applying}
              onStepChange={(index) => {
                const next = steps[index];
                if (
                  next === "publish" &&
                  (primaryEnvironmentId === null ||
                    !readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) ||
                    !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope))
                )
                  return;
                if (next) setStep(next);
              }}
            />
          ) : null}
        </WizardHeader>
        <WizardPanel>
          {step === "publish" ? (
            <PublishStep
              exposeEnvironment={exposeEnvironment}
              publishAgentActivity={publishAgentActivity}
              disabled={applying || !canManageRelay || linkStateData === null}
              notice={
                turnedOnForAccount !== null && turnedOnForAccount === openForAccount
                  ? TURNED_ON_NOTICE
                  : null
              }
              operationError={controller.operationError ?? controller.linkState.error}
              onExposeEnvironmentChange={(enabled) => {
                if (
                  primaryEnvironmentId !== null &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
                )
                  setExposeEnvironment(enabled);
              }}
              onPublishAgentActivityChange={(enabled) => {
                if (
                  primaryEnvironmentId !== null &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayReadScope) &&
                  readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
                )
                  setPublishAgentActivity(enabled);
              }}
            />
          ) : (
            <DevicesStep />
          )}
        </WizardPanel>
        <WizardFooter
          leading={
            <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground sm:self-center">
              <Checkbox
                checked={dontShowAgain}
                onCheckedChange={(checked) => setDontShowAgain(checked === true)}
              />
              Don&apos;t show this again
            </label>
          }
        >
          {step === "publish" ? (
            <>
              {turnedOnForAccount !== null && turnedOnForAccount === openForAccount ? null : (
                <Button
                  variant="ghost"
                  disabled={applying}
                  onClick={() => {
                    // Not now also holds back a turn-on that has not started yet.
                    autoConnect.cancel();
                    setStep("devices");
                  }}
                >
                  Not now
                </Button>
              )}
              <Button
                disabled={applying || !canManageRelay || linkStateData === null}
                onClick={() => void applyPublishSelection()}
              >
                {applying ? "Applying…" : "Continue"}
              </Button>
            </>
          ) : (
            <Button disabled={applying} onClick={complete}>
              Done
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

const STEP_LABELS: Record<OnboardingStep, string> = {
  publish: "Publish",
  devices: "Connect devices",
};

function PublishStep({
  exposeEnvironment,
  publishAgentActivity,
  disabled,
  notice,
  operationError,
  onExposeEnvironmentChange,
  onPublishAgentActivityChange,
}: {
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
  readonly disabled: boolean;
  /** Says what the sign-in already turned on and where to turn it off. */
  readonly notice: string | null;
  readonly operationError: string | null;
  readonly onExposeEnvironmentChange: (enabled: boolean) => void;
  readonly onPublishAgentActivityChange: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <div className="rounded-lg border">
        <OnboardingToggleRow
          title="Publish this environment"
          description="Make this environment available to your other devices through SpecWithCode Connect."
          checked={exposeEnvironment}
          disabled={disabled}
          onCheckedChange={onExposeEnvironmentChange}
        />
        <OnboardingToggleRow
          title="Publish agent activity"
          description="Send activity from this environment to your mobile clients for push notifications and Live Activities."
          checked={publishAgentActivity}
          disabled={disabled}
          onCheckedChange={onPublishAgentActivityChange}
        />
      </div>
      {operationError ? (
        <p className="text-xs text-destructive-foreground">{operationError}</p>
      ) : null}
    </div>
  );
}

function OnboardingToggleRow({
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/60 px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function DevicesStep() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
        empty={
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No other environments are published to your account yet. Publish one from another device
            and it will show up here.
          </p>
        }
      />
    </div>
  );
}

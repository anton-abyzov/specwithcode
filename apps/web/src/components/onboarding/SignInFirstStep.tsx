import { useAuth, useUser } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import type { AsyncResult } from "effect/reactivity";
import { CheckIcon } from "lucide-react";
import type { RelayClientInstallProgressStage } from "@specweave-studio/contracts";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  CONNECT_ACCOUNT_AUTH,
  CONNECT_TURNED_OFF_STORAGE_KEY,
  ConnectTurnedOffSchema,
  EMPTY_CONNECT_TURNED_OFF_STATE,
  connectTurnedOffReadable,
  replaceUnreadableConnectChoices,
  withConnectChoice,
} from "../../cloud/connectOnboarding";
import { forgetConnectSignInStarted } from "../../cloud/connectSignInStarted";
import {
  readRelayClientInstallDialogState,
  subscribeRelayClientInstallDialog,
} from "../../cloud/relayClientInstallDialog";
import { useCloudLinkController } from "../../cloud/useCloudLinkController";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useTx } from "../../i18n";
import { cn } from "../../lib/utils";
import { useEnvironments, useRelayEnvironmentDiscovery } from "../../state/environments";
import { environmentSession, useEnvironmentScope } from "../../state/session";
import { useMachineWorkGrants } from "../../studio/fleet";
import { teamRulesReachLock } from "../../teamRules/teamRulesView";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { AccountJoinCard } from "../settings/AccountJoinCard";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { WizardStepFooter } from "./WizardFrame";
import {
  canTurnOnFromSignInFirst,
  machinesStillToAllow,
  signInFirstLink,
  type SignInFirstLink,
} from "./signInFirst.logic";

const SIGN_IN_TIMEOUT_MS = 10_000;
/** A link that runs this long says so, and that going on is fine. */
const LINK_SLOW_MS = 20_000;

type RowState = "next" | "busy" | "done" | "later" | "problem";

/**
 * The first step of setup in the desktop app: sign in, and the rest follows on
 * this one screen. The sign-in links this machine to the SpecWithCode Connect
 * account by itself; the account's other machines are then listed, and one
 * Allow lets the chosen one start work here. Nothing is copied between
 * machines and nothing is set in Settings. Each row shows where it stands as
 * it happens, and the step holds one main button at a time: the next action.
 * Setup also works without an account, by the small link under the rows. Once
 * linked, one line says how the phone joins the same account.
 */
export function SignInFirstStep({
  environmentId,
  machineNoun,
  rulesKnown,
  onContinue,
  onOtherComputers,
}: {
  /** This machine. */
  readonly environmentId: EnvironmentId;
  /** "Mac" on macOS, otherwise "machine". */
  readonly machineNoun: string;
  /** This machine's Team rules have been read. */
  readonly rulesKnown: boolean;
  /** On to the agents on this machine. */
  readonly onContinue: () => void;
  /** The step that pairs other computers by link and sets them up too. */
  readonly onOtherComputers: () => void;
}) {
  const tx = useTx();
  const machine = machineNoun;
  // A pending session already has its account: it must not read as signed out.
  const { isLoaded, isSignedIn, userId } = useAuth(CONNECT_ACCOUNT_AUTH);
  const { user } = useUser();
  const { openSetupAuthPrompt } = useStudioConnectAuthPrompt();
  const account = isLoaded && isSignedIn && userId ? userId : null;
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const signInStalled = useHeldFor(!isLoaded, SIGN_IN_TIMEOUT_MS);

  const controller = useCloudLinkController();
  const sessionState = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthRelayReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthRelayWriteScope);
  const { summary: teamRules } = useTeamRules(environmentId);
  const [turnedOff, setTurnedOff] = useLocalStorage(
    CONNECT_TURNED_OFF_STORAGE_KEY,
    EMPTY_CONNECT_TURNED_OFF_STATE,
    ConnectTurnedOffSchema,
  );
  const [applying, setApplying] = useState(false);
  // The account whose last link request failed: shown once, never repeated by itself.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const running = useRef(false);
  // One request by itself per account: a link that does not show up after it is not asked for in a loop.
  const [triedFor, setTriedFor] = useState<string | null>(null);

  const { link, turnOnNow } = signInFirstLink({
    account,
    sessionKnown: isSessionKnown(sessionState),
    canManageLink: canRead && canWrite && controller.linkState.target !== null,
    rulesKnown,
    rulesLockConnect: teamRulesReachLock(teamRules, "connect") !== null,
    linkState: controller.linkState.data,
    linkStatePending: controller.linkState.isPending,
    linkStateFailed: controller.linkState.error !== null,
    turnedOffAccounts: turnedOff.accounts,
    turnedOffUnreadable: !connectTurnedOffReadable(),
    applying,
    failure:
      account !== null && failedFor === account ? { message: controller.operationError } : null,
    triedByItself: account !== null && triedFor === account,
  });

  async function turnOn(byOwner: boolean) {
    if (running.current || account === null) return;
    running.current = true;
    setApplying(true);
    setFailedFor(null);
    if (!byOwner) setTriedFor(account);
    const linkedBefore = controller.linkState.data?.linked === true;
    const ok = await controller
      .reconcileCloudState({
        managedTunnel: true,
        // A link the owner shaped keeps its activity choice; a new one publishes, as any sign-in does.
        publish: linkedBefore ? controller.publishAgentActivity : true,
        // Signing in on this step asked for the link, and row 2 shows the helper's
        // install as it runs. Setup shows no dialog that could ask.
        relayClientInstall: "agreed",
      })
      .catch(() => false);
    running.current = false;
    setApplying(false);
    if (!ok) {
      setFailedFor(account);
      return;
    }
    if (byOwner) {
      // The owner's own choice: the next sign-in may turn Connect on again.
      replaceUnreadableConnectChoices(account, true);
      setTurnedOff((state) => withConnectChoice(state, account, true));
    }
  }
  useEffect(() => {
    if (turnOnNow) void turnOn(false);
  }, [turnOnNow, account]);
  // A sign-in that was opened here and given up must not be read as this step's later.
  useEffect(() => () => forgetConnectSignInStarted("setup"), []);

  const { snapshot: grants } = useMachineWorkGrants(environmentId);
  const { environments } = useEnvironments();
  const discovery = useRelayEnvironmentDiscovery();
  const allowed = (grants?.grants ?? []).filter((grant) => grant.status === "active");
  // Who may run work here could not be read (yet): the card then draws no choice, so the step holds the way on.
  const toAllow = !grants
    ? 0
    : machinesStillToAllow({
        here: environmentId,
        known: [
          ...environments.map((environment) => environment.environmentId),
          ...[...discovery.environments.values()].map((entry) => entry.environment.environmentId),
        ],
        allowed: grants.grants.map((grant) => grant.coordinatorEnvironmentId),
      });
  const linked = link.kind === "linked";
  // The card just allowed a machine and shows that; it holds no way on, so the step does.
  const [justAllowed, setJustAllowed] = useState(false);
  // The choice and its Allow are the next action; their Skip moves on.
  const choosing = linked && toAllow > 0 && !justAllowed;

  const signInRow: { state: RowState; title: string; detail: string | null } =
    account !== null
      ? {
          state: "done",
          title: email ? tx("Signed in as {account}", { account: email }) : tx("Signed in"),
          detail: null,
        }
      : !isLoaded
        ? {
            state: signInStalled ? "problem" : "busy",
            title: signInStalled ? tx("Sign-in did not load") : tx("Loading sign-in…"),
            detail: signInStalled
              ? tx("Connect sign-in did not load, so check this computer's network.")
              : null,
          }
        : {
            state: "next",
            title: tx("Sign in"),
            detail: tx("One account for all your machines and your phone."),
          };
  const install = useSyncExternalStore(
    subscribeRelayClientInstallDialog,
    readRelayClientInstallDialogState,
    readRelayClientInstallDialogState,
  );
  const linkSlow = useHeldFor(link.kind === "linking", LINK_SLOW_MS);
  const linkRow = linkRowText(link, machine, tx, {
    helperStage: install.status === "installing" ? install.stage : null,
    slow: linkSlow,
  });
  const machinesRow: { state: RowState; title: string; detail: string | null } = !linked
    ? {
        state: "later",
        title: tx("Choose your main machine"),
        detail: tx("Your other machines are listed here once this {machine} is linked.", {
          machine,
        }),
      }
    : allowed.length === 1
      ? {
          state: "done",
          title: tx("{label} can start work on this {machine}", {
            label: allowed[0]!.machineLabel,
            machine,
          }),
          detail: null,
        }
      : allowed.length > 1
        ? {
            state: "done",
            title: tx("{count} of your machines can start work on this {machine}", {
              count: allowed.length,
              machine,
            }),
            detail: null,
          }
        : {
            state: "next",
            title: tx("Choose your main machine"),
            detail:
              toAllow > 0
                ? tx("Pick it below and press Allow. Nothing to copy or paste.")
                : tx("If this is your first machine, there is nothing to choose: continue."),
          };

  const mainActionPending =
    account === null || canTurnOnFromSignInFirst(link) || link.kind === "linking";

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {tx("Sign in to SpecWithCode Connect")}
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        {tx(
          "Sign in once. This {machine} then links to your account and lists your other machines by itself.",
          { machine },
        )}
      </p>
      <ol className="mt-5 space-y-2" aria-live="polite" data-testid="sign-in-first-rows">
        <StepRow index={1} {...signInRow} part="sign-in">
          {account === null && isLoaded ? (
            <Button size="sm" onClick={openSetupAuthPrompt}>
              {tx("Sign in")}
            </Button>
          ) : signInStalled ? (
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              {tx("Retry")}
            </Button>
          ) : null}
        </StepRow>
        <StepRow index={2} {...linkRow} part="link">
          {canTurnOnFromSignInFirst(link) ? (
            <Button size="sm" onClick={() => void turnOn(true)}>
              {link.kind === "failed" ? tx("Try again") : tx("Turn on SpecWithCode Connect")}
            </Button>
          ) : null}
        </StepRow>
        <StepRow index={3} {...machinesRow} part="machines" />
      </ol>
      {account === null ? (
        // Small and beside the main path: Enter never presses it.
        <Button
          variant="link"
          size="sm"
          className="mt-3 px-0 font-normal text-muted-foreground underline"
          data-testid="sign-in-first-no-account"
          onClick={onContinue}
        >
          {tx("Use without an account")}
        </Button>
      ) : null}
      {linked ? (
        <div className="mt-3" data-testid="sign-in-first-machines">
          <AccountJoinCard
            environmentId={environmentId}
            variant="first-run"
            onDone={() => setJustAllowed(true)}
            onSkip={onContinue}
          />
        </div>
      ) : null}
      {linked && email ? (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="sign-in-first-phone">
          {tx(
            "Your phone: get SpecWithCode at specwithcode.com/get and sign in as {account}. This {machine} shows up there by itself.",
            { account: email, machine },
          )}
        </p>
      ) : null}
      {/* One main button at a time: Sign in, Turn on or Try again in their rows, Allow in the
          card, then Continue here. Until then going on is a skip, which Enter never presses. */}
      <WizardStepFooter
        leading={
          <Button variant="ghost" size="sm" onClick={onOtherComputers}>
            {tx("Set up other computers too")}
          </Button>
        }
        skip={
          !choosing && mainActionPending && account !== null
            ? { label: tx("Continue"), onClick: onContinue }
            : undefined
        }
        primary={
          !choosing && !mainActionPending
            ? { label: tx("Continue"), onClick: onContinue }
            : undefined
        }
      />
    </>
  );
}

/** What row 2 says while the Connect helper this machine needs is being installed. */
function helperStageText(
  stage: RelayClientInstallProgressStage,
  tx: ReturnType<typeof useTx>,
): string {
  switch (stage) {
    case "checking":
      return tx("Getting the Connect helper: checking what is installed (step 1 of 7)");
    case "waiting_for_lock":
      return tx("Getting the Connect helper: waiting for another install to finish (step 2 of 7)");
    case "downloading":
      return tx("Getting the Connect helper: downloading (step 3 of 7)");
    case "verifying":
      return tx("Getting the Connect helper: checking the download (step 4 of 7)");
    case "installing":
      return tx("Getting the Connect helper: installing (step 5 of 7)");
    case "validating":
      return tx("Getting the Connect helper: testing it (step 6 of 7)");
    case "activating":
      return tx("Getting the Connect helper: turning it on (step 7 of 7)");
  }
}

function linkRowText(
  link: SignInFirstLink,
  machine: string,
  tx: ReturnType<typeof useTx>,
  progress: {
    /** The install step of the Connect helper, while one runs. */
    readonly helperStage: RelayClientInstallProgressStage | null;
    /** The link has been running long enough to say so. */
    readonly slow: boolean;
  },
): { state: RowState; title: string; detail: string | null } {
  switch (link.kind) {
    case "waiting":
      return {
        state: "later",
        title: tx("Link this {machine}", { machine }),
        detail: tx("Happens by itself after you sign in."),
      };
    case "checking":
      return { state: "busy", title: tx("Checking this {machine}…", { machine }), detail: null };
    case "linking":
      return {
        state: "busy",
        title: tx("Linking this {machine}…", { machine }),
        detail: progress.helperStage
          ? helperStageText(progress.helperStage, tx)
          : progress.slow
            ? tx(
                "Still linking. This can take a minute on a new {machine}. You can continue: it finishes by itself.",
                { machine },
              )
            : null,
      };
    case "linked":
      return {
        state: "done",
        title: tx("This {machine} is linked", { machine }),
        detail: tx("Your other machines and your phone can reach it."),
      };
    case "failed":
      return {
        state: "problem",
        title: tx("This {machine} could not be linked", { machine }),
        detail:
          link.message ??
          tx(
            "SpecWithCode Connect could not be read on this {machine}. Check its internet connection.",
            {
              machine,
            },
          ),
      };
    case "off":
      return {
        state: "next",
        title: tx("SpecWithCode Connect is off on this {machine}", { machine }),
        detail: tx("Turn it on and your other machines can reach this one."),
      };
    case "locked":
      return {
        state: "problem",
        title: tx("SpecWithCode Connect is off on this {machine}", { machine }),
        detail: tx("Team rules keep it off here, so your other machines cannot reach this one."),
      };
    case "no-permission":
      return {
        state: "problem",
        title: tx("SpecWithCode Connect is off on this {machine}", { machine }),
        detail: tx("This window is not allowed to turn it on."),
      };
  }
}

function StepRow({
  index,
  state,
  title,
  detail,
  part,
  children,
}: {
  index: number;
  state: RowState;
  title: string;
  detail: string | null;
  part: string;
  children?: ReactNode;
}) {
  const tx = useTx();
  return (
    <li
      data-part={part}
      data-state={state}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-background px-3 py-2.5",
        state === "next" ? "border-primary/40" : "border-border",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
          state === "done"
            ? "bg-success/10 text-success-foreground"
            : state === "problem"
              ? "bg-warning/10 text-warning-foreground"
              : state === "next"
                ? "bg-primary/10 text-foreground"
                : "bg-muted text-muted-foreground",
        )}
      >
        {state === "done" ? (
          <CheckIcon className="size-3.5" />
        ) : state === "busy" ? (
          <Spinner size="xs" />
        ) : (
          index
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm font-medium break-words",
            state === "later" && "text-muted-foreground",
          )}
        >
          {state === "done" ? <span className="sr-only">{tx("Done:")} </span> : null}
          {title}
        </span>
        {detail ? (
          <span className="mt-0.5 block text-xs break-words text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {children ? <span className="shrink-0">{children}</span> : null}
    </li>
  );
}

function isSessionKnown(state: AsyncResult.AsyncResult<AuthSessionState, unknown>): boolean {
  return state._tag !== "Initial";
}

/** True once `active` has held for `delayMs`, and false again when it stops. */
function useHeldFor(active: boolean, delayMs: number) {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, delayMs]);
  return active && elapsed;
}

import { useAuth, useUser } from "@clerk/react";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import { isAtomCommandInterrupted } from "@specweave-studio/client-runtime/state/runtime";
import type { EnvironmentId } from "@specweave-studio/contracts";
import type {
  StudioFleetWorkerAccess,
  StudioWorkGrantsSnapshot,
} from "@specweave-studio/contracts/studioFleet";
import * as Option from "effect/Option";
import { CheckIcon, LaptopIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { environmentCatalog } from "../../connection/catalog";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useTx } from "../../i18n";
import { cn } from "../../lib/utils";
import { useEnvironments, useRelayEnvironmentDiscovery } from "../../state/environments";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMachineWorkGrants } from "../../studio/fleet";
import {
  DEFAULT_FLEET_WORKER_ACCESS,
  FLEET_WORKER_ACCESS_CHOICES,
} from "../../studio/fleetWorkers";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { Button } from "../ui/button";
import {
  canChooseJoinCardMachine,
  EMPTY_JOIN_CARD_FOLDED_STATE,
  JOIN_CARD_FOLDED_STORAGE_KEY,
  joinCardConnect,
  JoinCardFoldedSchema,
  joinCardMachines,
  withJoinCardFolded,
  type JoinCardConnect,
  type JoinCardMachine,
} from "./AccountJoinCard.logic";
import {
  accountMachinesToOffer,
  IncomingWorkerSaved,
  useIncomingWorkerAllow,
} from "./IncomingWorkerSetup";

const NO_CONNECT: JoinCardConnect = { kind: "none" };

/** The machine an owner just allowed, as `onDone` reports it. */
export interface AccountJoinCardAllowed {
  environmentId: EnvironmentId;
  label: string;
  access: StudioFleetWorkerAccess;
}

export interface AccountJoinCardProps {
  /** This machine: the one that will run the work. */
  environmentId: EnvironmentId;
  /**
   * "settings" (the default) folds to one line with Not now and remembers it on
   * this device. "first-run" is a step of a guided setup: it never folds, and
   * its second button is Skip.
   */
  variant?: "settings" | "first-run" | undefined;
  /** A machine was allowed. The card shows its done state either way. */
  onDone?: ((allowed: AccountJoinCardAllowed) => void) | undefined;
  /** First run only: the owner chose Skip. */
  onSkip?: (() => void) | undefined;
  /** Takes the owner to the SpecWithCode Connect switch. Without it the notice has no button. */
  onShowConnectSwitch?: (() => void) | undefined;
}

type BodyProps = AccountJoinCardProps & { snapshot: StudioWorkGrantsSnapshot };

/**
 * "Let another of your machines run work here": the machines of this
 * SpecWithCode Connect account, one choice, one Allow. It reads who may run
 * work here by itself and needs no page around it, so Settings > Machines and
 * a first-run step both mount it as it is. A build without SpecWithCode
 * Connect still lists the machines this app saved.
 */
export function AccountJoinCard(props: AccountJoinCardProps) {
  const tx = useTx();
  const { snapshot, loading } = useMachineWorkGrants(props.environmentId);
  // Kept through a refresh, also one that fails: the list re-reads after every
  // Allow, and the done state must not vanish with a grant that exists.
  if (!snapshot)
    // A server from before scoped grants has no such list, so there is nothing to allow.
    return props.variant === "first-run" && loading ? (
      <JoinCardFrame>
        <p role="status" className="text-xs text-muted-foreground">
          {tx("Checking who can run work here…")}
        </p>
      </JoinCardFrame>
    ) : null;
  return hasCloudPublicConfig() ? (
    <AccountJoinCardWithConnect {...props} snapshot={snapshot} />
  ) : (
    <AccountJoinCardBody {...props} snapshot={snapshot} connect={NO_CONNECT} />
  );
}

function AccountJoinCardWithConnect(props: BodyProps) {
  // A pending sign-in must not read as signed out, or the card would ask to sign in again.
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const link = usePrimaryCloudLinkState();
  const { openAuthPrompt } = useStudioConnectAuthPrompt();
  return (
    <AccountJoinCardBody
      {...props}
      connect={joinCardConnect({
        loaded: isLoaded,
        signedIn: isSignedIn === true,
        account: user?.primaryEmailAddress?.emailAddress ?? null,
        link: link.data,
      })}
      onSignIn={openAuthPrompt}
    />
  );
}

export function AccountJoinCardBody({
  environmentId,
  snapshot,
  variant = "settings",
  onDone,
  onSkip,
  onShowConnectSwitch,
  connect,
  onSignIn,
}: BodyProps & {
  connect: JoinCardConnect;
  onSignIn?: (() => void) | undefined;
}) {
  const tx = useTx();
  const firstRun = variant === "first-run";
  const { refresh: refreshGrants } = useMachineWorkGrants(environmentId);
  const { environments } = useEnvironments();
  const discovery = useRelayEnvironmentDiscovery();
  const openEnvironment = useAtomCommand(environmentCatalog.register, { reportFailure: false });
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const name = useMachineNicknames();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const [opening, setOpening] = useState<EnvironmentId | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // Allow is running for the chosen machine: the choice must not change under it.
  const [allowing, setAllowing] = useState(false);
  // Kept across choices, so picking another machine does not reset the cap.
  const [access, setAccess] = useState<StudioFleetWorkerAccess>(DEFAULT_FLEET_WORKER_ACCESS);
  const [foldedState, setFoldedState] = useLocalStorage(
    JOIN_CARD_FOLDED_STORAGE_KEY,
    EMPTY_JOIN_CARD_FOLDED_STATE,
    JoinCardFoldedSchema,
  );
  // A first-run step is never folded: Skip leaves it, and the page that mounts it moves on.
  const folded = !firstRun && foldedState.environments.includes(environmentId);
  const setFolded = (next: boolean) =>
    setFoldedState((state) => withJoinCardFolded(state, environmentId, next));
  // The account's machines are read when the card shows, so a new machine lists them at once.
  useEffect(() => {
    void refreshDiscovery();
  }, [refreshDiscovery]);
  // Kept here, not in the action: a granted machine leaves the list once the
  // snapshot refreshes, which unmounts the action.
  const [saved, setSaved] = useState<{
    coordinator: EnvironmentId;
    coordinatorLabel: string;
    access: StudioFleetWorkerAccess;
    expiresAt: string | null;
    renewable: boolean;
  } | null>(null);
  const savedGrant = saved
    ? snapshot.grants.find((grant) => grant.coordinatorEnvironmentId === saved.coordinator)
    : undefined;
  const granted = (id: EnvironmentId) =>
    snapshot.grants.some((grant) => grant.coordinatorEnvironmentId === id);
  const candidates = environments.filter(
    (environment) =>
      environment.environmentId !== environmentId && !granted(environment.environmentId),
  );
  const discovered = [...discovery.environments.values()];
  // Machines of this SpecWithCode Connect account that this app has not opened yet.
  const accountOnly = accountMachinesToOffer({
    discovered: discovered.map((entry) => entry.environment),
    here: environmentId,
    known: [
      ...environments.map((environment) => environment.environmentId),
      ...snapshot.grants.map((grant) => grant.coordinatorEnvironmentId),
    ],
  });
  const machines = joinCardMachines({
    saved: candidates.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connected: environment.connection.phase === "connected",
      facts: environment.serverConfig?.environment ?? null,
    })),
    discovered: discovered.map((entry) => ({
      environmentId: entry.environment.environmentId,
      label: entry.environment.label,
      availability: entry.availability,
      facts: Option.getOrUndefined(entry.status)?.descriptor ?? null,
    })),
    accountOnly: accountOnly.map((record) => record.environmentId),
    name,
  });
  // Every other machine this app or the account knows already has a grant here:
  // then "no other machine yet" would be false.
  const others = new Set(
    [
      ...environments.map((environment) => environment.environmentId),
      ...discovered.map((entry) => entry.environment.environmentId),
    ].filter((id) => id !== environmentId),
  );
  const allAllowed = others.size > 0 && [...others].every(granted);
  const chosen = candidates.find((environment) => environment.environmentId === selected);
  const here = environments.find((environment) => environment.environmentId === environmentId);
  async function choose(machine: JoinCardMachine) {
    if (opening || allowing || !canChooseJoinCardMachine(machine)) return;
    setOpenError(null);
    setSelected(machine.environmentId);
    const record = accountOnly.find((item) => item.environmentId === machine.environmentId);
    if (!record) return;
    // Choosing an account machine opens it through SpecWithCode Connect; Allow follows.
    setOpening(record.environmentId);
    const result = await openEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
        }),
      }),
    );
    setOpening(null);
    if (result._tag === "Success") return;
    // Back to no choice: picking the same machine again must be a change.
    setSelected(null);
    if (!isAtomCommandInterrupted(result))
      setOpenError(
        tx(
          "Could not open {label} through SpecWithCode Connect. Check that it is online, then choose it again.",
          { label: record.label },
        ),
      );
  }
  const leave = () => (firstRun ? onSkip?.() : setFolded(true));
  const openingLabel = machines.find((item) => item.environmentId === opening)?.label;
  // Opening a machine saves it in this app; it is still one of the account's machines.
  const onAccount = machines.length > 0 && machines.every((item) => item.onAccount);

  if (saved)
    return (
      <JoinCardFrame>
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success-foreground">
            <CheckIcon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <IncomingWorkerSaved
              coordinatorLabel={saved.coordinatorLabel}
              access={saved.access}
              expiresAt={saved.expiresAt ?? savedGrant?.expiresAt ?? null}
              renewable={saved.renewable}
            />
            <p className="rounded-lg bg-success/10 px-3 py-2 text-xs">
              {tx(
                "On {coordinatorLabel}, agents can pick this machine now. Keep SpecWithCode open here; while this machine sleeps or the app is closed it shows there as not answering. To stop it, choose Revoke under Who can run work here in Settings > Machines.",
                { coordinatorLabel: saved.coordinatorLabel },
              )}
            </p>
            {machines.length ? (
              <Button size="xs" variant="outline" onClick={() => setSaved(null)}>
                {tx("Allow another machine")}
              </Button>
            ) : null}
          </div>
        </div>
      </JoinCardFrame>
    );

  if (folded)
    return (
      <section
        id="machines-join-card"
        className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5 sm:px-4"
      >
        <p className="min-w-0 text-sm">{tx("Let another of your machines run work here")}</p>
        <Button size="xs" variant="outline" onClick={() => setFolded(false)}>
          {tx("Show")}
        </Button>
      </section>
    );

  const account = connect.kind === "signed-in" ? connect.account : null;
  return (
    <JoinCardFrame accent>
      <h2 className="text-sm font-semibold">{tx("Let another of your machines run work here")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {onAccount && account
          ? tx(
              "These machines are signed in to {account}, like this machine. Pick the one whose agents may start work here. Nothing to copy or paste.",
              { account },
            )
          : connect.kind !== "signed-in"
            ? tx("Pick the machine whose agents may start work here.")
            : tx(
                "Pick the machine whose agents may start work here. Machines on your SpecWithCode Connect account are listed by themselves. Nothing to copy or paste.",
              )}
      </p>
      {connect.kind === "signed-in" && connect.connectOn === false ? (
        <div
          role="status"
          className="mt-3 flex flex-col items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="min-w-0 sm:flex-1">
            {tx(
              "SpecWithCode Connect is off on this machine, so your other machines cannot reach it. Turn on the SpecWithCode Connect switch in Settings > Machines, then choose Allow.",
            )}
          </p>
          {onShowConnectSwitch ? (
            <Button size="xs" variant="outline" onClick={onShowConnectSwitch}>
              {tx("Show the switch")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {machines.length ? (
        <JoinCardMachineList
          machines={machines}
          selected={selected}
          locked={opening !== null || allowing}
          onChoose={(machine) => void choose(machine)}
        />
      ) : (
        <JoinCardEmpty
          connect={connect}
          firstRun={firstRun}
          allAllowed={allAllowed}
          refreshing={discovery.refreshing}
          offline={discovery.offline}
          onSignIn={onSignIn}
          onRefresh={() => void refreshDiscovery()}
        />
      )}
      {opening !== null && openingLabel ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {tx("Opening {label} through SpecWithCode Connect…", { label: openingLabel })}
        </p>
      ) : null}
      {openError ? (
        <p role="alert" className="mt-2 text-xs text-destructive-foreground">
          {openError}
        </p>
      ) : null}
      {chosen ? (
        <JoinCardChosenAction
          key={chosen.environmentId}
          here={environmentId}
          coordinator={chosen.environmentId}
          hereLabel={name(environmentId, here?.label ?? "this machine")}
          coordinatorLabel={name(chosen.environmentId, chosen.label)}
          connected={chosen.connection.phase === "connected"}
          accountJoin={
            chosen.serverConfig?.environment.capabilities.fleetAccountJoinWorkers === true
          }
          access={access}
          onAccessChange={setAccess}
          onPendingChange={setAllowing}
          leaveLabel={firstRun ? tx("Skip") : tx("Not now")}
          onLeave={leave}
          onGranted={(grant) => {
            const coordinatorLabel = name(chosen.environmentId, chosen.label);
            setSaved({ coordinator: chosen.environmentId, coordinatorLabel, ...grant });
            setSelected(null);
            refreshGrants();
            onDone?.({
              environmentId: chosen.environmentId,
              label: coordinatorLabel,
              access: grant.access,
            });
          }}
        />
      ) : machines.length ? (
        <JoinCardAction
          coordinatorLabel={null}
          access={access}
          onAccessChange={setAccess}
          lasts={tx("Until you stop it, here or on that machine.")}
          pending={false}
          unavailable={null}
          error={null}
          onAllow={null}
          leaveLabel={firstRun ? tx("Skip") : tx("Not now")}
          onLeave={leave}
        />
      ) : (
        // Nothing to choose: only the one next step above, and the way out.
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={leave}>
            {firstRun ? tx("Skip") : tx("Not now")}
          </Button>
        </div>
      )}
    </JoinCardFrame>
  );
}

function JoinCardFrame({ accent = false, children }: { accent?: boolean; children: ReactNode }) {
  return (
    <section
      id="machines-join-card"
      className={cn(
        "rounded-xl border bg-card/60 px-3 py-3 sm:px-4 sm:py-4",
        accent ? "border-primary/40 ring-2 ring-primary/15" : "border-border/60",
      )}
    >
      {children}
    </section>
  );
}

function JoinCardMachineList({
  machines,
  selected,
  locked,
  onChoose,
}: {
  machines: ReadonlyArray<JoinCardMachine>;
  selected: EnvironmentId | null;
  /**
   * A machine is being opened or allowed. The radios stay focusable, so the
   * keyboard keeps its place, and a change is ignored until it is over.
   */
  locked: boolean;
  onChoose: (machine: JoinCardMachine) => void;
}) {
  const tx = useTx();
  const group = useId();
  const stateText: Record<JoinCardMachine["state"], string> = {
    online: tx("online"),
    checking: tx("checking…"),
    "not-answering": tx("not answering right now"),
    "not-connected": tx("not connected in this app"),
  };
  return (
    <fieldset className="mt-3 space-y-2">
      <legend className="sr-only">{tx("Machine sending work")}</legend>
      {machines.map((machine) => {
        const choosable = canChooseJoinCardMachine(machine);
        const checked = machine.environmentId === selected;
        const facts = [machine.os, machine.version].filter(Boolean).join(" · ");
        return (
          <label
            key={machine.environmentId}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2.5",
              checked ? "border-primary/60 ring-2 ring-primary/15" : "border-border/60",
              !choosable ? "opacity-60" : locked ? "cursor-progress" : "cursor-pointer",
            )}
          >
            <input
              type="radio"
              name={group}
              className="size-4 shrink-0 accent-primary"
              value={machine.environmentId}
              checked={checked}
              disabled={!choosable}
              aria-disabled={locked || !choosable}
              onChange={() => {
                if (!locked) onChoose(machine);
              }}
            />
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <LaptopIcon aria-hidden className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{machine.label}</span>
              <span className="block text-xs text-muted-foreground">
                {facts ? `${facts} · ` : null}
                <span
                  className={machine.state === "online" ? "text-success-foreground" : undefined}
                >
                  {stateText[machine.state]}
                </span>
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function JoinCardEmpty({
  connect,
  firstRun,
  allAllowed,
  refreshing,
  offline,
  onSignIn,
  onRefresh,
}: {
  connect: JoinCardConnect;
  firstRun: boolean;
  /** There are other machines, and each may already run work here. */
  allAllowed: boolean;
  refreshing: boolean;
  offline: boolean;
  onSignIn?: (() => void) | undefined;
  onRefresh: () => void;
}) {
  const tx = useTx();
  const signIn =
    connect.kind === "signed-out" && onSignIn ? (
      <Button size="xs" onClick={onSignIn}>
        {tx("Sign in to SpecWithCode Connect")}
      </Button>
    ) : null;
  // Signed out or still reading, more machines may yet appear: the next step comes first.
  const settled =
    connect.kind === "none" || (connect.kind === "signed-in" && !refreshing && !offline);
  const text =
    allAllowed && settled
      ? tx(
          "Every other machine this app knows is already listed under Who can run work here in Settings > Machines. Change, revoke or restore it there.",
        )
      : connect.kind === "none"
        ? firstRun
          ? tx(
              "No machine to choose yet. This build has no SpecWithCode Connect, so a machine joins with a code or a join line: open Settings > Machines, then Another account, or no Connect.",
            )
          : tx(
              "No machine to choose yet. This build has no SpecWithCode Connect, so a machine joins with a code or a join line: open Another account, or no Connect below.",
            )
        : connect.kind === "loading"
          ? tx("Checking your SpecWithCode Connect sign-in…")
          : connect.kind === "signed-out"
            ? tx(
                "Sign in to SpecWithCode Connect on this machine. Your other machines on the same account are then listed here.",
              )
            : refreshing
              ? tx("Looking for your other machines…")
              : offline
                ? tx(
                    "SpecWithCode Connect cannot be reached right now, so your machines cannot be listed. Check this machine's internet connection, then choose Check again.",
                  )
                : connect.account
                  ? tx(
                      "No other machine is signed in to {account} yet. On the other machine, install SpecWithCode and sign in to SpecWithCode Connect with this account. It is then listed here.",
                      { account: connect.account },
                    )
                  : tx(
                      "No other machine is on your SpecWithCode Connect account yet. On the other machine, install SpecWithCode and sign in to SpecWithCode Connect with this account. It is then listed here.",
                    );
  return (
    <div className="mt-3 flex flex-col items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <p role="status" className="min-w-0 text-xs text-muted-foreground sm:flex-1">
        {text}
      </p>
      {signIn}
      {connect.kind === "signed-in" && !refreshing ? (
        <Button size="xs" variant="outline" onClick={onRefresh}>
          {tx("Check again")}
        </Button>
      ) : null}
    </div>
  );
}

function JoinCardChosenAction({
  leaveLabel,
  onLeave,
  ...input
}: Parameters<typeof useIncomingWorkerAllow>[0] & { leaveLabel: string; onLeave: () => void }) {
  const tx = useTx();
  const { coordinatorLabel } = input;
  const { access, setAccess, pending, error, unavailable, throughAccount, allow } =
    useIncomingWorkerAllow(input);
  return (
    <JoinCardAction
      coordinatorLabel={coordinatorLabel}
      access={access}
      onAccessChange={setAccess}
      lasts={
        throughAccount
          ? tx("Until you stop it here or on {coordinatorLabel}. It renews by itself.", {
              coordinatorLabel,
            })
          : tx(
              "Until you stop it here or on {coordinatorLabel}. After Allow, this card says whether it renews by itself or ends on a date.",
              { coordinatorLabel },
            )
      }
      pending={pending}
      unavailable={unavailable}
      error={error}
      onAllow={() => void allow()}
      leaveLabel={leaveLabel}
      onLeave={onLeave}
    />
  );
}

/** The cap, how long it lasts, what is left out, and the one button. */
function JoinCardAction({
  coordinatorLabel,
  access,
  onAccessChange,
  lasts,
  pending,
  unavailable,
  error,
  onAllow,
  leaveLabel,
  onLeave,
}: {
  /** Null while no machine is chosen: the rows show, the button waits. */
  coordinatorLabel: string | null;
  access: StudioFleetWorkerAccess;
  onAccessChange: (access: StudioFleetWorkerAccess) => void;
  lasts: string;
  pending: boolean;
  unavailable: string | null;
  error: string | null;
  onAllow: (() => void) | null;
  /** "Not now" in Settings, "Skip" in a first-run step. */
  leaveLabel: string;
  onLeave: () => void;
}) {
  const tx = useTx();
  const blocked = pending || unavailable !== null || onAllow === null;
  return (
    <div className="mt-3 space-y-3">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center">
        <dt className="text-muted-foreground">{tx("Most its work may do")}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <select
            aria-label={tx("Most access for incoming work")}
            className="min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1"
            value={access}
            disabled={pending}
            onChange={(event) => onAccessChange(event.target.value as StudioFleetWorkerAccess)}
          >
            {FLEET_WORKER_ACCESS_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">{tx("The same choice as in a chat.")}</span>
        </dd>
        <dt className="text-muted-foreground">{tx("Lasts")}</dt>
        <dd>{lasts}</dd>
        <dt className="text-muted-foreground">{tx("Secrets")}</dt>
        <dd>{tx("Not included. Each secret transfer still asks you.")}</dd>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={blocked} onClick={() => onAllow?.()}>
          {pending
            ? tx("Setting up…")
            : coordinatorLabel
              ? tx("Allow {coordinatorLabel}", { coordinatorLabel })
              : tx("Choose a machine")}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onLeave}>
          {leaveLabel}
        </Button>
      </div>
      {unavailable ? (
        <p role="status" className="text-xs text-muted-foreground">
          {unavailable}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

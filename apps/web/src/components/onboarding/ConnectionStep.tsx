import { useAuth } from "@clerk/react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { ChevronRightIcon, CloudIcon, LinkIcon, MonitorIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMachineNicknames } from "../../studio/machineNickname";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { useEnvironments } from "../../state/environments";
import { isOnboardingRelayEnvironment } from "../../onboarding/targetEnvironment.logic";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CommandBlock } from "../CommandBlock";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import { useT, useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { useHeldFor, WizardStepFooter } from "./WizardFrame";

const CONNECT_SIGN_IN_TIMEOUT_MS = 10_000;

export function ConnectionStep({
  autoSelectedComputers,
  connectOptional,
  expandPairingInitially,
  selectedIds,
  onSelectionChange,
  onToggleEnvironment,
  onContinue,
  onPaired,
  onBack,
}: {
  readonly onBack?: (() => void) | undefined;
  readonly autoSelectedComputers: Set<EnvironmentId>;
  /** Off with no server here, where Connect or a pairing link is the way in. */
  readonly connectOptional: boolean;
  readonly expandPairingInitially: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId>) => void;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
  readonly onContinue: () => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const t = useT();
  const { environments } = useEnvironments();
  const nickname = useMachineNicknames();
  const cloudEnabled = hasCloudPublicConfig();
  const directEnvironments = environments.filter(
    (environment) => !cloudEnabled || !isOnboardingRelayEnvironment(environment),
  );
  const [pairingOpen, setPairingOpen] = useState(expandPairingInitially);
  const [isPairing, setIsPairing] = useState(false);
  const ready =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) =>
      environments.some(
        (environment) =>
          environment.environmentId === id && environment.connection.phase === "connected",
      ),
    );
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (
      ready &&
      (document.activeElement === document.body ||
        document.activeElement?.getAttribute("role") === "dialog")
    ) {
      continueRef.current?.focus();
    }
  }, [ready]);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        {t("wizard.connection.title")}
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        {t("wizard.connection.description")}
      </p>
      {directEnvironments.length > 0 ? (
        <fieldset className="mt-5 space-y-2">
          <legend className="sr-only">{t("wizard.connection.legend")}</legend>
          {directEnvironments.map((environment) => (
            <label
              key={environment.environmentId}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <Checkbox
                checked={selectedIds.has(environment.environmentId)}
                onCheckedChange={(checked) => {
                  const next = new Set(selectedIds);
                  if (checked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next);
                }}
              />
              <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-sm font-medium break-words">
                    {nickname(environment.environmentId, environment.label)}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {environment.connection.phase === "connected"
                      ? t("wizard.connection.connected")
                      : t("wizard.connection.connecting")}
                  </span>
                </span>
                {environment.displayUrl ? (
                  <span className="mt-0.5 block text-xs break-all text-muted-foreground">
                    {environment.displayUrl}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="mt-4 space-y-2">
        {cloudEnabled ? (
          <ConnectAccountOption
            autoSelectedComputers={autoSelectedComputers}
            optional={connectOptional}
            disabled={isPairing}
            selectedIds={selectedIds}
            onToggleEnvironment={onToggleEnvironment}
          />
        ) : null}
        <div className="rounded-lg border border-border bg-background">
          <Collapsible open={pairingOpen} onOpenChange={setPairingOpen}>
            <CollapsibleTrigger
              disabled={isPairing}
              render={
                <Button
                  variant="ghost"
                  size="sm-multiline"
                  className="min-h-14 w-full justify-start"
                />
              }
            >
              <LinkIcon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{t("wizard.connection.addComputer")}</span>
              <ChevronRightIcon
                className={cn("size-4 text-muted-foreground", pairingOpen && "rotate-90")}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="px-3 pb-3">
                <PairingForm
                  isPairing={isPairing}
                  setIsPairing={setIsPairing}
                  onPaired={(environmentId) => {
                    setPairingOpen(false);
                    onPaired(environmentId);
                    requestAnimationFrame(() => continueRef.current?.focus());
                  }}
                />
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </div>
      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        {t("wizard.connection.telemetry")}
      </p>
      <WizardStepFooter
        back={onBack ? { onClick: onBack, disabled: isPairing } : undefined}
        primary={{
          label: t("wizard.continue"),
          onClick: onContinue,
          disabled: !ready || isPairing,
          // The pairing link is the field to fill when it opens expanded.
          autoFocus: !expandPairingInitially,
        }}
        primaryRef={continueRef}
      />
    </>
  );
}

function ConnectAccountOption({
  autoSelectedComputers,
  optional,
  disabled,
  selectedIds,
  onToggleEnvironment,
}: {
  readonly autoSelectedComputers: Set<EnvironmentId>;
  readonly optional: boolean;
  readonly disabled: boolean;
  readonly selectedIds: ReadonlySet<EnvironmentId>;
  readonly onToggleEnvironment: (environmentId: EnvironmentId, checked: boolean) => void;
}) {
  const t = useT();
  const tx = useTx();
  const { environments } = useEnvironments();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { openAuthPrompt } = useStudioConnectAuthPrompt();
  const [expanded, setExpanded] = useState(true);
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const onDiscoveryReady = useCallback(() => setDiscoveryReady(true), []);
  const signInStalled = useHeldFor(!isLoaded, CONNECT_SIGN_IN_TIMEOUT_MS);

  return (
    <div className="rounded-lg border border-border bg-background">
      <Collapsible open={expanded && !!isSignedIn && discoveryReady} onOpenChange={setExpanded}>
        <CollapsibleTrigger
          disabled={disabled || !isLoaded}
          onClick={(event) => {
            if (!isSignedIn) {
              event.preventDefault();
              setExpanded(true);
              openAuthPrompt();
            }
          }}
          render={
            <Button variant="ghost" size="sm-multiline" className="min-h-14 w-full justify-start" />
          }
        >
          <CloudIcon className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-left">
            <span className="block">SpecWithCode Connect</span>
            {optional ? (
              <span className="block text-xs font-normal text-muted-foreground">
                {tx("Optional. Reach this computer from your phone and other machines.")}
              </span>
            ) : null}
          </span>
          <span className="text-xs text-muted-foreground">
            {!isLoaded
              ? signInStalled
                ? tx("Sign-in did not load")
                : t("wizard.connect.loadingSignIn")
              : !isSignedIn
                ? t("wizard.connect.signIn")
                : !discoveryReady
                  ? t("wizard.connect.loadingComputers")
                  : null}
          </span>
          <ChevronRightIcon
            className={cn("size-4 text-muted-foreground", expanded && isSignedIn && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel keepMounted>
          <div className="px-3 pb-3">
            <div className="mb-3 space-y-1.5">
              {isSignedIn ? (
                <CloudEnvironmentConnectRows
                  primaryEnvironmentId={null}
                  savedEnvironments={environments}
                  showSavedEnvironments
                  onDiscoveryReady={onDiscoveryReady}
                  selection={{ selectedIds, onChange: onToggleEnvironment, autoSelectedComputers }}
                  refreshWhileEmpty
                  empty={
                    <p className="py-3 text-sm text-muted-foreground">
                      {t("wizard.connect.noComputers")}
                    </p>
                  }
                />
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">{t("wizard.connect.runThis")}</p>
            <CommandBlock command="specweave-studio connect" className="mt-3" />
            <p className="mt-3 text-xs text-muted-foreground">{t("wizard.connect.keepRunning")}</p>
          </div>
        </CollapsiblePanel>
      </Collapsible>
      {signInStalled ? (
        <div role="alert" className="flex items-center justify-between gap-3 px-3 pb-3">
          <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
            {tx("Connect sign-in did not load, so check this computer's network.")}{" "}
            {optional
              ? tx("Setup works without Connect, and you can add it later in Settings > Machines.")
              : tx("You can add a computer with a pairing link instead.")}
          </p>
          <Button
            className="shrink-0"
            size="xs"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            {tx("Retry")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ── Step 2′: Direct pairing ──────────────────────────────────

/**
 * Register a computer in this browser using a server-minted pairing link.
 */
function PairingForm({
  isPairing,
  setIsPairing,
  onPaired,
}: {
  readonly isPairing: boolean;
  readonly setIsPairing: (value: boolean) => void;
  readonly onPaired: (environmentId: EnvironmentId) => void;
}) {
  const t = useT();
  const connectPairingEnvironment = useAtomCommand(connectPairing, { reportFailure: false });
  const [pairingUrl, setPairingUrl] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (isPairing || pairingUrl.trim().length === 0) return;
    setIsPairing(true);
    setErrorMessage("");
    const result = await connectPairingEnvironment({ pairingUrl: pairingUrl.trim() });
    if (!mountedRef.current) return;
    setIsPairing(false);
    if (result._tag === "Success") {
      onPaired(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    setErrorMessage(cause instanceof Error ? cause.message : t("wizard.pairing.failed"));
  };

  return (
    <>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <label className="block text-sm text-muted-foreground" htmlFor="onboarding-pairing-url">
            {t("wizard.pairing.label")}
          </label>
          <Input
            id="onboarding-pairing-url"
            autoFocus
            required
            aria-invalid={errorMessage.length > 0}
            aria-describedby={errorMessage ? "onboarding-pairing-error" : undefined}
            className="mt-2"
            size="lg"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            nativeInput
            readOnly={isPairing}
            placeholder="https://your-server:5230/pair#token=…"
            value={pairingUrl}
            onChange={(event) => setPairingUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.nativeEvent.isComposing || event.keyCode === 229)
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {errorMessage ? (
          <Alert id="onboarding-pairing-error" variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <CollapsibleTrigger
              type="button"
              className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
              {t("wizard.pairing.need")}
            </CollapsibleTrigger>
            <Button type="submit" disabled={isPairing || pairingUrl.trim().length === 0}>
              {isPairing ? t("wizard.pairing.pairing") : t("wizard.pairing.pair")}
            </Button>
          </div>
          <CollapsiblePanel>
            <p className="pt-3 text-sm text-muted-foreground">{t("wizard.pairing.runThis")}</p>
            <CommandBlock command="specweave-studio pair" className="mt-2" />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {renderRich(t("wizard.pairing.startFirst"), {
                serve: <code className="font-mono">specweave-studio serve</code>,
                tailscale: <code className="font-mono">--tailscale</code>,
              })}
            </p>
          </CollapsiblePanel>
        </Collapsible>
      </form>
    </>
  );
}

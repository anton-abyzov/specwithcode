import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI } from "../Icons";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { claudeAccountPlan, claudeLoginCommand } from "./addClaudeAccount.logic";
import { SettingsRow } from "./settingsLayout";

/**
 * A second Claude subscription on one machine: its own Claude instance with
 * its own CLAUDE_CONFIG_DIR, signed in once from that machine's terminal.
 * The existing ~/.claude sign-in is left alone, so both accounts report limits.
 */
export function AddClaudeAccountDialog({
  environmentId,
  environmentLabel,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onClose: () => void;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const createInstance = useAtomCommand(
    serverEnvironment.mutateProviderInstance,
    "Add Claude account",
  );
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
    reportDefect: false,
  });
  const [name, setName] = useState("Work");
  const [created, setCreated] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
    readonly homePath: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const provider = created
    ? providers?.find((candidate) => candidate.instanceId === created.instanceId)
    : undefined;
  const signedIn = provider?.auth.status === "authenticated";

  const check = async () => {
    if (!created || checking) return;
    setChecking(true);
    await refresh({ environmentId, input: { instanceId: created.instanceId } });
    setChecking(false);
  };

  // Coming back from the terminal or the browser is the moment to look again.
  useEffect(() => {
    if (!created || signedIn) return;
    const onFocus = () => {
      void refresh({ environmentId, input: { instanceId: created.instanceId } });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [created, signedIn, environmentId, refresh]);

  const createAccount = async () => {
    if (pending || !name.trim() || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    const plan = claudeAccountPlan(name, settings.providerInstances ?? {});
    const instanceId = ProviderInstanceId.make(plan.instanceId);
    // One create, not the whole map: a map from this window could drop an
    // instance another window just added.
    const result = await createInstance({
      environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "create",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: plan.displayName,
            enabled: true,
            config: { enabled: true, homePath: plan.homePath },
          },
        },
      },
    });
    if (result._tag === "Success") {
      setCreated({ instanceId, displayName: plan.displayName, homePath: plan.homePath });
    }
    setPending(false);
  };

  const command = created ? claudeLoginCommand(created.homePath) : "";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={created ? created.displayName : "Add Claude account"}
          description={`Each Claude account gets its own instance and sign-in on ${environmentLabel}. The Claude account already signed in there stays as it is.`}
        />
        <WizardPanel>
          {created ? (
            <div className="flex flex-col gap-4" data-add-claude-account="sign-in">
              <SettingsRow
                title={`Sign in on ${environmentLabel}`}
                description="Run this once in Terminal on that machine. It opens claude.ai in the browser: sign in with the other account there."
              />
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
                  {command}
                </code>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={copied ? "Copied" : "Copy command"}
                  onClick={() =>
                    void writeTextToClipboard(command).then(() => {
                      setCopied(true);
                    })
                  }
                >
                  {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                </Button>
              </div>
              <SettingsRow
                title="Account"
                description={
                  signedIn
                    ? `Signed in${provider?.auth.email ? ` as ${provider.auth.email}` : ""}. Its limits now show under Usage > Limits.`
                    : "Waiting for the sign-in. The app checks again when you come back to this window."
                }
                control={
                  signedIn ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={checking}
                      onClick={() => void check()}
                    >
                      {checking ? "Checking…" : "Check sign-in"}
                    </Button>
                  )
                }
              />
            </div>
          ) : (
            <form
              id="add-claude-account"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <SettingsRow
                title="Account name"
                description="Shown in the provider list, the model picker and Limits."
                control={
                  <Input
                    aria-label="Account name"
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Work or Marketing"
                  />
                }
              />
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {created ? (
            <Button variant={signedIn ? "default" : "outline"} onClick={onClose}>
              {signedIn ? "Done" : "Finish later"}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="add-claude-account"
                disabled={pending || !name.trim() || !canManageProviders}
              >
                <ClaudeAI className="size-4 shrink-0" aria-hidden="true" />
                {pending ? "Adding account…" : "Continue"}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

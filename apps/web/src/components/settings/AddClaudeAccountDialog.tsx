import { useTx } from "../../i18n";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI } from "../Icons";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { claudeAccountPlan, claudeLoginCommand } from "./addClaudeAccount.logic";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { SettingsRow } from "./settingsLayout";

/**
 * A second Claude subscription on one machine: its own Claude instance with
 * its own CLAUDE_CONFIG_DIR, signed in from here with "Sign in with Claude".
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
  const tx = useTx();
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const createInstance = useAtomCommand(
    serverEnvironment.mutateProviderInstance,
    "Add Claude account",
  );
  const os = useEnvironment(environmentId)?.serverConfig?.environment.platform.os;
  const [name, setName] = useState("Work");
  const [created, setCreated] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
    readonly homePath: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const provider = created
    ? providers?.find((candidate) => candidate.instanceId === created.instanceId)
    : undefined;
  const signedIn = provider?.auth.status === "authenticated";

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

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title={created ? created.displayName : tx("Add Claude account")}
          description={`Each Claude account gets its own instance and sign-in on ${environmentLabel}. The Claude account already signed in there stays as it is.`}
        />
        <WizardPanel>
          {created ? (
            <div data-add-claude-account="sign-in">
              <ClaudeSignIn
                environmentId={environmentId}
                environmentLabel={environmentLabel}
                instanceId={created.instanceId}
                provider={provider}
                os={os}
                command={claudeLoginCommand(created.homePath, os)}
                readOnly={!canManageProviders}
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
                    aria-label={tx("Account name")}
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={tx("e.g. Work or Marketing")}
                  />
                }
              />
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {created ? (
            <Button variant={signedIn ? "default" : "outline"} onClick={onClose}>
              {signedIn ? tx("Done") : tx("Finish later")}
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                {tx("Cancel")}
              </Button>
              <Button
                type="submit"
                form="add-claude-account"
                disabled={pending || !name.trim() || !canManageProviders}
              >
                <ClaudeAI className="size-4 shrink-0" aria-hidden="true" />
                {pending ? tx("Adding account…") : tx("Continue")}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import * as Equal from "effect/Equal";
import { useMemo, useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import {
  API_CREDIT_ACCOUNT_DRIVERS,
  type ApiCreditAccountDriver,
  apiCreditAccountInstance,
  CLAUDE_WORKSPACE_ID_PATTERN,
} from "./apiCreditAccount";

/**
 * Adds one API account (a key with its own credits, such as hackathon
 * credits) as a provider instance, so a thread stopped on the subscription
 * limit can continue on it. Add one per account; the key is sent once and
 * kept in the server's secret store.
 */
export function AddApiCreditAccountDialog({
  open,
  onOpenChange,
  environmentId,
  driver,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly driver: ApiCreditAccountDriver;
  readonly onCreated?: (instanceId: ProviderInstanceId) => void;
}) {
  const meta = API_CREDIT_ACCOUNT_DRIVERS[driver];
  const settings = useEnvironmentSettings(environmentId);
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [saving, setSaving] = useState(false);
  const existingIds = useMemo(() => {
    const ids = new Set(["codex", "claudeAgent", ...Object.keys(settings.providerInstances ?? {})]);
    const defaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<string, unknown>;
    for (const [kind, config] of Object.entries(settings.providers ?? {})) {
      if (!Equal.equals(config, defaults[kind])) ids.add(kind);
    }
    return ids;
  }, [settings.providerInstances, settings.providers]);
  const asksWorkspace = driver === "claudeAgent";
  const workspaceInvalid =
    asksWorkspace &&
    workspaceId.trim().length > 0 &&
    !CLAUDE_WORKSPACE_ID_PATTERN.test(workspaceId.trim());
  const canSave = canManage && apiKey.trim().length > 0 && !workspaceInvalid && !saving;

  const close = () => {
    setLabel("");
    setApiKey("");
    setWorkspaceId("");
    onOpenChange(false);
  };

  const save = async () => {
    if (!canSave || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    const { instanceId, instance } = apiCreditAccountInstance({
      driver,
      label,
      apiKey,
      ...(asksWorkspace ? { workspaceId } : {}),
      existingIds,
    });
    setSaving(true);
    const result = await persist({ operation: "create", instanceId, instance });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not add the API account",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `${instance.displayName} added`,
      description: "It shows under Providers once its key is checked.",
    });
    onCreated?.(instanceId);
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add an API account</DialogTitle>
          <DialogDescription>
            Turns on this account are billed per token to its credits at API prices, not to your
            subscription. Create the key in the {meta.console}. Add one account per key; when one
            runs out of credits, a stopped thread can continue on the next.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="api-credit-account-key">API key</Label>
              <Input
                id="api-credit-account-key"
                type="password"
                autoComplete="off"
                placeholder={meta.placeholder}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoFocus
              />
            </div>
            {asksWorkspace ? (
              <div className="grid gap-1.5">
                <Label htmlFor="api-credit-account-workspace">Workspace ID (optional)</Label>
                <Input
                  id="api-credit-account-workspace"
                  autoComplete="off"
                  placeholder="wrkspc_…"
                  value={workspaceId}
                  aria-invalid={workspaceInvalid || undefined}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {workspaceInvalid
                    ? "A workspace ID starts with wrkspc_."
                    : "Needed for a key that is not scoped to a workspace (user keys, sk-ant-usr…). Copy it from Settings → Workspaces in the Claude Console."}
                </p>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="api-credit-account-label">Name (optional)</Label>
              <Input
                id="api-credit-account-label"
                placeholder={meta.label}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            {!canManage ? (
              <p role="status" className="text-xs text-muted-foreground">
                This device cannot change providers on that machine.
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving ? "Adding…" : "Add account"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

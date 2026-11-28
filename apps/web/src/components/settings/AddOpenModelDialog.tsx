import { useTx } from "../../i18n";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@specweave-studio/contracts";
import {
  OPEN_MODEL_PRESETS,
  type OpenModelPresetId,
  openModelPresetById,
} from "@specweave-studio/shared/openModelPresets";
import * as Equal from "effect/Equal";
import { useMemo, useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { isProviderBrand, ProviderLogo } from "../ProviderLogo";
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
  canCreateOpenModelInstance,
  openModelInstance,
  openModelPresetNeedsModel,
} from "./openModelInstance";

/**
 * Adds an open model as a Claude Code instance: a vendor's own
 * Anthropic-compatible endpoint with the person's key, or a runtime on this
 * machine. The key is sent once and kept in the server's secret store.
 */
export function AddOpenModelDialog({
  open,
  onOpenChange,
  environmentId,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly onCreated?: (instanceId: ProviderInstanceId) => void;
}) {
  const tx = useTx();
  const settings = useEnvironmentSettings(environmentId);
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [presetId, setPresetId] = useState<OpenModelPresetId | null>(null);
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const existingIds = useMemo(() => {
    const ids = new Set(["codex", "claudeAgent", ...Object.keys(settings.providerInstances ?? {})]);
    const defaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<string, unknown>;
    for (const [kind, config] of Object.entries(settings.providers ?? {})) {
      if (!Equal.equals(config, defaults[kind])) ids.add(kind);
    }
    return ids;
  }, [settings.providerInstances, settings.providers]);
  const preset = openModelPresetById(presetId);
  const local = preset?.kind === "local";
  const canSave =
    canManage &&
    preset !== undefined &&
    canCreateOpenModelInstance({ preset, key, model }) &&
    !saving;

  const choose = (id: OpenModelPresetId) => {
    if (id === presetId) return;
    setPresetId(id);
    setKey("");
    setModel("");
    setBaseUrl("");
  };

  const close = () => {
    setPresetId(null);
    setKey("");
    setModel("");
    setBaseUrl("");
    onOpenChange(false);
  };

  const save = async () => {
    if (!canSave || !preset || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) {
      return;
    }
    const { instanceId, instance } = openModelInstance({
      preset,
      ...(local ? { baseUrl } : { key }),
      model,
      existingIds,
    });
    setSaving(true);
    const result = await persist({ operation: "create", instanceId, instance });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not add the open model",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: `${instance.displayName} added`,
      description: local
        ? "It shows under Providers once the app finds the runtime."
        : "It shows under Providers once its key is checked.",
    });
    onCreated?.(instanceId);
    close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{tx("Add an open model")}</DialogTitle>
          <DialogDescription>
            {tx(
              "Runs Claude Code on an open model: a vendor's endpoint with your own key, or a runtime on this machine.",
            )}
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
            <div className="grid gap-2">
              <div
                role="group"
                aria-label={tx("Open model")}
                className="grid grid-cols-2 gap-2 sm:grid-cols-3"
              >
                {OPEN_MODEL_PRESETS.map((option) => {
                  const selected = option.id === presetId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      data-open-model-preset={option.id}
                      aria-pressed={selected}
                      onClick={() => choose(option.id)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg bg-card px-3 py-2.5 text-left text-sm font-medium text-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5",
                        selected &&
                          "bg-primary/8 ring-2 ring-primary hover:bg-primary/8 dark:bg-primary/15 dark:ring-primary dark:hover:bg-primary/15",
                      )}
                    >
                      {isProviderBrand(option.brand) ? <ProviderLogo brand={option.brand} /> : null}
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {tx(
                  "Your key goes from this machine straight to the vendor. SpecWithCode never sells, pools or resells model access.",
                )}
              </p>
            </div>

            {preset && !local ? (
              <div className="grid gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor="open-model-key">{tx("API key")}</Label>
                  {preset.keyConsoleUrl ? (
                    <a
                      href={preset.keyConsoleUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline-offset-4 hover:underline"
                    >
                      {tx("Get a key")}
                    </a>
                  ) : null}
                </div>
                <Input
                  id="open-model-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  autoFocus
                />
              </div>
            ) : null}

            {preset && openModelPresetNeedsModel(preset) ? (
              <div className="grid gap-1.5">
                <Label htmlFor="open-model-model">{tx("Model ID")}</Label>
                <Input
                  id="open-model-model"
                  autoComplete="off"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {tx("Copy the model ID from the vendor's model list.")}
                </p>
              </div>
            ) : null}

            {preset && local ? (
              <details className="group grid gap-3 text-sm">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {tx("Address and model (optional)")}
                </summary>
                <div className="mt-3 grid gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="open-model-address">{tx("Address")}</Label>
                    <Input
                      id="open-model-address"
                      autoComplete="off"
                      placeholder={preset.baseUrl}
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="open-model-local-model">{tx("Model ID")}</Label>
                    <Input
                      id="open-model-local-model"
                      autoComplete="off"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {tx("Leave it empty to use the models the runtime lists.")}
                    </p>
                  </div>
                </div>
              </details>
            ) : null}

            {!canManage ? (
              <p role="status" className="text-xs text-muted-foreground">
                {tx("This device cannot change providers on that machine.")}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close}>
            {tx("Cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving ? tx("Adding…") : tx("Add model")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

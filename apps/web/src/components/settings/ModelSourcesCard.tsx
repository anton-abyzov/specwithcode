import {
  AuthProvidersManageScope,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import {
  addSource,
  missingTrackSource,
  removeSource,
  type SourceRemoveRefusal,
  sourceCandidates,
} from "@specweave-studio/shared/modelSources";
import {
  moveSource,
  type SourceMoveRefusal,
  type SourceRow,
} from "@specweave-studio/shared/modelTrackRules";
import { modelFamily } from "@specweave-studio/shared/modelVendor";
import { teamRulesProviderAllowed } from "@specweave-studio/shared/teamRules";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import { useTx } from "../../i18n";
import { FEATURED_ACP_AGENT_IDS, FEATURED_AGENT_NAMES } from "../../providerQuickSetup";
import { useEnvironmentScope } from "../../state/session";
import { useTeamRules } from "../../teamRules/useTeamRules";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { defaultAgentInstance } from "./FoundAgents";
import { Card, Note, SortableList, SortableRow, statusChip } from "./ModelListParts";
import { getProviderStatusView } from "./providerStatus";
import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";

type Tx = ReturnType<typeof useTx>;

/** The one step that moves a source toward ready. */
export type SourceFix = "turnOn" | "install" | "signIn" | "openProviders";

const FIX_LABELS: Record<SourceFix, string> = {
  turnOn: "Turn on",
  install: "Install",
  signIn: "Sign in",
  openProviders: "Open Providers",
};

/**
 * The step a source needs, read from the same status the Providers page
 * shows, so the button here and the row it opens never disagree. Null for a
 * source that is ready, limited until a reset, or still being checked.
 */
export function sourceFix(provider: ServerProvider, tx: Tx): SourceFix | null {
  const on = provider.enabled && provider.status !== "disabled";
  const view = getProviderStatusView(provider, on, tx);
  if (view.state === "ready" || view.state === "checking") return null;
  switch (view.action) {
    case "turnOn":
      return "turnOn";
    case "install":
      return "install";
    case "signIn":
      return "signIn";
    default:
      return "openProviders";
  }
}

/** What a source's state reads as in a sentence: "Needs Muse Code, not installed." */
function stateWords(row: SourceRow, tx: Tx): string {
  switch (row.status.state) {
    case "off":
      return tx("off");
    case "not-installed":
      return tx("not installed");
    case "sign-in":
      return tx("not signed in");
    case "not-ready":
      return tx("not ready");
    default:
      return tx("does not list it");
  }
}

/**
 * Runs a source's fix: Turn on in place, with the same settings write the
 * Providers page makes; Install, Sign in and Open Providers open that source
 * in Settings > Providers, where its own install and sign-in run.
 */
export function useSourceFixer(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const teamRules = useTeamRules(environmentId);
  const turnOn = (provider: ServerProvider) => {
    const instanceId = provider.instanceId;
    const saved = settings.providerInstances?.[instanceId];
    const instance = saved ?? defaultAgentInstance(settings, provider.driver);
    const next = { ...instance, enabled: true };
    const { providerInstances: _unused, ...patch } = buildProviderInstanceUpdatePatch({
      settings,
      instanceId,
      instance: next,
      driver: provider.driver,
      isDefault: instanceId === defaultInstanceIdForDriver(provider.driver),
    });
    void Promise.resolve(persist({ operation: "upsert", instanceId, instance: next }, patch)).then(
      (result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not update provider instance",
          description: error instanceof Error ? error.message : "The settings update failed.",
        });
      },
    );
  };
  const openProviders = (instanceId?: ProviderInstanceId) =>
    void navigate({
      to: "/settings/providers",
      search: instanceId === undefined ? { environmentId } : { environmentId, instanceId },
    });
  return {
    /** Whether this session may turn `provider` on here; Team rules can forbid it. */
    canFix: (provider: ServerProvider, fix: SourceFix) =>
      fix !== "turnOn" ||
      (canManage && teamRulesProviderAllowed(teamRules.state, String(provider.driver))),
    run: (provider: ServerProvider, fix: SourceFix) =>
      fix === "turnOn" ? turnOn(provider) : openProviders(provider.instanceId),
    openProviders,
  };
}

function FixButton(props: {
  readonly provider: ServerProvider;
  readonly fix: SourceFix;
  readonly fixer: ReturnType<typeof useSourceFixer>;
  readonly name: string;
  readonly inline?: boolean;
  readonly onRun?: () => void;
}) {
  const tx = useTx();
  if (!props.fixer.canFix(props.provider, props.fix)) return null;
  const run = () => {
    props.onRun?.();
    props.fixer.run(props.provider, props.fix);
  };
  const label = tx(FIX_LABELS[props.fix]);
  return props.inline === true ? (
    <InlineButton tone="link" type="button" onClick={run} aria-label={`${label}: ${props.name}`}>
      {label}
    </InlineButton>
  ) : (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={run}
      aria-label={`${label}: ${props.name}`}
    >
      {label}
    </Button>
  );
}

/** Featured agents that need no entry to be offered: setting one up happens in Providers. */
const FAMILY_AGENT: Partial<Record<string, (typeof FEATURED_ACP_AGENT_IDS)[number]>> = {
  google: "gemini",
};

/**
 * A track row whose model no source that is on lists: which source it needs,
 * how far that source is from ready, and the one step that fixes it. Falls
 * back to saying nothing here lists it when the machine has no such source.
 */
export function MissingTrackSource(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly model: string;
  /** The source a saved entry names, null for a built-in row. */
  readonly pinned?: ProviderInstanceId | null;
  readonly nowMs: number;
  readonly sourceName: (provider: ServerProvider) => string;
  /** Registry agents with an entry on this machine, by registry id. */
  readonly configuredAgents: ReadonlySet<string>;
}) {
  const tx = useTx();
  const fixer = useSourceFixer(props.environmentId);
  const row = missingTrackSource({
    providers: props.providers,
    model: props.model,
    nowMs: props.nowMs,
    pinned: props.pinned,
  });
  if (row === null) {
    const agent = FAMILY_AGENT[modelFamily({ slug: props.model })];
    if (agent !== undefined && !props.configuredAgents.has(agent)) {
      const name = FEATURED_AGENT_NAMES[agent];
      return (
        <li data-missing-source={agent}>
          <Badge variant="outline" size="sm">
            {tx("Not installed")}
          </Badge>{" "}
          {tx("Needs {source}, not set up on this machine.", { source: name })}{" "}
          <InlineButton tone="link" type="button" onClick={() => fixer.openProviders()}>
            {tx("Open Providers")}
          </InlineButton>
        </li>
      );
    }
    return (
      <li>
        <Badge variant="outline" size="sm">
          {tx("Not installed")}
        </Badge>{" "}
        {tx("No source on this machine lists it.")}
      </li>
    );
  }
  const name = props.sourceName(row.provider);
  const chip = statusChip(row.status, tx);
  const fix = sourceFix(row.provider, tx) ?? "openProviders";
  return (
    <li data-missing-source={row.provider.instanceId}>
      <Badge variant={chip.variant} size="sm">
        {chip.label}
      </Badge>{" "}
      {tx("Needs {source}, {state}.", { source: name, state: stateWords(row, tx) })}{" "}
      <FixButton provider={row.provider} fix={fix} fixer={fixer} name={name} inline />
    </li>
  );
}

function sourceKind(row: SourceRow, tx: Tx, candidate = false): string {
  if (row.hold === "per-token") return tx("Billed per use, never automatic");
  if (row.hold === "unknown-billing")
    return candidate
      ? tx("Billing unknown. Listing it lets a thread continue on it.")
      : tx("Billing unknown, never automatic");
  if (row.free) return tx("Free plan");
  return row.home === null ? tx("Subscription") : tx("Harness");
}

const SOURCE_REFUSALS: Record<SourceMoveRefusal | SourceRemoveRefusal, string> = {
  "held-source": "Billed per use or with unknown billing, so it is never picked on its own.",
  "into-held": "Sources picked automatically stay above the ones that are not.",
  "last-source": "Keep at least one source. To list every source again, use the built-in order.",
};

/** The Add source list: sources this machine has that are not listed, ready ones first. */
function AddSourceMenu(props: {
  readonly candidates: ReadonlyArray<SourceRow>;
  readonly setupAgents: ReadonlyArray<(typeof FEATURED_ACP_AGENT_IDS)[number]>;
  readonly sourceName: (provider: ServerProvider) => string;
  readonly fixer: ReturnType<typeof useSourceFixer>;
  readonly onAdd: (provider: ServerProvider) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const rows = props.candidates.map((row) => ({ row, fix: sourceFix(row.provider, tx) }));
  const isReady = (row: SourceRow) =>
    row.status.state === "ready" || row.status.state === "limited";
  const ready = rows.filter((entry) => isReady(entry.row));
  const setup = rows.filter((entry) => !isReady(entry.row));
  const empty = rows.length === 0 && props.setupAgents.length === 0;
  const option = ({ row, fix }: (typeof rows)[number]) => {
    const name = props.sourceName(row.provider);
    const chip = statusChip(row.status, tx);
    return (
      <li
        key={row.provider.instanceId}
        className="flex items-center gap-2 rounded-md px-2 py-1.5"
        data-source-candidate={row.provider.instanceId}
        data-source-state={row.status.state}
      >
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm">{name}</span>
          <span className="block text-xs text-muted-foreground">{sourceKind(row, tx, true)}</span>
        </div>
        <Badge variant={chip.variant} size="sm">
          {chip.label}
        </Badge>
        {fix === null && !isReady(row) ? null : fix === null ? (
          <Button
            type="button"
            size="xs"
            onClick={() => props.onAdd(row.provider)}
            aria-label={`${tx("Add")} ${name}`}
          >
            {tx("Add")}
          </Button>
        ) : (
          <FixButton
            provider={row.provider}
            fix={fix}
            fixer={props.fixer}
            name={name}
            onRun={() => {
              props.onAdd(row.provider);
              if (fix !== "turnOn") setOpen(false);
            }}
          />
        )}
      </li>
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" size="xs" variant="outline" />}>
        <PlusIcon />
        {tx("Add source")}
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg" padding="compact">
        <PopoverTitle className="sr-only">{tx("Add source")}</PopoverTitle>
        {empty ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {tx("Every source on this machine is already listed.")}
          </p>
        ) : null}
        {ready.length > 0 ? (
          <section aria-label={tx("Ready")}>
            <h4 className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
              {tx("Ready")}
            </h4>
            <ul>{ready.map(option)}</ul>
          </section>
        ) : null}
        {setup.length > 0 || props.setupAgents.length > 0 ? (
          <section
            aria-label={tx("Needs setup")}
            className={ready.length > 0 ? "mt-1 border-t border-border/70 pt-1" : undefined}
          >
            <h4 className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">
              {tx("Needs setup")}
            </h4>
            <ul>
              {setup.map(option)}
              {props.setupAgents.map((agent) => (
                <li
                  key={agent}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                  data-source-candidate={agent}
                  data-source-state="not-set-up"
                >
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{FEATURED_AGENT_NAMES[agent]}</span>
                    <span className="block text-xs text-muted-foreground">
                      {tx("Not set up on this machine")}
                    </span>
                  </div>
                  <Badge variant="outline" size="sm">
                    {tx("Not installed")}
                  </Badge>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setOpen(false);
                      props.fixer.openProviders();
                    }}
                    aria-label={`${tx("Open Providers")}: ${FEATURED_AGENT_NAMES[agent]}`}
                  >
                    {tx("Open Providers")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The Sources order: where a model runs, first to last. Sources are added from
 * the ones this machine has, removed (which only takes them out of the order)
 * and reordered by drag or keyboard; a move that cannot work is refused with
 * its reason.
 */
export function SourcesCard(props: {
  readonly environmentId: EnvironmentId;
  readonly rows: ReadonlyArray<SourceRow>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly order: ReadonlyArray<ProviderInstanceId>;
  readonly nowMs: number;
  readonly sourceName: (provider: ServerProvider) => string;
  /** Registry agents with an entry on this machine, by registry id. */
  readonly configuredAgents: ReadonlySet<string>;
  readonly onSave: (order: ReadonlyArray<ProviderInstanceId>) => void;
}) {
  const tx = useTx();
  const fixer = useSourceFixer(props.environmentId);
  const [refusal, setRefusal] = useState<SourceMoveRefusal | SourceRemoveRefusal | null>(null);
  const { rows } = props;
  const move = (from: number, to: number) => {
    const result = moveSource(rows, from, to, props.order);
    if ("refused" in result) return setRefusal(result.refused);
    setRefusal(null);
    props.onSave(result.order);
  };
  const remove = (instanceId: ProviderInstanceId) => {
    const result = removeSource({ rows, order: props.order, instanceId });
    if ("refused" in result) return setRefusal(result.refused);
    setRefusal(null);
    props.onSave(result.order);
  };
  const add = (provider: ServerProvider) => {
    setRefusal(null);
    props.onSave(addSource({ rows, order: props.order, provider }));
  };
  const candidates = sourceCandidates({
    providers: props.providers,
    order: props.order,
    nowMs: props.nowMs,
  });
  const hasGrok = props.providers.some((provider) => provider.driver === "grok");
  const setupAgents = FEATURED_ACP_AGENT_IDS.filter(
    (agent) => !props.configuredAgents.has(agent) && !(agent === "grok-build" && hasGrok),
  );
  return (
    <Card
      id="model-sources"
      title={tx("Sources")}
      hint={tx("Where a model runs, first to last. A source not listed is tried after these.")}
      control={
        <AddSourceMenu
          candidates={candidates}
          setupAgents={setupAgents}
          sourceName={props.sourceName}
          fixer={fixer}
          onAdd={add}
        />
      }
    >
      <SortableList
        label={tx("Sources order")}
        ids={rows.map((row) => row.provider.instanceId)}
        onMove={move}
      >
        {rows.map((row, index) => {
          const chip = statusChip(row.status, tx);
          const name = props.sourceName(row.provider);
          const fix = sourceFix(row.provider, tx);
          return (
            <SortableRow
              key={row.provider.instanceId}
              id={row.provider.instanceId}
              position={index + 1}
              label={name}
              locked={row.hold !== null}
            >
              <div className="min-w-0 flex-1">
                <span className="truncate text-sm font-medium">{name}</span>
                <p className="text-xs text-muted-foreground">{sourceKind(row, tx)}</p>
              </div>
              <Badge variant={chip.variant} size="sm">
                {chip.label}
              </Badge>
              {fix !== null ? (
                <FixButton provider={row.provider} fix={fix} fixer={fixer} name={name} />
              ) : null}
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`${tx("Remove")} ${name}`}
                onClick={() => remove(row.provider.instanceId)}
              >
                <XIcon className="size-3" />
              </Button>
            </SortableRow>
          );
        })}
      </SortableList>
      {props.order.length > 0 ? (
        <div className="border-t border-border/70 px-3 py-2">
          <Button type="button" size="xs" variant="outline" onClick={() => props.onSave([])}>
            {tx("Use the built-in order")}
          </Button>
        </div>
      ) : null}
      {refusal !== null ? <Note tone="warning">{tx(SOURCE_REFUSALS[refusal])}</Note> : null}
    </Card>
  );
}

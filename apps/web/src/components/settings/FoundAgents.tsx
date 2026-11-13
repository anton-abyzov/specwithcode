import {
  type AgentSearch,
  AuthOrchestrationReadScope,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type FoundAgent,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useTx } from "../../i18n";
import { acpAgentIdForInstanceConfig } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { getDriverOption } from "./providerDriverMeta";

/** While a search runs, its progress is read this often. */
const PROGRESS_INTERVAL_MS = 700;
/** A search that reports no end is no longer read after this long. */
const PROGRESS_LIMIT_MS = 90_000;

/** Agents the registry offers. Built-in agents take their name from the driver list. */
const REGISTRY_AGENT_NAMES: Readonly<Record<string, string>> = {
  gemini: "Gemini CLI",
  "github-copilot-cli": "GitHub Copilot",
};

export function agentName(agent: string): string {
  return (
    REGISTRY_AGENT_NAMES[agent] ?? getDriverOption(ProviderDriverKind.make(agent))?.label ?? agent
  );
}

type AgentSettings = Pick<ServerSettings, "providers" | "providerInstances">;

// What the last search on each machine answered, for parts of the page that
// show one fact from it without running a search of their own.
const lastSearches = new Map<EnvironmentId, AgentSearch>();
const searchListeners = new Set<() => void>();
const onSearchAnswered = (listener: () => void) => {
  searchListeners.add(listener);
  return () => void searchListeners.delete(listener);
};
function rememberSearch(environmentId: EnvironmentId, search: AgentSearch): void {
  lastSearches.set(environmentId, search);
  for (const listener of searchListeners) listener();
}

/**
 * The file an agent's command is on a machine, from the last search there.
 * Null until a search has answered, when the agent was not found, and on a
 * machine whose server does not say.
 */
export function useFoundAgentPath(environmentId: EnvironmentId, agent: string): string | null {
  const search = useSyncExternalStore(
    onSearchAnswered,
    () => lastSearches.get(environmentId) ?? null,
    () => null,
  );
  return search?.agents.find((found) => found.agent === agent)?.path ?? null;
}

/**
 * The default entry of a built-in agent as Settings shows it: the saved entry,
 * else the older per-agent settings, else one that is off.
 */
export function defaultAgentInstance(
  settings: AgentSettings,
  driver: ProviderDriverKind,
): ProviderInstanceConfig {
  const saved = settings.providerInstances?.[defaultInstanceIdForDriver(driver)];
  if (saved !== undefined) return saved;
  const older = (settings.providers as Readonly<Record<string, unknown>>)[driver];
  if (older === null || typeof older !== "object") return { driver, enabled: false, config: {} };
  const { enabled, ...config } = older as { readonly enabled?: boolean };
  return { driver, ...(enabled === undefined ? {} : { enabled }), config };
}

/** Whether a found agent already has an entry that is on (built-in) or added (registry). */
export function isAgentInUse(settings: AgentSettings, found: FoundAgent): boolean {
  const instances = Object.values(settings.providerInstances ?? {});
  if (found.kind === "registry") {
    return instances.some(
      (instance) =>
        instance.driver === "acpRegistry" &&
        acpAgentIdForInstanceConfig(instance.config) === found.agent,
    );
  }
  const driver = ProviderDriverKind.make(found.agent);
  return (
    resolveProviderInstanceEnabled(defaultAgentInstance(settings, driver)) ||
    instances.some(
      (instance) => instance.driver === driver && resolveProviderInstanceEnabled(instance),
    )
  );
}

export interface FoundAgentRow {
  readonly agent: string;
  readonly kind: FoundAgent["kind"];
  readonly name: string;
  readonly state: "ready" | "signed-out" | "installed";
  /** Muse Code can share code with its maker by a setting, so a person turns it on. */
  readonly sharesCode: boolean;
}

export interface FoundAgentsView {
  /** Found agents that still need a step, in the order the server lists them. */
  readonly rows: ReadonlyArray<FoundAgentRow>;
  readonly foundCount: number;
  readonly checkedCount: number;
  readonly notFound: ReadonlyArray<string>;
  readonly noAnswer: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
}

export function foundAgentsView(search: AgentSearch, settings: AgentSettings): FoundAgentsView {
  const found = search.agents.filter(
    (agent): agent is FoundAgent & { readonly state: FoundAgentRow["state"] } =>
      agent.state === "ready" || agent.state === "signed-out" || agent.state === "installed",
  );
  return {
    rows: found
      .filter((agent) => !isAgentInUse(settings, agent))
      .map((agent) => ({
        agent: agent.agent,
        kind: agent.kind,
        name: agentName(agent.agent),
        state: agent.state,
        sharesCode: agent.agent === "muse",
      })),
    foundCount: found.length,
    checkedCount: search.agents.length,
    notFound: search.agents
      .filter(({ state }) => state === "not-installed")
      .map(({ agent }) => agentName(agent)),
    noAnswer: search.agents
      .filter(({ state }) => state === "unknown")
      .map(({ agent }) => agentName(agent)),
    pending: search.pending.map(agentName),
  };
}

/**
 * Asks the machine what agents it has. The server answers at once with what it
 * knows and keeps searching, so this reads again until nothing is pending.
 * `search` stays null on a machine whose server cannot search.
 */
export function useAgentSearch(environmentId: EnvironmentId, enabled: boolean) {
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [search, setSearch] = useState<AgentSearch | null>(null);
  const [asking, setAsking] = useState(false);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    request.current += 1;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const ask = useCallback(
    (fresh: boolean) => {
      stop();
      const mine = request.current;
      const startedAt = Date.now();
      const read = async (startFresh: boolean) => {
        const result = await refresh({
          environmentId,
          input: startFresh ? { discover: true, fresh: true } : { discover: true },
        });
        if (request.current !== mine) return;
        const next = result._tag === "Success" ? result.value.agentSearch : undefined;
        if (next === undefined) {
          setAsking(false);
          return;
        }
        setSearch(next);
        rememberSearch(environmentId, next);
        const reading = next.pending.length > 0 && Date.now() - startedAt < PROGRESS_LIMIT_MS;
        setAsking(reading);
        if (!reading) return;
        timer.current = setTimeout(() => void read(false), PROGRESS_INTERVAL_MS);
      };
      void read(fresh);
    },
    [environmentId, refresh, stop],
  );

  useEffect(() => {
    if (!enabled) return;
    ask(false);
    return stop;
  }, [ask, enabled, stop]);

  const find = useCallback(() => {
    setAsking(true);
    ask(true);
  }, [ask]);

  return { search, searching: asking && enabled, find };
}

const STATE_TEXT = {
  ready: "Signed in, not turned on.",
  "signed-out": "Installed, not signed in.",
  installed: "Installed, not turned on.",
} as const;

/** At most three names, then how many more. */
function useNameList() {
  const tx = useTx();
  return (names: ReadonlyArray<string>) =>
    names.length <= 3
      ? names.join(", ")
      : tx("{names} and {count} more", {
          names: names.slice(0, 3).join(", "),
          count: names.length - 3,
        });
}

export function FoundAgentsList({
  view,
  searched,
  searching,
  machine,
  readOnly,
  onFind,
  onTurnOn,
  onAdd,
}: {
  readonly view: FoundAgentsView;
  readonly searched: ReadonlyArray<string>;
  readonly searching: boolean;
  readonly machine: string;
  readonly readOnly: boolean;
  readonly onFind: () => void;
  readonly onTurnOn: (driver: ProviderDriverKind) => void;
  readonly onAdd: () => void;
}) {
  const tx = useTx();
  const nameList = useNameList();
  return (
    <section
      aria-label={tx("Agents found on {machine}", { machine })}
      className="mx-3 mb-3 rounded-lg border border-border/60 bg-muted/10 text-xs sm:mx-4"
    >
      <div className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        <p role="status" className="min-w-0 flex-1 text-muted-foreground">
          {searching && view.pending.length > 0
            ? tx("Looking for {agents}…", { agents: nameList(view.pending) })
            : tx("{found} of {count} agents found on {machine}.", {
                found: view.foundCount,
                count: view.checkedCount,
                machine,
              })}
        </p>
        <Button size="xs" variant="outline" disabled={searching} onClick={onFind}>
          {tx("Find agents")}
        </Button>
      </div>
      {view.rows.length > 0 ? (
        <ul className="divide-y divide-border/50 border-t border-border/50">
          {view.rows.map((row) => (
            <li key={row.agent} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-foreground">{row.name}</span>{" "}
                <span className="text-muted-foreground">
                  {row.kind === "registry"
                    ? tx("Installed, not added.")
                    : tx(STATE_TEXT[row.state])}
                </span>
                {row.sharesCode ? (
                  <p className="mt-0.5 text-muted-foreground">
                    {tx(
                      "Muse Code can share your code with Meta when its Contributor mode is on. Check that setting before you turn it on.",
                    )}
                  </p>
                ) : null}
              </div>
              {readOnly ? null : row.kind === "registry" ? (
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={tx("Add {agent}", { agent: row.name })}
                  onClick={onAdd}
                >
                  {tx("Add agent")}
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={tx("Turn on {agent}", { agent: row.name })}
                  onClick={() => onTurnOn(ProviderDriverKind.make(row.agent))}
                >
                  {tx("Turn on")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {view.notFound.length > 0 || view.noAnswer.length > 0 ? (
        <details className="border-t border-border/50 px-3 py-2 text-muted-foreground">
          <summary className="cursor-default">
            {[
              view.notFound.length > 0
                ? tx("Not found: {agents}.", { agents: view.notFound.join(", ") })
                : null,
              view.noAnswer.length > 0
                ? tx("No answer from: {agents}.", { agents: view.noAnswer.join(", ") })
                : null,
            ]
              .filter((line) => line !== null)
              .join(" ")}
          </summary>
          <p className="mt-2">{tx("Where it looked")}</p>
          <ul className="mt-1 space-y-0.5 font-mono break-all">
            {searched.map((folder) => (
              <li key={folder}>{folder}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * What the machine's agent search found, above the agent list in Settings >
 * Providers. Renders nothing on a machine whose server cannot search.
 */
export function FoundAgents({
  environmentId,
  machine,
  settings,
  readOnly,
  onTurnOn,
  onAdd,
}: {
  readonly environmentId: EnvironmentId;
  readonly machine: string;
  readonly settings: AgentSettings;
  readonly readOnly: boolean;
  readonly onTurnOn: (driver: ProviderDriverKind) => void;
  readonly onAdd: () => void;
}) {
  const canSearch = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const { search, searching, find } = useAgentSearch(environmentId, canSearch);
  if (search === null) return null;
  return (
    <FoundAgentsList
      view={foundAgentsView(search, settings)}
      searched={search.searched}
      searching={searching}
      machine={machine}
      readOnly={readOnly}
      onFind={find}
      onTurnOn={onTurnOn}
      onAdd={onAdd}
    />
  );
}

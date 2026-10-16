import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@specweave-studio/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Owner-only file holding the thread's current `{ endpoint, authorization }`.
   * Out-of-process bridges re-read it after a 401 so a credential that moved
   * (new endpoint, revoked generation) is picked up without restarting the
   * agent. Absent when the registry has no file-backed secret store.
   */
  readonly credentialFile?: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/**
 * Live credentials by thread and provider instance. A thread can have more
 * than one provider session at a time (a provider switch, a handoff, a run on
 * another provider while the first one's background agents keep working),
 * and each session must keep its own credential: handing one instance's
 * credential to another made every call it made look like the other
 * provider's, and every change it asked for failed with parent_not_active.
 */
const sessionsByThread = new Map<ThreadId, Map<ProviderInstanceId, McpProviderSessionConfig>>();
/** The instance whose credential a lookup without an instance gets: the one prepared last. */
const currentInstanceByThread = new Map<ThreadId, ProviderInstanceId>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  let byInstance = sessionsByThread.get(config.threadId);
  if (byInstance === undefined) {
    byInstance = new Map();
    sessionsByThread.set(config.threadId, byInstance);
  }
  byInstance.set(config.providerInstanceId, config);
  currentInstanceByThread.set(config.threadId, config.providerInstanceId);
}

/**
 * The live credential of `providerInstanceId` for the thread, or, without an
 * instance, of the instance that was prepared last for it.
 */
export function readMcpProviderSession(
  threadId: ThreadId,
  providerInstanceId?: ProviderInstanceId,
): McpProviderSessionConfig | undefined {
  const instance = providerInstanceId ?? currentInstanceByThread.get(threadId);
  return instance === undefined ? undefined : sessionsByThread.get(threadId)?.get(instance);
}

/**
 * The thread's endpoint and authorization for `providerInstanceId` only:
 * after a provider switch, a lingering runtime of the previous instance keeps
 * its own credential and never adopts the new agent's.
 */
export function readMcpProviderCredentials(
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId | undefined,
): { readonly endpoint: string; readonly authorization: string } | undefined {
  if (providerInstanceId === undefined) return undefined;
  const session = readMcpProviderSession(threadId, providerInstanceId);
  return session === undefined
    ? undefined
    : { endpoint: session.endpoint, authorization: session.authorizationHeader };
}

/**
 * Whether the provider session a credential was issued to is still attached
 * in this server: its credential is the one live for its thread and instance.
 * Released sessions, and credentials restored after a restart that no session
 * has picked up again, are not.
 */
export function isLiveMcpProviderSession(thread: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
}): boolean {
  return (
    readMcpProviderSession(thread.threadId, thread.providerInstanceId)?.providerSessionId ===
    thread.providerSessionId
  );
}

/** Forgets the thread's credential for one instance, or for every instance when none is given. */
export function clearMcpProviderSession(
  threadId: ThreadId,
  providerInstanceId?: ProviderInstanceId,
): void {
  if (providerInstanceId === undefined) {
    sessionsByThread.delete(threadId);
    currentInstanceByThread.delete(threadId);
    return;
  }
  const byInstance = sessionsByThread.get(threadId);
  if (byInstance === undefined) return;
  byInstance.delete(providerInstanceId);
  if (byInstance.size === 0) {
    sessionsByThread.delete(threadId);
    currentInstanceByThread.delete(threadId);
    return;
  }
  if (currentInstanceByThread.get(threadId) === providerInstanceId) {
    currentInstanceByThread.set(threadId, Array.from(byInstance.keys()).at(-1)!);
  }
}

/** Forgets the thread's credential that `providerSessionId` names, whichever instance holds it. */
export function clearMcpProviderSessionCredential(
  threadId: ThreadId,
  providerSessionId: string,
): void {
  for (const [instance, config] of sessionsByThread.get(threadId) ?? []) {
    if (config.providerSessionId === providerSessionId) {
      clearMcpProviderSession(threadId, instance);
    }
  }
}

function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
  currentInstanceByThread.clear();
}

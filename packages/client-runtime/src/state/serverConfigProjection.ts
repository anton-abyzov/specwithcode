import {
  gitHubCopilotIconUrlForInstanceConfig,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Cached config keeps the provider and model catalog available across reconnects.
 * Published themes and usage-limit sources are current machine state, so a
 * cache could restore a set the machine no longer reports. Replay sends both
 * as separate events.
 */
export function withoutEnvironmentThemes(config: ServerConfig): ServerConfig {
  if (config.environmentThemes === undefined && config.usageLimitSources === undefined) {
    return config;
  }
  const { environmentThemes: _themes, usageLimitSources: _sources, ...rest } = config;
  return rest;
}

/**
 * Copilot is named by its configured identity, not by whatever icon a snapshot
 * carries: a server from before local-install branding, or a cached snapshot,
 * omits the icon and every surface would fall back to the generic ACP mark.
 */
export function withCopilotProviderIcons(config: ServerConfig): ServerConfig {
  const instances = config.settings?.providerInstances;
  if (!instances || !config.providers) return config;
  let changed = false;
  const providers = config.providers.map((provider) => {
    if (provider.driver !== "acpRegistry" || !Object.hasOwn(instances, provider.instanceId)) {
      return provider;
    }
    const iconUrl = gitHubCopilotIconUrlForInstanceConfig(instances[provider.instanceId]?.config);
    if (iconUrl === null || provider.iconUrl === iconUrl) return provider;
    changed = true;
    return { ...provider, iconUrl };
  });
  return changed ? { ...config, providers } : config;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  return Option.map(applyServerConfigEvent(current, event), (projection) => {
    const config = withCopilotProviderIcons(projection.config);
    return config === projection.config ? projection : { ...projection, config };
  });
}

/**
 * The storage status to keep when a snapshot arrives without one. A server
 * that just restarted sends its first snapshot before its first disk check,
 * and a full disk is exactly when it restarts, so the last status stays until
 * the same build reports a new one. A different build may predate the field
 * and never report one, so its snapshot clears the status.
 */
function carriedStorageStatus(
  current: Option.Option<ServerConfigProjection>,
  next: ServerConfig,
): ServerConfig["storage"] {
  if (Option.isNone(current)) return undefined;
  const previous = current.value.config;
  return previous.environment.environmentId === next.environment.environmentId &&
    previous.environment.serverVersion === next.environment.serverVersion
    ? previous.storage
    : undefined;
}

function applyServerConfigEvent(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot": {
      // Wire snapshots never contain published themes. Keep the previous set
      // until a capable server sends its authoritative theme event. A legacy
      // server cannot send a later removal, so a downgrade must clear the set.
      const capabilities = event.config.environment.capabilities;
      const carriedThemes =
        capabilities.environmentThemes === true && Option.isSome(current)
          ? current.value.config.environmentThemes
          : undefined;
      const carriedSources =
        capabilities.usageLimitSources === true && Option.isSome(current)
          ? current.value.config.usageLimitSources
          : undefined;
      const carriedStorage =
        event.config.storage === undefined
          ? carriedStorageStatus(current, event.config)
          : undefined;
      return Option.some({
        config: {
          ...event.config,
          ...(carriedThemes === undefined ? {} : { environmentThemes: carriedThemes }),
          ...(carriedSources === undefined ? {} : { usageLimitSources: carriedSources }),
          ...(carriedStorage === undefined ? {} : { storage: carriedStorage }),
        },
        latestEvent: event,
        source: "live" as const,
      });
    }
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: event.payload.providers,
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: event.payload.settings,
        },
        latestEvent: event,
        source: "live",
      }));
    case "environmentThemesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          environmentThemes: event.payload.themes.length > 0 ? event.payload.themes : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
    case "usageLimitSourcesUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          usageLimitSources: event.payload.sources.length > 0 ? event.payload.sources : undefined,
        },
        latestEvent: event,
        source: "live",
      }));
  }
}

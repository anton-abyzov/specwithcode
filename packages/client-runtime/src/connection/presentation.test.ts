import { EnvironmentId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  environmentMcpUrl,
  environmentPublicMcpUrl,
  isLoopbackHttpBaseUrl,
  connectionStatusText,
  connectionStatusTitle,
  presentEnvironmentConnection,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
  enabled: true,
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("labels a blocked protocol as unsupported", () => {
    const connection = presentConnectionState(
      supervisorState({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Update your app.",
        }),
      }),
    );
    expect(connection.phase).toBe("unsupported");
    expect(connection.error).toBe("Update your app.");
    expect(connectionStatusText(connection)).toBe("Client not supported");
  });

  it("says when a blocked connection lost its sign-in", () => {
    const connection = presentConnectionState(
      supervisorState({
        phase: "blocked",
        lastFailure: new ConnectionBlockedError({
          reason: "authentication",
          detail: "The environment credential is invalid.",
        }),
      }),
    );
    expect(connection.phase).toBe("error");
    expect(connection.blockedReason).toBe("authentication");
  });

  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("https://environment.example.test");
  });

  it("offers an MCP address only where an MCP client can sign in", () => {
    expect(environmentMcpUrl({ entry: ENTRY })).toBe("https://environment.example.test/mcp");
    const withBase = (httpBaseUrl: string): ConnectionCatalogEntry => ({
      ...ENTRY,
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: TARGET.connectionId,
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          httpBaseUrl,
          wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
        }),
      ),
    });
    expect(environmentMcpUrl({ entry: withBase("http://127.0.0.1:8319/") })).toBe(
      "http://127.0.0.1:8319/mcp",
    );
    // A plain-http LAN or tailnet address is refused by MCP clients' token checks.
    expect(environmentMcpUrl({ entry: withBase("http://100.81.102.68:8319") })).toBeNull();
  });

  const bearerRoute = (connectionId: string, httpBaseUrl: string): ConnectionRoute => ({
    target: new BearerConnectionTarget({ ...TARGET, connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  });
  const relayTarget = new RelayConnectionTarget({
    environmentId: TARGET.environmentId,
    label: TARGET.label,
  });

  it("copies the MCP address of the route this device is connected over", () => {
    const loopback = bearerRoute("loopback", "http://127.0.0.1:8319/");
    const serve = bearerRoute("serve", "https://machine.tailnet.ts.net/");
    const other = bearerRoute("other", "https://other.example.test/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: loopback.target,
      profile: loopback.profile,
      alternateRoutes: [serve, other],
    };

    expect(environmentMcpUrl({ entry, connectedTarget: serve.target })).toBe(
      "https://machine.tailnet.ts.net/mcp",
    );
    expect(environmentMcpUrl({ entry, connectedTarget: other.target })).toBe(
      "https://other.example.test/mcp",
    );
    // Not connected: the preferred route.
    expect(environmentMcpUrl({ entry })).toBe("http://127.0.0.1:8319/mcp");
    expect(environmentMcpUrl({ entry, connectedTarget: null })).toBe("http://127.0.0.1:8319/mcp");
  });

  it("passes over plain-http routes MCP clients cannot sign in through", () => {
    const lan = bearerRoute("lan", "http://192.168.4.53:8319/");
    const tailnet = bearerRoute("tailnet", "http://100.115.1.44:8319/");
    const serve = bearerRoute("serve", "https://machine.tailnet.ts.net/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: lan.target,
      profile: lan.profile,
      alternateRoutes: [tailnet, serve],
    };

    // Connected over plain-http tailnet: falls through to the first safe route.
    expect(environmentMcpUrl({ entry, connectedTarget: tailnet.target })).toBe(
      "https://machine.tailnet.ts.net/mcp",
    );
    expect(
      environmentMcpUrl({
        entry: { ...entry, alternateRoutes: [tailnet] },
        connectedTarget: tailnet.target,
      }),
    ).toBeNull();
  });

  it("passes over routes without an address of their own", () => {
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: relayTarget,
      profile: Option.none(),
      alternateRoutes: [{ target: ENTRY.target, profile: ENTRY.profile }],
    };

    // Relay discovery has not reported the tunnel address yet.
    expect(environmentMcpUrl({ entry, connectedTarget: relayTarget })).toBe(
      "https://environment.example.test/mcp",
    );
    expect(
      environmentMcpUrl({
        entry,
        connectedTarget: relayTarget,
        relayHttpBaseUrl: "https://tunnel.example.test",
      }),
    ).toBe("https://tunnel.example.test/mcp");
  });

  it("offers the public Connect MCP address when a relay route exists", () => {
    const loopback = bearerRoute("loopback", "http://127.0.0.1:8319/");
    const entry: ConnectionCatalogEntry = {
      ...ENTRY,
      target: loopback.target,
      profile: loopback.profile,
      alternateRoutes: [{ target: relayTarget, profile: Option.none() }],
    };
    const relayHttpBaseUrl = "https://tunnel.example.test/base?x=1";

    expect(environmentMcpUrl({ entry, relayHttpBaseUrl, connectedTarget: loopback.target })).toBe(
      "http://127.0.0.1:8319/mcp",
    );
    expect(environmentPublicMcpUrl({ entry, relayHttpBaseUrl })).toBe(
      "https://tunnel.example.test/mcp",
    );
    expect(environmentPublicMcpUrl({ entry })).toBeNull();
    expect(environmentPublicMcpUrl({ entry, relayHttpBaseUrl: "http://127.0.0.1:9/" })).toBeNull();
    // No Connect route: no public address, whatever discovery says.
    expect(environmentPublicMcpUrl({ entry: ENTRY, relayHttpBaseUrl })).toBeNull();
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Relay connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Relay connection timed out.",
      traceId: "trace-retry",
    });
  });

  it("combines reconnect progress with the latest failure", () => {
    const connection = {
      phase: "reconnecting",
      error: "Relay request timed out.",
      traceId: "trace-retry",
    } as const;
    expect(connectionStatusText(connection)).toBe(
      "Failed to connect. Reconnecting... Reason: Relay request timed out.",
    );
    expect(connectionStatusTitle(connection)).toBe("Failed to connect. Reconnecting...");
  });

  it("presents the supervisor's offline state without consulting shell state", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          network: "offline",
          phase: "offline",
          stage: null,
        }),
      ),
    ).toEqual({
      phase: "offline",
      error: null,
      traceId: null,
    });
  });

  it("presents a connected supervisor snapshot as connected", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connected",
          stage: null,
          generation: 1,
        }),
      ),
    ).toEqual({
      phase: "connected",
      error: null,
      traceId: null,
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});

describe("isLoopbackHttpBaseUrl", () => {
  it("recognises this device's own loopback server", () => {
    expect(isLoopbackHttpBaseUrl("http://127.0.0.1:8319")).toBe(true);
    expect(isLoopbackHttpBaseUrl("http://localhost:8319/")).toBe(true);
    expect(isLoopbackHttpBaseUrl("http://[::1]:8319")).toBe(true);
    expect(isLoopbackHttpBaseUrl("https://127.0.0.1:8443")).toBe(true);
  });

  it("treats every other address, and no address, as another machine", () => {
    expect(isLoopbackHttpBaseUrl("https://m4.tailnet.example.test")).toBe(false);
    expect(isLoopbackHttpBaseUrl("http://192.168.1.20:8319")).toBe(false);
    expect(isLoopbackHttpBaseUrl("ws://127.0.0.1:8319")).toBe(false);
    expect(isLoopbackHttpBaseUrl("not a url")).toBe(false);
    expect(isLoopbackHttpBaseUrl(null)).toBe(false);
    expect(isLoopbackHttpBaseUrl(undefined)).toBe(false);
  });
});

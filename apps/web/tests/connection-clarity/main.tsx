import { useState } from "react";
import { createRoot } from "react-dom/client";
import * as Option from "effect/Option";
import { EnvironmentId, type ManagedUpdateStatus } from "@specweave-studio/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import { ManagedUpdatesView } from "../../src/components/settings/ManagedUpdatesSection";
import { ConnectionPathDetails } from "../../src/components/settings/EnvironmentRoutesList";
import { EnvironmentRow } from "../../src/components/settings/EnvironmentRow";
import { Switch } from "../../src/components/ui/switch";
import "./fixture.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const environmentId = EnvironmentId.make("m1");
const relay = {
  target: new RelayConnectionTarget({ environmentId, label: "M1" }),
  profile: Option.none(),
};
const direct = (id: string, url: string) => ({
  target: new BearerConnectionTarget({ environmentId, label: "M1", connectionId: id }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId,
      label: "M1",
      connectionId: id,
      httpBaseUrl: url,
      wsBaseUrl: url.replace(/^http/, "ws"),
    }),
  ),
});
const status: ManagedUpdateStatus = {
  environmentId,
  installationId: "fixture",
  support: "supported",
  localAutomation: "enabled",
  remoteConsent: params.has("approved") ? "enrolled" : "not-enrolled",
  revision: 0,
  operation: "up-to-date",
  currentVersion: "1.0.167",
  availableVersion: null,
  checkedAt: null,
};
function Fixture() {
  const [enabled, setEnabled] = useState(true);
  const [actions, setActions] = useState<string[]>([]);
  const record = (action: string) => () => setActions((a) => [...a, action]);
  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="mb-2 text-xl font-semibold">Connected machines</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Connection, update permission and agent work access are separate.
      </p>
      <div className="rounded-lg border border-border">
        <EnvironmentRow
          kind="laptop"
          label="m1"
          hostLabel="Office Mac"
          subtitle={
            enabled ? "Connected via SpecWithCode Connect" : "Disconnected from this device"
          }
          detail={
            <>
              <ManagedUpdatesView
                label="m1"
                reachable={enabled}
                status={status}
                error={false}
                canManage={params.has("admin")}
                canCheck
                pending={false}
                onAllow={record("grant")}
                onRevoke={record("revoke")}
                onCheck={record("check")}
                onRefresh={record("refresh")}
              />
              <section className="mt-3 rounded-lg border border-border p-3">
                <h2 className="mb-2 text-xs font-medium">Connection paths to m1</h2>
                <p className="mb-2 text-xs text-muted-foreground">
                  Tried in preference order. An address may forward through another machine.
                </p>
                {[
                  relay,
                  direct("forwarded", "https://m4.example.ts.net:8443/"),
                  direct("direct", "https://m1.example.ts.net/"),
                ].map((route, i) => (
                  <div key={i} className="border-t border-border py-2">
                    <ConnectionPathDetails
                      route={route}
                      destinationLabel="m1"
                      position={i + 1}
                      inUse={enabled && i === 0}
                    />
                  </div>
                ))}
              </section>
            </>
          }
        >
          <label className="flex max-w-28 items-center gap-2 text-xs text-muted-foreground sm:max-w-40">
            <span>Connect from this device</span>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Connect to m1 from this device"
              size="sm"
            />
          </label>
        </EnvironmentRow>
      </div>
      <div className="mt-4">
        <ManagedUpdatesView
          label="ministorm"
          reachable
          status={{ ...status, currentVersion: null, support: "unsupported" }}
          error={false}
          canManage={false}
          canCheck={false}
          pending={false}
          onAllow={record("unexpected")}
          onRevoke={record("unexpected")}
          onCheck={record("unexpected")}
          onRefresh={record("refresh-ministorm")}
        />
      </div>
      <output className="mt-4 block text-xs" data-testid="actions">
        {actions.join(",")}
      </output>
      <p className="mt-6 text-xs text-muted-foreground">
        Isolated fixture. Real row, update and route components; synthetic machines and actions. No
        live connections or permissions change.
      </p>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

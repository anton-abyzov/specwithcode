import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthStandardClientScopes, type AdvertisedEndpoint } from "@specweave-studio/contracts";
import { PairPhoneSettings } from "../../src/components/settings/PairPhoneSettings";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "../question-cards/fixture.css";
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const folded = params.get("folded") === "1";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const endpoint = (host: string): AdvertisedEndpoint =>
  ({
    id: `tailscale-magicdns:${host}`,
    label: "Private HTTPS",
    httpBaseUrl: `https://${host}/`,
    wsBaseUrl: `wss://${host}/`,
    reachability: "private-network",
    status: "available",
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    provider: { id: "tailscale", label: "Tailscale", kind: "core", isAddon: false },
    source: "desktop-core",
  }) as AdvertisedEndpoint;
function App() {
  const [address, setAddress] = useState<AdvertisedEndpoint | null>(endpoint("host.tail.ts.net"));
  const [allowed, setAllowed] = useState(true);
  const [access, setAccess] = useState(false);
  const [created, setCreated] = useState(0);
  return (
    <TooltipProvider>
      <ToastProvider>
        <AnchoredToastProvider>
          <main className="mx-auto max-w-2xl space-y-6 p-8">
            <h1 className="text-xl font-semibold">Connections · phone setup</h1>
            <PairPhoneSettings
              endpoint={address}
              serverEndpoints={[]}
              canCreateLinks={allowed}
              delegatableScopes={AuthStandardClientScopes.slice(0, 2)}
              hasAccessControls
              onPairingLinkCreated={() => setCreated((n) => n + 1)}
              onShowAccessSettings={() => setAccess(true)}
              folded={folded}
            />
            <aside className="space-x-2 text-xs">
              <button onClick={() => setAddress(endpoint("other.tail.ts.net"))}>
                Switch route
              </button>
              <button onClick={() => setAddress(null)}>Remove route</button>
              <button onClick={() => setAllowed(false)}>Revoke permission</button>
              <output>Created {created}</output>
              {access ? <p>Access settings opened</p> : null}
            </aside>
          </main>
        </AnchoredToastProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({ component: App }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);

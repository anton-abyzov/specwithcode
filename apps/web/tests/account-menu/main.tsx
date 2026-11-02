import { createRoot } from "react-dom/client";
import {
  AccountMenuView,
  type ConnectAccountActions,
} from "../../src/components/account/AccountMenu";
import { Sidebar, SidebarMenu, SidebarProvider } from "../../src/components/ui/sidebar";
import "./fixture.css";

// The account button in every Connect state, with the real view. Open it with
// ?state=local|unlinked|linked|signedIn&theme=light|dark.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const noop = () => {};
const actions = (account: ConnectAccountActions["account"]): ConnectAccountActions => ({
  account,
  onSignIn: noop,
  onManage: noop,
  onSignOut: noop,
});
const states: Record<string, ConnectAccountActions | null> = {
  local: null,
  unlinked: actions({ status: "signedOut", linked: false }),
  linked: actions({ status: "signedOut", linked: true }),
  signedIn: actions({ status: "signedIn", name: "Ada Lovelace", email: "ada@example.com" }),
};

createRoot(document.getElementById("root")!).render(
  <SidebarProvider>
    <Sidebar>
      <div className="mt-auto p-2">
        <SidebarMenu className="flex-row items-center">
          <AccountMenuView
            compact={params.get("compact") === "1"}
            machine="Ada's MacBook Pro"
            connect={states[params.get("state") ?? "local"] ?? null}
            usageShortcut="⌘U"
            pullRequestsSupported
            onNavigate={noop}
            onOpenPullRequests={noop}
            onAddDevice={noop}
          />
        </SidebarMenu>
      </div>
    </Sidebar>
  </SidebarProvider>,
);

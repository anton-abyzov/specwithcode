// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@specweave-studio/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const world = vi.hoisted(() => ({
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  email: null as string | null,
  link: {
    data: null as { linked: boolean; managedTunnelActive?: boolean } | null,
    isPending: false,
    error: null as string | null,
    target: { environmentId: "here" } as object | null,
  },
  operationError: null as string | null,
  publishAgentActivity: false,
  reconcile: vi.fn(),
  openSetup: vi.fn(),
  openApp: vi.fn(),
  scope: true,
  session: { _tag: "Success" },
  rulesLock: null as string | null,
  grants: [] as Array<{
    coordinatorEnvironmentId: string;
    machineLabel: string;
    status: string;
  }> | null,
  environments: [{ environmentId: "here" }] as Array<{ environmentId: string }>,
  discovered: [] as string[],
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => world.auth,
  useUser: () => ({
    user: world.email ? { primaryEmailAddress: { emailAddress: world.email } } : null,
  }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({
  useStudioConnectAuthPrompt: () => ({
    authPrompt: null,
    openAuthPrompt: world.openApp,
    openSetupAuthPrompt: world.openSetup,
  }),
}));
vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linkState: world.link,
    linked: world.link.data?.linked ?? false,
    publishAgentActivity: world.publishAgentActivity,
    operationError: world.operationError,
    reconcileCloudState: world.reconcile,
  }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => world.session },
  useEnvironmentScope: () => world.scope,
}));
vi.mock("../../teamRules/useTeamRules", () => ({ useTeamRules: () => ({ summary: undefined }) }));
vi.mock("../../teamRules/teamRulesView", () => ({ teamRulesReachLock: () => world.rulesLock }));
vi.mock("../../studio/fleet", () => ({
  useMachineWorkGrants: () => ({ snapshot: world.grants ? { grants: world.grants } : null }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: world.environments }),
  useRelayEnvironmentDiscovery: () => ({
    environments: new Map(
      world.discovered.map((id) => [id, { environment: { environmentId: id } }] as const),
    ),
  }),
}));
vi.mock("../settings/AccountJoinCard", () => ({
  AccountJoinCard: (props: { variant?: string; onSkip?: () => void; onDone?: () => void }) => (
    <div data-testid="join-card" data-variant={props.variant}>
      <button type="button" onClick={props.onSkip}>
        Skip
      </button>
      <button type="button" onClick={props.onDone}>
        Allow
      </button>
    </div>
  ),
}));

import { CONNECT_TURNED_OFF_STORAGE_KEY } from "../../cloud/connectOnboarding";
import {
  markConnectSignInStarted,
  readConnectSignInStarted,
} from "../../cloud/connectSignInStarted";
import { SignInFirstStep } from "./SignInFirstStep";

const here = EnvironmentId.make("here");
let root: Root;
let container: HTMLDivElement;
const onContinue = vi.fn();
const onOtherComputers = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  window.sessionStorage.clear();
  world.auth = { isLoaded: true, isSignedIn: false, userId: null };
  world.email = null;
  world.link = { data: null, isPending: false, error: null, target: { environmentId: "here" } };
  world.operationError = null;
  world.publishAgentActivity = false;
  world.scope = true;
  world.session = { _tag: "Success" };
  world.rulesLock = null;
  world.grants = [];
  world.environments = [{ environmentId: "here" }];
  world.discovered = [];
  // A request that works leaves the machine linked, as the server then reports it.
  world.reconcile.mockImplementation(async () => {
    world.link = { ...world.link, data: { linked: true, managedTunnelActive: true } };
    return true;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const step = () => (
  <SignInFirstStep
    environmentId={here}
    machineNoun="Mac"
    rulesKnown
    onContinue={onContinue}
    onOtherComputers={onOtherComputers}
  />
);
const render = () => act(async () => root.render(step()));
const signIn = (email = "ada@example.com") => {
  world.auth = { isLoaded: true, isSignedIn: true, userId: "user_1" };
  world.email = email;
};
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );
const row = (part: string) => container.querySelector<HTMLElement>(`[data-part="${part}"]`)!;
/** The filled buttons on screen: the step holds one at a time. */
const mainButtons = () =>
  [...container.querySelectorAll("button")]
    .filter((element) => /\bbg-primary\b/.test(element.className))
    .map((element) => element.textContent?.trim());

it("starts with one thing to do: sign in", async () => {
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("Set up this Mac");
  expect(row("sign-in").dataset.state).toBe("next");
  expect(row("link").textContent).toContain("Happens by itself after you sign in.");
  expect(row("machines").dataset.state).toBe("later");
  expect(mainButtons()).toEqual(["Sign in"]);
  expect(container.querySelector('[data-testid="join-card"]')).toBeNull();
  expect(world.reconcile).not.toHaveBeenCalled();

  await act(async () => button("Sign in")!.click());
  expect(world.openSetup).toHaveBeenCalledOnce();
  expect(world.openApp).not.toHaveBeenCalled();
});

it("works without an account", async () => {
  await render();
  await act(async () => button("Continue without an account")!.click());
  expect(onContinue).toHaveBeenCalledOnce();
  expect(world.reconcile).not.toHaveBeenCalled();
});

it("links this Mac by itself once signed in, and shows it as it happens", async () => {
  signIn();
  world.link.data = { linked: false };
  let finish!: (ok: boolean) => void;
  world.reconcile.mockImplementation(() => new Promise<boolean>((resolve) => (finish = resolve)));
  await render();
  expect(row("sign-in").textContent).toContain("Signed in as ada@example.com");
  expect(row("sign-in").dataset.state).toBe("done");
  expect(world.reconcile).toHaveBeenCalledExactlyOnceWith({ managedTunnel: true, publish: true });
  expect(row("link").textContent).toContain("Linking this Mac…");
  expect(mainButtons()).toEqual([]);

  world.link.data = { linked: true, managedTunnelActive: true };
  await act(async () => finish(true));
  expect(row("link").textContent).toContain("This Mac is linked");
  expect(row("link").dataset.state).toBe("done");
  expect(container.querySelector('[data-testid="join-card"]')?.getAttribute("data-variant")).toBe(
    "first-run",
  );
  // Rendering again never links a second time.
  await render();
  expect(world.reconcile).toHaveBeenCalledOnce();
});

it("links a session that a reloading sign-in left behind", async () => {
  // Signing in with Google reloads the window: the step mounts already signed in.
  signIn();
  world.link.data = { linked: false };
  await render();
  expect(world.reconcile).toHaveBeenCalledOnce();
  expect(row("link").textContent).toContain("This Mac is linked");
});

it("asks for the link once when the machine still reads as not linked", async () => {
  signIn();
  world.link.data = { linked: false };
  world.reconcile.mockImplementation(async () => true);
  await render();
  await render();
  expect(world.reconcile).toHaveBeenCalledOnce();
  expect(mainButtons()).toEqual(["Turn on SpecWithCode Connect"]);
});

it("waits for the link to be read before deciding", async () => {
  signIn();
  world.link.isPending = true;
  await render();
  expect(row("link").textContent).toContain("Checking this Mac…");
  expect(world.reconcile).not.toHaveBeenCalled();
});

it("shows a failed link with its reason and one way on, and does not retry by itself", async () => {
  signIn();
  world.link.data = { linked: false };
  world.reconcile.mockImplementation(async () => false);
  world.operationError = "The relay did not answer.";
  await render();
  expect(row("link").textContent).toContain("This Mac could not be linked");
  expect(row("link").textContent).toContain("The relay did not answer.");
  expect(mainButtons()).toEqual(["Try again"]);
  await render();
  expect(world.reconcile).toHaveBeenCalledOnce();

  world.reconcile.mockImplementation(async () => {
    world.link = { ...world.link, data: { linked: true } };
    return true;
  });
  await act(async () => button("Try again")!.click());
  expect(world.reconcile).toHaveBeenCalledTimes(2);
  expect(row("link").textContent).toContain("This Mac is linked");
  // Setup still goes on without the link.
  expect(button("Continue")).toBeDefined();
});

it("keeps Connect off where the owner turned it off, with one button to turn it on", async () => {
  signIn();
  world.link.data = { linked: false };
  window.localStorage.setItem(
    CONNECT_TURNED_OFF_STORAGE_KEY,
    JSON.stringify({ accounts: ["user_1"] }),
  );
  await render();
  expect(world.reconcile).not.toHaveBeenCalled();
  expect(row("link").textContent).toContain("SpecWithCode Connect is off on this Mac");
  expect(mainButtons()).toEqual(["Turn on SpecWithCode Connect"]);

  await act(async () => button("Turn on SpecWithCode Connect")!.click());
  expect(world.reconcile).toHaveBeenCalledExactlyOnceWith({ managedTunnel: true, publish: true });
  expect(row("link").textContent).toContain("This Mac is linked");
  expect(JSON.parse(window.localStorage.getItem(CONNECT_TURNED_OFF_STORAGE_KEY)!)).toEqual({
    accounts: [],
  });
});

it("keeps an activity choice when it turns the tunnel on for an existing link", async () => {
  signIn();
  world.link.data = { linked: true, managedTunnelActive: false };
  world.publishAgentActivity = false;
  await render();
  expect(world.reconcile).not.toHaveBeenCalled();
  await act(async () => button("Turn on SpecWithCode Connect")!.click());
  expect(world.reconcile).toHaveBeenCalledExactlyOnceWith({ managedTunnel: true, publish: false });
});

it("says why when Team rules or permissions keep Connect off, with no button", async () => {
  signIn();
  world.link.data = { linked: false };
  world.rulesLock = "locked";
  await render();
  expect(row("link").textContent).toContain("Team rules keep it off here");
  expect(button("Turn on SpecWithCode Connect")).toBeUndefined();
  expect(world.reconcile).not.toHaveBeenCalled();

  world.rulesLock = null;
  world.scope = false;
  await render();
  expect(row("link").textContent).toContain("This window is not allowed to turn it on.");
  expect(world.reconcile).not.toHaveBeenCalled();
  expect(mainButtons()).toEqual(["Continue"]);
});

it("makes the choice of a main machine the next action when the account has others", async () => {
  signIn();
  world.link.data = { linked: true };
  world.discovered = ["main"];
  await render();
  expect(row("machines").textContent).toContain("Pick it below and press Allow.");
  // The card holds Allow and Skip; a second Continue would be a second way on.
  expect(button("Continue")).toBeUndefined();
  await act(async () => button("Skip")!.click());
  expect(onContinue).toHaveBeenCalledOnce();
});

it("shows the machine that may start work here, and continues", async () => {
  signIn();
  world.link.data = { linked: true };
  world.discovered = ["main"];
  world.grants = [{ coordinatorEnvironmentId: "main", machineLabel: "Studio", status: "active" }];
  await render();
  expect(row("machines").textContent).toContain("Studio can start work on this Mac");
  expect(row("machines").dataset.state).toBe("done");
  expect(mainButtons()).toEqual(["Continue"]);
  await act(async () => button("Continue")!.click());
  expect(onContinue).toHaveBeenCalledOnce();
});

it("holds the way on once a machine is allowed, while others could still be", async () => {
  signIn();
  world.link.data = { linked: true };
  world.discovered = ["main", "second"];
  await render();
  expect(button("Continue")).toBeUndefined();
  // The card allows the machine and then shows that, with no Skip of its own.
  world.grants = [{ coordinatorEnvironmentId: "main", machineLabel: "Studio", status: "active" }];
  await act(async () => button("Allow")!.click());
  expect(row("machines").textContent).toContain("Studio can start work on this Mac");
  expect(mainButtons()).toEqual(["Continue"]);
});

it("keeps the way on when who may run work here cannot be read", async () => {
  signIn();
  world.link.data = { linked: true };
  world.discovered = ["main"];
  // The card draws no choice without that list, so its Skip is not there either.
  world.grants = null;
  await render();
  expect(row("machines").textContent).not.toContain("Pick it below");
  expect(mainButtons()).toEqual(["Continue"]);
});

it("opens with the way on before the side path, for the keyboard", async () => {
  signIn();
  world.link.data = { linked: true };
  await render();
  const labels = [...container.querySelectorAll("button")].map((element) =>
    element.textContent?.trim(),
  );
  expect(labels.indexOf("Continue")).toBeLessThan(labels.indexOf("Set up other computers too"));
});

it("continues on a first machine, where there is nothing to choose", async () => {
  signIn();
  world.link.data = { linked: true };
  await render();
  expect(row("machines").textContent).toContain("If this is your first machine");
  expect(mainButtons()).toEqual(["Continue"]);
});

it("offers the step that pairs other computers", async () => {
  await render();
  await act(async () => button("Set up other computers too")!.click());
  expect(onOtherComputers).toHaveBeenCalledOnce();
});

it("forgets a sign-in it opened when setup closes", async () => {
  await render();
  markConnectSignInStarted("setup");
  await act(async () => root.unmount());
  expect(readConnectSignInStarted()).toBeNull();
  root = createRoot(container);
});

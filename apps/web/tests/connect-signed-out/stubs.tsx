// What the signed-out banner reads from the window, answered by the fixture.
// Synthetic machines only. `?account=` is signed-out (default), signed-in,
// ending (signed in, 100 minutes left) or rejected (signed in, the relay refuses).
import { Atom } from "effect/reactivity";

const params = new URLSearchParams(location.search);
const account = params.get("account") ?? "signed-out";

export function useAuth() {
  return { isLoaded: true, isSignedIn: account !== "signed-out", userId: "user-fixture" };
}

/** Clerk's session: the ending state ends 100 minutes from load. */
const expireAt = new Date(Date.now() + (account === "ending" ? 100 : 6 * 24 * 60) * 60_000);
export function useSession() {
  return { session: account === "signed-out" ? null : { expireAt } };
}

export function useConnectRenew() {
  return () => {
    document.body.dataset.renewStarted = "true";
  };
}

export const connectSessionRejectedAtom = Atom.make(account === "rejected");

export function useStudioConnectAuthPrompt() {
  return {
    openAuthPrompt: () => {
      document.body.dataset.signInOpened = "true";
    },
  };
}

export const hasCloudPublicConfig = () => true;

export function useMachineNicknames() {
  return (environmentId: string, fallbackLabel?: string | null) => fallbackLabel ?? environmentId;
}

type Route = "local" | "relay" | "paired";
const machine = (environmentId: string, label: string, phase: string, route: Route) => ({
  environmentId,
  label,
  connection: { phase },
  entry: {
    enabled: true,
    target:
      route === "local"
        ? { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://127.0.0.1:8319" }
        : route === "paired"
          ? { _tag: "BearerConnectionTarget", connectionId: "lan" }
          : { _tag: "RelayConnectionTarget" },
    profile:
      route === "paired"
        ? {
            _tag: "Some",
            value: { _tag: "BearerConnectionProfile", httpBaseUrl: "https://mini.example.test/" },
          }
        : { _tag: "None" },
  },
});

export const FIXTURE_ENVIRONMENTS = [
  machine("env-laptop", "Laptop", "connected", "local"),
  machine("env-office", "Office Mac", "error", "relay"),
  machine("env-mini", "Mac mini", "connected", "paired"),
  machine("env-build", "Build box", "reconnecting", "relay"),
];

export function useEnvironments() {
  return { environments: FIXTURE_ENVIRONMENTS };
}

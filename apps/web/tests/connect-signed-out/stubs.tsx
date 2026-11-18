// What the signed-out banner reads from the window, answered by the fixture.
// Synthetic machines only. `?account=signed-in` is Clerk signed in.
const params = new URLSearchParams(location.search);

export function useAuth() {
  return { isLoaded: true, isSignedIn: params.get("account") === "signed-in" };
}

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

const machine = (environmentId: string, label: string, phase: string, local = false) => ({
  environmentId,
  label,
  connection: { phase },
  entry: {
    target: local
      ? { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://127.0.0.1:8319" }
      : { _tag: "RelayConnectionTarget" },
    profile: { _tag: "None" },
  },
});

export const FIXTURE_ENVIRONMENTS = [
  machine("env-laptop", "Laptop", "connected", true),
  machine("env-office", "Office Mac", "error"),
  machine("env-mini", "Mac mini", "connected"),
  machine("env-build", "Build box", "reconnecting"),
];

export function useEnvironments() {
  return { environments: FIXTURE_ENVIRONMENTS };
}

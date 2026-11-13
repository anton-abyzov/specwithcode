// What `?view=page` reads instead of a server, a SpecWithCode Connect account and the app's
// settings. `?state=` picks this machine's setup; see page.tsx for the list.
const params = new URLSearchParams(location.search);
export const pageState = params.get("state") ?? "add-phone";
export const ACCOUNT = "you@example.com";
const HERE = "env-m4";

const signedIn = !pageState.startsWith("sign-in") && pageState !== "no-connect";
const connectOn = pageState === "add-phone" || pageState === "done";
/** A browser at the machine's address: it shows the state and cannot change it. */
export const readOnlyWindow = pageState === "sign-in-browser";

export const hasCloudPublicConfig = () => pageState !== "no-connect";
export const useAuth = () => ({ isLoaded: true, isSignedIn: signedIn });
export const useUser = () => ({
  user: signedIn ? { primaryEmailAddress: { emailAddress: ACCOUNT } } : null,
});
export const useStudioConnectAuthPrompt = () => ({
  authPrompt: null,
  openAuthPrompt() {},
  openSetupAuthPrompt() {},
});
export const useRememberConnectChoice = () => () => undefined;
export const useCloudLinkController = () => ({
  isSignedIn: signedIn,
  linkState: { data: signedIn ? {} : null, isPending: false, error: null },
  linked: signedIn,
  managedTunnelActive: connectOn,
  publishAgentActivity: signedIn,
  holdWebhooksWhileOffline: false,
  operationError: null,
  reconcileCloudState: async () => true,
});
export const removeManagedRelayPhoneCommand = null;
export const useManagedRelayPhones = () => ({
  accountId: signedIn ? "account-1" : null,
  isPending: false,
  error: null,
  refresh() {},
  data:
    pageState === "done"
      ? [
          {
            deviceId: "phone-1",
            label: "iPhone 16",
            platform: "ios",
            model: "iPhone17,3",
            appVersion: "0.1.1",
            lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
            current: false,
          },
        ]
      : [],
});

export const usePrimaryEnvironmentId = () => HERE;
export const useEnvironment = () => ({
  environmentId: HERE,
  label: "MacBook Air",
  serverConfig: null,
});
export const useEnvironmentScope = () => !readOnlyWindow;
export const readEnvironmentScope = () => !readOnlyWindow;
export const useEnvironmentsWithScope = () => [];
export const useMachineNickname = (_id: string, label?: string) => label ?? "";
export const useCustomMachineNickname = () => null;
export const useMachineNameHolder = () => () => null;
export const useMachineIdentity = (environmentId: string | null) =>
  environmentId === null
    ? null
    : {
        environmentId,
        name: "MacBook Air",
        color: "teal",
        icon: "laptop",
        short: "MA",
        derivedShort: "MA",
      };
export const useRenameMachine = () => ({
  lock: null,
  rename: () => true,
  saveIdentity: () => true,
});
export const useTeamRules = () => ({ summary: undefined });
export const RenameMachineDialog = () => null;

const clientSettings = { onboardingMachineRole: null, machinePhoneStepDismissed: {} };
export const useClientSettings = (select: (settings: typeof clientSettings) => unknown) =>
  select(clientSettings);
export const useUpdateClientSettings = () => () => undefined;
export const usePrimarySettingsAvailable = () => true;
export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE = "";

const pageLocation = { pathname: "/settings/machines", hash: "", search: {}, state: {} };
export const useLocation = (options?: { select?: (location: typeof pageLocation) => unknown }) =>
  options?.select ? options.select(pageLocation) : pageLocation;
export const useNavigate = () => () => undefined;
export const useAtomCommand = () => async () => ({ _tag: "Success", value: undefined });
export const readPrimaryEnvironmentTarget = () => null;
export const createServerPairingCredential = async () => {
  throw new Error("The fixture has no server to make a pairing code.");
};
export const toastManager = { add: () => undefined };
export const stackedThreadToast = (toast: unknown) => toast;
export const useClearScopedSettings = () => async () => undefined;
export const useClearProjectOverrides = () => async () => undefined;

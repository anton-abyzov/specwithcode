// Which imports each fixture view swaps for a mock file. Shared by vite.config.ts and by
// build scripts that bundle the fixture from elsewhere.
const ROWS =
  /^@tanstack\/react-router$|^@effect\/atom-react$|\/(state\/(desktopNetworkAccess|entities|environments|session)|studio\/(fleet|machineNickname)|environments\/primary|confirmDialog|connection\/desktopLocal|lib\/machineStatus|studio\/shell\/HostLimits|usePrimaryFleet|MachineWorkGrants|HandoffModeSettings|RenameMachineDialog)$/;

// A machine's update card and its pause row, rendered from their views with no server behind them.
const UPDATE_CARD = /(ManagedUpdatesSection|UpdatePausePolicyRow)\.tsx$/;
const UPDATE_CARD_MOCKED =
  /^@effect\/atom-react$|\/(state\/(managedUpdates|query|session|server|use-atom-command)|studio\/machineNickname|confirmDialog|ServerUpdateAction|ui\/toast)$/;

// `?view=page`: the summary, the phone card, the pairing row and the Advanced fold, with
// this machine's SpecWithCode Connect state chosen by `?state=`.
const PAGE =
  /(MachineSummary|PhoneConnectSettings|PhoneDevicesSettings|PairPhoneSettings|ThisMachineAdvanced|settingsLayout)\.tsx$/;
const PAGE_MOCKED =
  /^@clerk\/react$|^@tanstack\/react-router$|\/(cloud\/(managedRelayState|publicConfig|useCloudLinkController|useRememberConnectChoice)|hooks\/useSettings|state\/(environments|session|use-atom-command)|studio\/machineNickname|teamRules\/useTeamRules|clerk\/useStudioConnectAuthPrompt|environments\/primary|RenameMachineDialog|useScopedSettings|ui\/toast)$/;

/** The mock file, relative to this folder, that stands in for `id` when `importer` asks for it. */
export function mockFor(id, importer = "") {
  if (importer.endsWith("MachinesSettings.tsx") && ROWS.test(id)) return "mocks.tsx";
  if (UPDATE_CARD.test(importer) && UPDATE_CARD_MOCKED.test(id)) return "mocks.tsx";
  if (PAGE.test(importer) && PAGE_MOCKED.test(id)) return "page-mocks.tsx";
  return null;
}

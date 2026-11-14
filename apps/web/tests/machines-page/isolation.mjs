// Which imports each fixture view swaps for a mock file. Shared by vite.config.ts and by
// build scripts that bundle the fixture from elsewhere.
const ROWS =
  /^@tanstack\/react-router$|^@effect\/atom-react$|\/(state\/(desktopNetworkAccess|entities|environments|session)|studio\/(fleet|machineNickname)|environments\/primary|confirmDialog|connection\/desktopLocal|lib\/machineStatus|studio\/shell\/HostLimits|usePrimaryFleet|MachineWorkGrants|HandoffModeSettings|RenameMachineDialog)$/;

// A machine's update card and its pause row, rendered from their views with no server behind them.
const UPDATE_CARD = /(ManagedUpdatesSection|UpdatePausePolicyRow)\.tsx$/;
const UPDATE_CARD_MOCKED =
  /^@effect\/atom-react$|\/(state\/(managedUpdates|query|session|server|use-atom-command)|studio\/machineNickname|confirmDialog|ServerUpdateAction|ui\/toast)$/;

// `?view=page` and `?view=add-device`: the summary, the add dialog, the phone card, the pairing row and the Advanced fold, with
// this machine's SpecWithCode Connect state chosen by `?state=`.
const PAGE =
  /(MachineSummary|AddDeviceDialog|PhoneConnectSettings|PhoneDevicesSettings|PairPhoneSettings|ThisMachineAdvanced|settingsLayout)\.tsx$/;
const PAGE_MOCKED =
  /^@clerk\/react$|^@tanstack\/react-router$|\/(cloud\/(managedRelayState|publicConfig|useCloudLinkController|useRememberConnectChoice)|hooks\/useSettings|state\/(environments|session|use-atom-command)|studio\/(machineNickname|machineIdentity|useRenameMachine)|teamRules\/useTeamRules|clerk\/useStudioConnectAuthPrompt|environments\/primary|RenameMachineDialog|useScopedSettings|ui\/toast)$/;

// `?scene=work`: the grant cards, rendered from their list view with no server behind them.
const GRANTS = /MachineWorkGrants\.tsx$/;
const GRANTS_MOCKED = /\/(studio\/(fleet|machineNickname)|state\/session|confirmDialog)$/;

// Machine colors: every Settings piece that wears one reads it from the same fixture,
// so a machine has one color across the cards, chips, grant pills and header.
const COLORED =
  /(MachineColor|MachineDot|MachineWorkSummary|MachinesSettings|MachineSummary)\.tsx$/;
const COLORED_MOCKED = /\/studio\/(machineIdentity|useRenameMachine)$/;
const COLOR_PICKER_MOCKED = /\/studio\/machineNickname$/;

// `?scene=send`: the Send to another machine… screen, with its server calls answered here.
const SEND_MOCKED =
  /(state\/(use-atom-command|sourceControl|entities|projectClones)|studio\/addToMachineCopy|\/HandoffCopyScope|client-runtime\/state\/runtime|client-runtime\/environment)$/;

/** The mock file, relative to this folder, that stands in for `id` when `importer` asks for it. */
export function mockFor(id, importer = "") {
  if (COLORED.test(importer) && COLORED_MOCKED.test(id)) return "identity-mocks.tsx";
  if (importer.endsWith("MachineColor.tsx") && COLOR_PICKER_MOCKED.test(id))
    return "identity-mocks.tsx";
  if (importer.endsWith("MachinesSettings.tsx") && ROWS.test(id)) return "mocks.tsx";
  if (UPDATE_CARD.test(importer) && UPDATE_CARD_MOCKED.test(id)) return "mocks.tsx";
  if (GRANTS.test(importer) && GRANTS_MOCKED.test(id)) return "mocks.tsx";
  if (PAGE.test(importer) && PAGE_MOCKED.test(id)) return "page-mocks.tsx";
  if (importer.endsWith("HandoffShare.tsx") && SEND_MOCKED.test(id)) return "send-mocks.tsx";
  return null;
}

// Stand-ins for the desktop shell, the setup header and the saved answer. The
// step and the callout are the app's own; only what they would save is faked.
export const isElectron = true;
export const FirstRunUpdateNotice = () => null;
export const StarOnGitHubLink = () => null;
export const useFullAccessRecommendation = () => {
  throw new Error("The fixture passes the answers in itself.");
};
export const useEnvironment = () => null;
export const usePrimaryEnvironmentId = () => null;
export const usePrimaryEnvironment = () => null;
// The Access rows' live readers. The rows' views take their state as props, so
// only module imports reach these.
export const useEnvironmentQuery = () => ({
  data: null,
  error: null,
  isPending: false,
  refresh() {},
});
export const useAtomCommand = () => async () => ({ _tag: "Success", value: {} });
export const projectWorkspace = new Proxy({}, { get: () => () => null });
export const canUseExternalBrowsers = () => false;
export const openUrlInExternalBrowser = async () => undefined;
export const readChromeProfiles = async () => null;
export const clearClipboardIfText = async () => false;
export const FullDiskAccessRow = () => null;
/** 1386's first-run item as it draws on a Mac that has not allowed it yet. */
export function FirstRunFullDiskAccess() {
  return (
    <details
      data-slot="first-run-fda"
      className="mt-3 rounded-xl border border-border bg-card p-4 text-sm"
    >
      <summary className="cursor-pointer font-semibold text-foreground">
        Full Disk Access for agents (optional)
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          Lets agents read files macOS protects, such as Mail and Messages data, on M4 Max.
        </p>
        <button type="button" className="rounded-md border border-border px-2 py-1 text-xs">
          Open System Settings
        </button>
      </div>
    </details>
  );
}

/* Synthetic update state only. No desktop bridge, update agent, server or install is real. */
import type { ReactNode } from "react";
import { Atom } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";

const scene = new URLSearchParams(location.search).get("scene") ?? "restart";

export const receipts = {
  prepareCalls: [] as unknown[],
  installCalls: [] as unknown[],
  updateServerCalls: [] as unknown[],
};
(window as unknown as { __updateSurfaceReceipts: typeof receipts }).__updateSurfaceReceipts =
  receipts;

// env
export const isElectron = true;

// Desktop update: 1.0.25 has downloaded and only waits for a restart.
const desktopState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.24",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.0.25",
  downloadedVersion: "1.0.25",
  releaseNotes: [
    {
      version: "1.0.25",
      items: [
        "Warns before an update restart cuts off running jobs",
        "Resumes threads stopped for a server update",
        "Bulk Stop all / Continue all",
      ],
      totalItems: 5,
    },
  ],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: "2026-10-15T12:00:00Z",
  message: null,
  errorContext: null,
  canRetry: false,
};
export const useDesktopUpdateState = () => (scene === "restart" ? desktopState : null);
// No Studio service update waits, so the button is an app restart alone.
export const useStudioServiceUpdateState = () => null;

// A fake bridge: every call is recorded and nothing installs.
(window as unknown as { desktopBridge: unknown }).desktopBridge = {
  getUpdateState: async () => desktopState,
  onUpdateState: () => () => {},
  getUpdatePreferences: async () => ({
    automaticUpdatesAllowed: true,
    installAutomatically: false,
    downloadAutomatically: true,
  }),
  installUpdate: async (options: unknown) => {
    receipts.installCalls.push(options ?? null);
    return { accepted: false, failed: false };
  },
  openExternal: async () => true,
};

// Running work the restart would cut off.
const blockers = [
  {
    kind: "run",
    count: 3,
    threadId: "t1",
    threadTitle: "Fix login",
    projectId: "p",
    projectTitle: "EasyChamp",
  },
  {
    kind: "queued",
    count: 1,
    threadId: "t2",
    threadTitle: "Docs",
    projectId: "p",
    projectTitle: "EasyChamp",
  },
];

// state/use-atom-command
export const useAtomCommand = (command: string) => async (args: unknown) => {
  if (command === "prepareServiceUpdate") {
    receipts.prepareCalls.push(args);
    return { _tag: "Success", value: { idle: false, held: false, stoppedThreads: 0, blockers } };
  }
  if (command === "updateServer") receipts.updateServerCalls.push(args);
  return { _tag: "Success", value: { targetVersion: "1.0.25" } };
};

// state/server
const atoms = new Map<string, Atom.Atom<unknown>>();
const fixtureAtom = <A,>(key: string, value: A) => {
  if (!atoms.has(key)) atoms.set(key, Atom.make(value as unknown));
  return atoms.get(key) as Atom.Atom<A>;
};
export const serverEnvironment = {
  updateStateAtom: (id: string) => fixtureAtom(`update:${id}`, { status: "idle" }),
  prepareServiceUpdate: "prepareServiceUpdate",
  updateServer: "updateServer",
};
export const updateOutdatedServer = "updateOutdatedServer";

// state/session: an authenticated session allowed to maintain the server.
export const environmentSession = {
  sessionStateAtom: (id: string) =>
    fixtureAtom(
      `session:${id}`,
      AsyncResult.success({ authenticated: true, permissions: ["environment:maintain"] }),
    ),
};

// hooks/useSettings
export const useEnvironmentSettings = (
  _id: string,
  select: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown,
) => select(DEFAULT_SERVER_SETTINGS);

// state/environments
export const usePrimaryEnvironmentId = () => "host";
export const useEnvironments = () => ({
  isReady: true,
  environments: [{ environmentId: "remote", label: "Build box" }],
  presentationById: new Map(),
});

// state/entities: one remote server running an older version.
const serverConfig = (serverSelfUpdate: string | null) => ({
  environment: {
    environmentId: "remote",
    label: "Build box",
    serverVersion: "1.0.20",
    capabilities: { serverSelfUpdate, desktopAppUpdate: false },
  },
});
export const useServerConfigs = () =>
  scene === "server"
    ? new Map([["remote", serverConfig("boot-service")]])
    : scene === "server-none"
      ? new Map([["remote", serverConfig(null)]])
      : new Map();

// @tanstack/react-router (toasts read route params)
export const useParams = () => ({});
export const useNavigate = () => () => {};
export const useRouter = () => ({});
export const Link = ({ children, to }: { children?: ReactNode; to?: string }) => (
  <a href={to}>{children}</a>
);

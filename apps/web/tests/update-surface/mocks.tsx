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
  // A restart asks the feed for the newest release first; 1.0.25 already is.
  checkForUpdate: async () => ({ checked: true, state: desktopState }),
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

// state/server: every server's update starts idle; the runner switches it to running or
// failed through fixture.tsx.
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
// Project-clone atoms (via ProjectFavicon) read this lazily; nothing streams configs here.
export const environmentServerConfigsAtom = Atom.make(new Map());

// state/session: an authenticated session allowed to maintain the server.
export const environmentSession = {
  sessionStateAtom: (id: string) =>
    fixtureAtom(
      `session:${id}`,
      AsyncResult.success({ authenticated: true, permissions: ["environment:maintain"] }),
    ),
};

// hooks/useSettings: "Continue threads after restarts" is on only in server-continue.
export const useEnvironmentSettings = (
  _id: string,
  select: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown,
) =>
  select({
    ...DEFAULT_SERVER_SETTINGS,
    continueThreadsAfterServerUpdate: scene === "server-continue",
  });

// state/entities: a remote server running an older version. In the desktop,
// continue and nightly scenes a second server is not behind this app, so it
// shows no row and the outdated one is named by its machine. In the desktop and
// continue scenes it runs 1.0.25, this app's version. In the nightly scene this
// app runs 1.0.67-nightly.20261021.882 (serve.mjs) and the second server 1.0.67:
// unless both are nightly builds, the check compares only x.y.z (versionSkew.ts),
// so 1.0.67 is not behind and 1.0.66 is.
const serverConfig = (
  environmentId: string,
  label: string,
  serverVersion: string,
  capabilities: {
    readonly serverSelfUpdate: string | null;
    readonly desktopAppUpdate?: boolean;
    readonly serverUpdateThreadContinuation?: boolean;
  },
) => ({
  environment: {
    environmentId,
    label,
    serverVersion,
    capabilities: { desktopAppUpdate: false, ...capabilities },
  },
});
const current = serverConfig("current", "Build box", "1.0.25", {
  serverSelfUpdate: "boot-service",
});
const configs: Record<string, ReadonlyArray<ReturnType<typeof serverConfig>>> = {
  server: [serverConfig("remote", "Build box", "1.0.20", { serverSelfUpdate: "boot-service" })],
  "server-none": [serverConfig("remote", "Build box", "1.0.20", { serverSelfUpdate: null })],
  "server-desktop": [
    serverConfig("remote", "ministorm", "1.0.20", {
      serverSelfUpdate: "desktop-managed",
      desktopAppUpdate: true,
    }),
    current,
  ],
  "server-continue": [
    serverConfig("remote", "Office Mac mini build box", "1.0.20", {
      serverSelfUpdate: "respawn",
      serverUpdateThreadContinuation: true,
    }),
    current,
  ],
  "server-nightly": [
    serverConfig("remote", "Build box", "1.0.66", { serverSelfUpdate: "boot-service" }),
    serverConfig("current", "ministorm", "1.0.67", { serverSelfUpdate: "boot-service" }),
  ],
};
export const useServerConfigs = () =>
  new Map((configs[scene] ?? []).map((config) => [config.environment.environmentId, config]));
// The restart dialog groups running work by project; unknown projects get a folder icon.
export const useProjects = () => [];

// state/environments
export const usePrimaryEnvironmentId = () => "host";
export const useEnvironments = () => ({
  isReady: true,
  environments: (configs[scene] ?? []).map(({ environment }) => ({
    environmentId: environment.environmentId,
    label: environment.label,
  })),
  presentationById: new Map(),
});

// @tanstack/react-router (toasts read route params)
export const useParams = () => ({});
export const useNavigate = () => () => {};
export const useRouter = () => ({});
export const Link = ({ children, to }: { children?: ReactNode; to?: string }) => (
  <a href={to}>{children}</a>
);

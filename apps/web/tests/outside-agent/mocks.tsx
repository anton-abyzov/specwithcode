import * as Option from "effect/Option";
import { EnvironmentId } from "@specweave-studio/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
export const environmentId = EnvironmentId.make("fixture-m4");
const bearer = (connectionId: string, httpBaseUrl: string) => ({
  target: new BearerConnectionTarget({ environmentId, label: "Fixture M4", connectionId }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId,
      label: "Fixture M4",
      connectionId,
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
    }),
  ),
});
const preferred = bearer("preferred", "http://127.0.0.1:8319");
const active = bearer("active", "https://active.example.test");
export const fixtureEnvironment = {
  environmentId,
  label: "Fixture M4",
  entry: {
    ...preferred,
    enabled: true,
    alternateRoutes: [
      active,
      {
        target: new RelayConnectionTarget({ environmentId, label: "Fixture M4" }),
        profile: Option.none(),
      },
    ],
  },
  connection: { phase: "connected", traceId: null, error: null },
  serverConfig: null,
  displayUrl: "https://active.example.test",
};
export const usePreparedConnection = () =>
  Option.some({
    target:
      new URLSearchParams(location.search).get("route") === "relay"
        ? fixtureEnvironment.entry.alternateRoutes[1]!.target
        : active.target,
  });
export const useRelayEnvironmentDiscovery = () => ({
  environments: new Map([
    [
      environmentId,
      {
        status: Option.none(),
        environment: { endpoint: { httpBaseUrl: "https://public.connect.example.test" } },
      },
    ],
  ]),
});
const providers = [
  {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
  },
];
export const useAtomValue = <T,>(value: T) => value;
export const EMPTY_SERVER_PROVIDERS = [];
export const serverEnvironment = {
  providersValueAtom: () => providers,
  updateStateAtom: () => ({ status: "idle" }),
};
export const useEnvironmentScope = () => true;
export const useCoordinatorProvider = () => null;
export const machineHandoff = { readiness: "fixture-readiness" };
let checks = 0;
const check = async () => {
  checks++;
  (window as unknown as { readinessChecks: number }).readinessChecks = checks;
  return {
    _tag: "Success",
    value: {
      checkedAt: "2026-10-29T04:00:00Z",
      folder: "/fixture/project",
      github: { status: "signed-in", accounts: [], detail: null },
      repositories: [],
      repositoriesTruncated: false,
      tools: [],
      credentialHelper: { status: "missing", usesGh: false },
    },
  };
};
export const useAtomCommand = () => check;
export const squashAtomCommandFailure = (value: unknown) => value;
export const GitHubCredentialCard = () => null;
export const useGitHubCredentialCardAvailable = () => false;
export const ProviderAuthenticationSection = () => null;

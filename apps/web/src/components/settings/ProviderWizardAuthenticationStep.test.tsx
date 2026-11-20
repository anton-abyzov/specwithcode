// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  auth: null as ProviderAuthState | null,
  queryError: null as string | null,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.auth, error: state.queryError }),
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: (environmentId: unknown) => environmentId,
    providerAuthState: (target: unknown) => target,
  },
}));
// The real row reads app settings; only its description and control matter here.
vi.mock("./settingsLayout", () => ({
  SettingsRow: (props: { readonly description?: unknown; readonly control?: unknown }) => (
    <div data-settings-row>
      {props.description as never}
      {props.control as never}
    </div>
  ),
}));
vi.mock("./ProviderAuthenticationSection", () => ({
  ProviderAuthenticationSection: (props: { readonly environmentLabel: string }) => (
    <div data-account-row>{`Account row for ${props.environmentLabel}`}</div>
  ),
}));

import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";

const instanceId = ProviderInstanceId.make("gemini-m3");
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("acpRegistry"),
  displayName: "Gemini CLI",
  enabled: true,
  installed: true,
  version: "0.69.0",
  status: "ready",
  auth: { status: "unknown" },
  setup: { canAuthenticate: true, canInstall: false },
  checkedAt: "2026-11-20T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
} as ServerProvider;
const auth = (patch: Partial<ProviderAuthState> = {}): ProviderAuthState => ({
  instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
  methods: [{ id: "oauth-personal", name: "Log in with Google", type: "agent", description: null }],
  ...patch,
});

let renderer: ReactTestRenderer;
const finish = vi.fn();
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
function render() {
  act(() => {
    renderer = create(
      <ProviderWizardAuthenticationStep
        environmentId={EnvironmentId.make("m3")}
        environmentLabel="m3"
        instanceId={instanceId}
        onFinish={finish}
      />,
    );
  });
  const buttons = renderer.root.findAll((node) => node.type === "button");
  return { shown: text(renderer.root), footer: buttons.at(-1)! };
}

beforeEach(() => {
  state.providers = [provider];
  state.auth = auth();
  state.queryError = null;
  finish.mockReset();
});
afterEach(() => act(() => renderer?.unmount()));

describe("Add provider, Sign in step, for a remote machine", () => {
  it("offers Done with nothing to skip when the provider is already verified on that machine", () => {
    state.providers = [{ ...provider, auth: { status: "authenticated" } }];
    const { shown, footer } = render();
    expect(text(footer)).toBe("Done");
    expect(shown).not.toContain("Skip");
    act(() => footer.props.onClick());
    expect(finish).toHaveBeenCalledOnce();
  });

  it("offers Done after a late success, whatever the earlier failure said", () => {
    state.auth = auth({ phase: "failed", message: "The ACP agent could not complete sign-in." });
    expect(text(render().footer)).toBe("Skip for now");
    act(() => renderer.unmount());
    state.providers = [{ ...provider, auth: { status: "authenticated" } }];
    const { shown, footer } = render();
    expect(text(footer)).toBe("Done");
    expect(shown).not.toContain("could not complete sign-in");
  });

  it("explains Skip for a provider that is installed but not signed in", () => {
    const { shown, footer } = render();
    expect(text(footer)).toBe("Skip for now");
    expect(shown).toContain("Account row for m3");
    expect(shown).toContain(
      "Skip keeps this provider on m3 without a sign-in. It cannot run threads there until you sign in under Settings > Providers.",
    );
    expect(shown).not.toContain("Done");
  });

  it("does not take a finished browser page or an install for a sign-in", () => {
    state.auth = auth({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" });
    expect(text(render().footer)).toBe("Skip for now");
    act(() => renderer.unmount());
    state.providers = [{ ...provider, auth: { status: "unauthenticated" } }];
    state.auth = auth({ phase: "succeeded" });
    expect(text(render().footer)).toBe("Skip for now");
  });

  it("names the machine when its sign-in state cannot be read", () => {
    state.auth = null;
    state.queryError = "Request timed out";
    const { shown, footer } = render();
    expect(shown).toContain("Could not read the sign-in state on m3. Request timed out");
    expect(shown).not.toContain("No in-app sign-in advertised");
    expect(shown).not.toContain("Account row for m3");
    expect(text(footer)).toBe("Skip for now");
  });

  it("keeps the Account row, and its next action, for a failure that listed no methods", () => {
    state.auth = auth({ phase: "failed", methods: [], message: "Prepare it.", retryable: false });
    const { shown, footer } = render();
    expect(shown).toContain("Account row for m3");
    expect(text(footer)).toBe("Skip for now");
  });

  it("keeps Skip disabled while a sign-in is running", () => {
    state.auth = auth({ phase: "verifying" });
    expect(render().footer.props.disabled).toBe(true);
  });

  it("says the state is unknown while that machine has not reported the provider", () => {
    state.providers = [];
    state.auth = null;
    const { shown, footer } = render();
    expect(shown).toContain(
      "Waiting for m3 to report this provider. Its sign-in state is not known yet.",
    );
    expect(shown).not.toContain("No in-app sign-in advertised");
    expect(shown).not.toContain("Discovering");
    expect(text(footer)).toBe("Skip for now");
  });
});

// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderAuthState,
} from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./CopilotInstallAgentButton", () => ({
  CopilotInstallAgentButton: (props: { instanceId: string }) => (
    <button data-install-agent={props.instanceId} type="button" />
  ),
}));

import {
  readMachineToolInstallRequest,
  closeMachineToolInstall,
} from "../machineTools/machineToolInstallRequest";
import {
  COPILOT_HOST_UNTOUCHED,
  COPILOT_INSTALL_ACTION,
  CopilotSignInHints,
  COPILOT_NEEDS_NODE_PREFIX,
  copilotHostOptions,
  normalizeGitHubHost,
  pickedCopilotHost,
  type CopilotHostChoice,
} from "./CopilotSignInHints";

const ENV = EnvironmentId.make("win");
let renderer: ReactTestRenderer;
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");


function render(props: Partial<Parameters<typeof CopilotSignInHints>[0]>) {
  act(() => {
    renderer = create(
      <CopilotSignInHints
        environmentId={ENV}
        environmentLabel="win"
        instanceId={ProviderInstanceId.make("copilot")}
        found={undefined}
        message={null}
        readOnly={false}
        {...props}
      />,
    );
  });
}

afterEach(() => {
  act(() => renderer?.unmount());
  closeMachineToolInstall();
});

describe("Copilot sign-in hints", () => {
  it("offers Install Node.js when Copilot CLI cannot run without it", () => {
    render({ message: `${COPILOT_NEEDS_NODE_PREFIX} SpecWithCode can install it.` });
    const button = renderer.root.find((node) => node.type === "button");
    act(() => button.props.onClick());
    expect(readMachineToolInstallRequest()).toEqual({
      environmentId: ENV,
      tool: "node",
      machineLabel: "win",
      neededBy: "copilot",
    });
  });

  it("has no button for someone who may not change that machine", () => {
    render({ message: COPILOT_NEEDS_NODE_PREFIX, readOnly: true });
    expect(renderer.root.findAll((node) => node.type === "button")).toEqual([]);
  });

  it("names the sign-ins the machine already has and the enterprise host the code goes to", () => {
    render({
      found: {
        vscodeCopilot: true,
        ghAccounts: [{ host: "aaby.ghe.com", account: "anton_aaby" }],
      },
    });
    const shown = text(renderer.root);
    expect(shown).toContain("GitHub Copilot in VS Code");
    expect(shown).toContain("GitHub CLI signed in as anton_aaby on aaby.ghe.com");
    expect(shown).toContain("the code goes to aaby.ghe.com");
  });

  it("shows nothing when there is nothing to say", () => {
    render({ found: { vscodeCopilot: false, ghAccounts: [] }, message: "Other failure." });
    expect(renderer.toJSON()).toBeNull();
  });

  it("offers Install / update agent in place when Copilot CLI is missing, old or unreadable", () => {
    render({
      message: `Could not read which Copilot CLI version is installed. Use ${COPILOT_INSTALL_ACTION} (here or in Settings > Providers), then sign in again.`,
    });
    expect(
      renderer.root.findAll((node) => node.props["data-install-agent"] === "copilot"),
    ).toHaveLength(1);
    render({ message: `Not installed. Use ${COPILOT_INSTALL_ACTION}.`, readOnly: true });
    expect(renderer.root.findAll((node) => node.props["data-install-agent"] !== undefined)).toEqual(
      [],
    );
  });

  it("lets the person pick github.com, a gh enterprise host or a typed host", () => {
    let host: CopilotHostChoice = COPILOT_HOST_UNTOUCHED;
    const draw = () =>
      render({
        found: {
          vscodeCopilot: false,
          ghAccounts: [
            { host: "github.com", account: "anton-abyzov" },
            { host: "aaby.ghe.com", account: "anton_aaby" },
          ],
        },
        host,
        onHostChange: (next) => {
          host = next;
        },
      });
    draw();
    const buttons = () =>
      renderer.root.findAll((node) => node.type === "button" && "aria-pressed" in node.props);
    expect(buttons().map(text)).toEqual(["github.com", "aaby.ghe.com", "Other enterprise host"]);
    // With both hosts on gh, the untouched default stays github.com, as on the server.
    expect(buttons()[0]!.props["aria-pressed"]).toBe(true);
    expect(text(renderer.root)).toContain("Sign-in goes to github.com");
    act(() => buttons()[1]!.props.onClick());
    expect(pickedCopilotHost(host)).toBe("aaby.ghe.com");
    draw();
    expect(buttons()[1]!.props["aria-pressed"]).toBe(true);
    expect(text(renderer.root)).toContain("Sign-in goes to aaby.ghe.com");
    act(() => buttons()[2]!.props.onClick());
    host = { choice: "other", typed: "https://Acme.GHE.com/" };
    draw();
    expect(renderer.root.findAll((node) => node.type === "input")).toHaveLength(1);
    expect(text(renderer.root)).toContain("Sign-in goes to acme.ghe.com");
  });

  it("shows the host choice on a fresh machine with no other sign-in", () => {
    render({
      found: { vscodeCopilot: false, ghAccounts: [] },
      host: COPILOT_HOST_UNTOUCHED,
      onHostChange: () => {},
    });
    expect(text(renderer.root)).toContain("GitHub host");
    expect(text(renderer.root)).not.toContain("Already on");
  });
});

describe("GitHub host helpers", () => {
  it("normalizes hosts and refuses anything that is not a bare https host", () => {
    expect(normalizeGitHubHost(" Acme.GHE.com ")).toBe("acme.ghe.com");
    expect(normalizeGitHubHost("https://acme.ghe.com")).toBe("acme.ghe.com");
    for (const bad of ["", "acme", "http://acme.ghe.com", "acme.ghe.com/x", "acme.ghe.com:444"])
      expect(normalizeGitHubHost(bad)).toBeUndefined();
  });
  it("sends no host until the person picks one, and nothing while a typed host is invalid", () => {
    expect(pickedCopilotHost(COPILOT_HOST_UNTOUCHED)).toBeUndefined();
    expect(pickedCopilotHost({ choice: "github.com", typed: "" })).toBe("github.com");
    expect(pickedCopilotHost({ choice: "other", typed: "not a host" })).toBeNull();
  });
  it("lists github.com first, then each enterprise host once", () => {
    expect(
      copilotHostOptions({
        vscodeCopilot: false,
        ghAccounts: [
          { host: "aaby.ghe.com", account: "a" },
          { host: "aaby.ghe.com", account: "b" },
        ],
      }),
    ).toEqual(["github.com", "aaby.ghe.com"]);
  });
});

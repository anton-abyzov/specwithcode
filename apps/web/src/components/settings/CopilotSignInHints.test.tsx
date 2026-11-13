// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderAuthState,
} from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  readMachineToolInstallRequest,
  closeMachineToolInstall,
} from "../machineTools/machineToolInstallRequest";
import { CopilotSignInHints, COPILOT_NEEDS_NODE_PREFIX } from "./CopilotSignInHints";

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
});

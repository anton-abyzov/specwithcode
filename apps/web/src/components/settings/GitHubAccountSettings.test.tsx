// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GitHubAccountSettings } from "./GitHubAccountSettings";

const state = vi.hoisted(() => ({ signInAvailable: true }));
vi.mock("../../hooks/useSettings", () => ({ useEnvironmentSettings: () => ({}) }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => ({}) }));
vi.mock("./GitHubCredentialCard", () => ({
  useGitHubCredentialCardAvailable: () => state.signInAvailable,
}));

let root: Root;
let container: HTMLDivElement;
const mount = async () =>
  act(async () =>
    root.render(
      <GitHubAccountSettings
        environmentId={"ministorm" as never}
        environmentLabel="ministorm"
        auth={{ status: "unauthenticated", accounts: [] } as never}
        onSaved={() => {}}
      />,
    ),
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.signInAvailable = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("points to the sign-in above, with gh auth login as the alternative", async () => {
  await mount();
  expect(container.textContent).toContain("Sign in above, or with gh auth login on ministorm");
});

it("gives the plain gh hint when the machine cannot be signed in from here", async () => {
  state.signInAvailable = false;
  await mount();
  expect(container.textContent).toContain("Sign in with gh auth login on ministorm");
  expect(container.textContent).not.toContain("Sign in above");
});

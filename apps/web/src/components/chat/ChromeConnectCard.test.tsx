import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
import { ChromeConnectCard } from "./ChromeConnectCard";

vi.mock("../../state/environments", () => ({ useEnvironment: () => ({ label: "M4 Max" }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; search: unknown }) => (
    <a href={props.to} data-search={props.search} />
  ),
}));

it("links to the thread machine's Chrome settings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("m4");
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(<ChromeConnectCard environmentId={environmentId} />);
  });
  expect(JSON.stringify(renderer.toJSON())).toMatch(/Chrome is not connected on ","M4 Max/);
  const link = renderer.root.findAll((node) => node.props.to === "/settings/chrome")[0]!;
  expect(link.props.search).toEqual({ machine: environmentId });
  await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

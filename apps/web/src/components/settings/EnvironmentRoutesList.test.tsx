import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId } from "@specweave-studio/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
vi.mock("~/connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("~/state/session", () => ({ usePreparedConnection: () => Option.none() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/cloud/connectRoutePlan", () => ({
  beginConnectRouteRemoval: vi.fn(),
  endConnectRouteRemoval: vi.fn(),
}));
vi.mock("~/studio/machineNickname", () => ({
  useMachineNickname: (_id: string, label?: string | null) => label ?? "",
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: vi.fn() }));
import { ConnectionPathDetails } from "./EnvironmentRoutesList";
const environmentId = EnvironmentId.make("m1");
const route = {
  target: new BearerConnectionTarget({ environmentId, label: "M1", connectionId: "forwarded" }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId,
      label: "M1",
      connectionId: "forwarded",
      httpBaseUrl: "https://m4.example.ts.net:8443/",
      wsBaseUrl: "wss://m4.example.ts.net:8443/",
    }),
  ),
};
describe("connection path identity", () => {
  it("separates the destination from a forwarding host without inventing its topology", () => {
    const html = renderToStaticMarkup(
      <ConnectionPathDetails route={route} destinationLabel="M1" position={2} inUse={false} />,
    );
    expect(html).toContain("Destination: M1");
    expect(html).toContain("Address: https://m4.example.ts.net:8443/");
    expect(html).toContain("Saved alternative");
    expect(html).toContain("Identity checked when connecting");
    expect(html).not.toContain("Identity verified");
    expect(html).not.toContain("Connected to: m4");
  });
  it("only calls the active session verified", () => {
    const html = renderToStaticMarkup(
      <ConnectionPathDetails route={route} destinationLabel="M1" position={1} inUse />,
    );
    expect(html).toContain("Connected to: M1");
    expect(html).toContain("In use");
    expect(html).toContain("Identity verified by the current connection");
    expect(html).not.toContain("Saved alternative");
  });
  it("describes Connect without inventing a direct address", () => {
    const relay = {
      target: new RelayConnectionTarget({ environmentId, label: "M1" }),
      profile: Option.none(),
    };
    const html = renderToStaticMarkup(
      <ConnectionPathDetails route={relay} destinationLabel="M1" position={1} inUse />,
    );
    expect(html).toContain("SpecWithCode Connect");
    expect(html).toContain("Connected to: M1");
    expect(html).not.toContain("Address:");
  });
});

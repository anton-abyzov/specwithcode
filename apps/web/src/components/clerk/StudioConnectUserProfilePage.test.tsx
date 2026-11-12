import type { EnvironmentId } from "@specweave-studio/contracts";
import type { RelayClientEnvironmentRecord } from "@specweave-studio/contracts/relay";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  connectMachineCountLabel,
  orderConnectMachines,
  StudioConnectEnvironmentRow,
  StudioConnectMachinesView,
} from "./StudioConnectUserProfilePage";

const machine = (
  id: string,
  label: string,
  overrides: Partial<RelayClientEnvironmentRecord> = {},
): RelayClientEnvironmentRecord => ({
  environmentId: id as EnvironmentId,
  label,
  endpoint: {
    httpBaseUrl: "https://studio.example.com",
    wsBaseUrl: "wss://studio.example.com",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-08-12T12:00:00.000Z",
  ...overrides,
});

const environment = machine("environment-1", "Studio Mac");

function renderRow({
  confirmationOpen = false,
  current = false,
  mutationPending = false,
  failure = null,
}: {
  readonly confirmationOpen?: boolean;
  readonly current?: boolean;
  readonly mutationPending?: boolean;
  readonly failure?: string | null;
} = {}) {
  return renderToStaticMarkup(
    <StudioConnectEnvironmentRow
      environment={environment}
      current={current}
      confirmationOpen={confirmationOpen}
      mutationPending={mutationPending}
      failure={failure}
      onConfirmationChange={vi.fn()}
      onDeregister={vi.fn()}
    />,
  );
}

function renderView(
  overrides: Partial<Parameters<typeof StudioConnectMachinesView>[0]> = {},
): string {
  return renderToStaticMarkup(
    <StudioConnectMachinesView
      environments={[environment]}
      currentEnvironmentId={null}
      loading={false}
      refreshing={false}
      error={null}
      confirmingEnvironmentId={null}
      deregisteringEnvironmentId={null}
      onRefresh={vi.fn()}
      onConfirmationChange={vi.fn()}
      onDeregister={vi.fn()}
      {...overrides}
    />,
  );
}

describe("Studio Connect machine row", () => {
  it("keeps deregistration confirmation inline and collapsed by default", () => {
    const markup = renderRow();

    expect(markup).toContain("Studio Mac");
    expect(markup).toContain("Deregister");
    expect(markup).not.toContain("Deregister machine");
    expect(markup).not.toContain("Confirm deregistration of Studio Mac");
  });

  it("names the machine on its button and marks the date up as a date", () => {
    const markup = renderRow();

    expect(markup).toContain('aria-label="Deregister Studio Mac"');
    expect(markup).toContain('<time dateTime="2026-08-12T12:00:00.000Z">');
    expect(markup).toContain("Managed tunnel");
  });

  it("keeps red for the confirmation: the row's own button is neutral", () => {
    expect(renderRow()).not.toContain("bg-destructive text-white");
    expect(renderRow({ confirmationOpen: true })).toContain("bg-destructive text-white");
  });

  it("expands the confirmation beneath the machine's row", () => {
    const markup = renderRow({ confirmationOpen: true });

    expect(markup).toContain("Deregister “Studio Mac”?");
    expect(markup).toContain("Confirm deregistration of Studio Mac");
    expect(markup).toContain("Local connections on your devices are not changed.");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Deregister machine");
    expect(markup).not.toContain("This is the machine you are using now.");
  });

  it("marks this machine and warns before deregistering it", () => {
    expect(renderRow({ current: true })).toContain("This machine");
    expect(renderRow({ current: true, confirmationOpen: true })).toContain(
      "This is the machine you are using now.",
    );
    expect(renderRow()).not.toContain("This machine");
  });

  it("locks the confirmation actions while deregistration is pending", () => {
    const markup = renderRow({ confirmationOpen: true, mutationPending: true });

    expect(markup).toContain("Deregistering…");
    expect(markup.match(/ disabled=""/g)).toHaveLength(3);
  });
});

describe("Studio Connect machine row after a failed deregistration", () => {
  it("says in the row that deregistering did not finish, with the reason", () => {
    const html = renderRow({ confirmationOpen: true, failure: "The relay did not answer." });

    expect(html).toContain('role="alert"');
    expect(html).toContain("Deregistering did not finish: The relay did not answer.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("Deregister machine");
  });

  it("shows no failure line until a deregistration has failed", () => {
    const html = renderRow({ confirmationOpen: true });

    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Deregister machine");
  });

  it("tells the person that this machine's own Connect is turned off too", () => {
    expect(renderRow({ confirmationOpen: true, current: true })).toContain(
      "SpecWithCode Connect is turned off on it too.",
    );
  });

  it("puts the failure on the machine it belongs to, not on the others", () => {
    const html = renderView({
      environments: [machine("environment-1", "Studio Mac"), machine("environment-2", "Other Mac")],
      confirmingEnvironmentId: "environment-2" as EnvironmentId,
      deregisterFailure: {
        environmentId: "environment-2" as EnvironmentId,
        message: "The relay did not answer.",
      },
    });

    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain("Deregistering did not finish: The relay did not answer.");
  });
});

describe("Studio Connect machines page", () => {
  it("lists this machine first, then the others by name", () => {
    const ordered = orderConnectMachines(
      [machine("c", "minisforum"), machine("a", "Zeta Mac"), machine("b", "alpha mac")],
      "a" as EnvironmentId,
    );

    expect(ordered.map((entry) => entry.label)).toEqual(["Zeta Mac", "alpha mac", "minisforum"]);
  });

  it("counts the machines in words a person would use", () => {
    expect(connectMachineCountLabel(1)).toBe("1 machine linked");
    expect(connectMachineCountLabel(5)).toBe("5 machines linked");
    expect(renderView()).toContain("1 machine linked");
  });

  it("labels the list and the refresh button for screen readers", () => {
    const markup = renderView();

    expect(markup).toContain('aria-label="Machines linked to your account"');
    expect(markup).toContain("Refresh");
    expect(markup).toContain("<h2");
  });

  it("shows placeholder rows on the first load, not an empty list", () => {
    const markup = renderView({ environments: [], loading: true });

    expect(markup).toContain('aria-label="Loading machines"');
    expect(markup).not.toContain("No machines linked");
  });

  it("says so when no machine is linked", () => {
    expect(renderView({ environments: [] })).toContain("No machines linked");
  });

  it("shows a failed load with its reason and a way to try again", () => {
    const markup = renderView({ environments: [], error: "Relay unavailable" });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not load your machines");
    expect(markup).toContain("Relay unavailable");
    expect(markup).toContain("Try again");
    expect(markup).not.toContain("No machines linked");
  });

  it("keeps the list on screen when a refresh fails", () => {
    const markup = renderView({ error: "Relay unavailable" });

    expect(markup).toContain("Could not load your machines");
    expect(markup).toContain("Studio Mac");
  });
});

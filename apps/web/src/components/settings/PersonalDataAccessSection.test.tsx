import { EnvironmentId, type PersonalDataAccessStatus } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  PERSONAL_DATA_LOG_PREVIEW,
  PersonalDataAccessView,
  pendingPersonalDataRequests,
  personalDataSummary,
} from "./PersonalDataAccessSection";

const at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const machine = (
  label: string,
  extra: Partial<PersonalDataAccessStatus["machines"][number]> = {},
): PersonalDataAccessStatus["machines"][number] => ({
  environmentId: EnvironmentId.make(`env-${label}`),
  label,
  ownMachine: false,
  sources: [],
  requested: [],
  ...extra,
});

const status: PersonalDataAccessStatus = {
  machines: [
    machine("m1", { ownMachine: true, requested: ["drive"] }),
    machine("Dana's MacBook", { sources: ["calendar"], requested: ["gmail"] }),
    machine("Build box"),
  ],
  log: [
    {
      at,
      environmentId: EnvironmentId.make("env-d"),
      label: "Dana's MacBook",
      source: "gmail",
      action: "refused",
      tool: "studio_google_gmail_search",
    },
    {
      at,
      environmentId: EnvironmentId.make("env-d"),
      label: "Dana's MacBook",
      source: "calendar",
      action: "used",
      tool: "studio_google_calendar_events",
    },
    {
      at,
      environmentId: EnvironmentId.make("env-d"),
      label: "Dana's MacBook",
      source: "calendar",
      action: "granted",
    },
  ],
};

const render = (
  value: PersonalDataAccessStatus,
  extra: { canWrite?: boolean; showAllLog?: boolean } = {},
) =>
  renderToStaticMarkup(
    <PersonalDataAccessView
      status={value}
      canWrite={extra.canWrite ?? true}
      busy={false}
      error={null}
      showAllLog={extra.showAllLog ?? false}
      onShowAllLog={() => {}}
      onChange={() => {}}
    />,
  );

describe("personal data access", () => {
  it("lists requests from other people's machines only", () => {
    expect(
      pendingPersonalDataRequests(status.machines).map(
        ({ machine: asked, source }) => `${asked.label}:${source}`,
      ),
    ).toEqual(["Dana's MacBook:gmail"]);
  });

  it("says in one line what each machine's work may read", () => {
    expect(personalDataSummary(status.machines[0]!)).toBe(
      "Your own machine. Its work reads what you can.",
    );
    expect(personalDataSummary(status.machines[1]!)).toBe("Reads Calendar.");
    expect(personalDataSummary(status.machines[2]!)).toBe("Reads none of your personal data.");
  });

  it("shows a switch per source for other machines and none for the owner's own", () => {
    const html = render(status);
    expect(html).toContain("Gmail for work from Dana&#x27;s MacBook");
    expect(html).toContain("Calendar for work from Dana&#x27;s MacBook");
    expect(html).toContain("Drive for work from Build box");
    expect(html).not.toContain("for work from m1");
    // Three sources for each of the two machines that are not the owner's.
    expect(html.match(/role="switch"/g)).toHaveLength(6);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("shows the request with Allow and Dismiss, and the log in plain words", () => {
    const html = render(status);
    expect(html).toContain("Work from Dana&#x27;s MacBook asked to read your Gmail.");
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Dismiss<");
    expect(html).toContain("Dana&#x27;s MacBook asked for Gmail and was refused");
    expect(html).toContain("Dana&#x27;s MacBook read Calendar");
    expect(html).toContain("You allowed Dana&#x27;s MacBook to read Calendar");
    expect(html).toContain("Percy&#x27;s chats, memory and routines are never shared.");
  });

  it("locks every control for a connection that cannot change settings", () => {
    const html = render(status, { canWrite: false });
    expect(html.match(/role="switch"/g)).toHaveLength(6);
    expect(html.match(/data-disabled/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("previews the newest log lines until Show all", () => {
    const long: PersonalDataAccessStatus = {
      machines: status.machines,
      log: Array.from({ length: PERSONAL_DATA_LOG_PREVIEW + 4 }, () => status.log[1]!),
    };
    expect(render(long).match(/read Calendar/g)).toHaveLength(PERSONAL_DATA_LOG_PREVIEW);
    expect(render(long)).toContain(`Show all ${PERSONAL_DATA_LOG_PREVIEW + 4}`);
    expect(render(long, { showAllLog: true }).match(/read Calendar/g)).toHaveLength(
      PERSONAL_DATA_LOG_PREVIEW + 4,
    );
  });

  it("says so when no other machine may run work here", () => {
    expect(render({ machines: [], log: [] })).toContain(
      "No other machine may run work here, so nothing else can ask.",
    );
  });
});

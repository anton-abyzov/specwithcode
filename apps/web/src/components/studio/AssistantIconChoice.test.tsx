import { EnvironmentId, type ProjectIconOverride } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  distinctAssistantIconChanges,
  distinctIconCommandId,
} from "../../hooks/useDistinctAssistantIcons";
import { AssistantIconChoice, suggestedAssistantIcon } from "./AssistantIconChoice";
import { ProjectCreationPreview } from "./ProjectCreation";

const bell: ProjectIconOverride = { kind: "lucide", name: "concierge-bell", color: "violet" };
const m1 = EnvironmentId.make("env-m1");
const m4 = EnvironmentId.make("env-m4");

describe("assistant icon at setup", () => {
  it("keeps the bell for the first assistant", () => {
    expect(suggestedAssistantIcon([], "env-m4")).toEqual(bell);
  });

  it("starts a second assistant on another glyph and another colour", () => {
    const icon = suggestedAssistantIcon([bell], "env-m4");
    expect(icon.name).not.toBe("concierge-bell");
    expect(icon.color).not.toBe("violet");
  });

  it("offers every choice, marks the one in use and says whose it is", () => {
    const value = suggestedAssistantIcon([bell], "env-m4");
    const html = renderToStaticMarkup(
      <AssistantIconChoice
        value={value}
        onChange={() => {}}
        others={[{ icon: bell, label: "Percy · m4" }]}
        seed="env-m4"
      />,
    );
    expect(html.match(/role="radio"/g)?.length).toBe(12 + 18);
    expect(html).toContain("Concierge bell, used by Percy · m4");
    expect(html).toContain("Suggested so it differs from your other assistants.");
    // One icon and one colour are selected: the suggested pair.
    expect(html.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(html.match(/data-taken/g)).toHaveLength(1);
  });

  it("shows the chosen icon in the preview row", () => {
    const html = renderToStaticMarkup(
      <ProjectCreationPreview
        kind="personal"
        name="Percy"
        path={null}
        root={null}
        machine={null}
        icon={{ kind: "lucide", name: "sparkles", color: "amber" }}
      />,
    );
    expect(html).toContain("text-amber-600");
  });
});

describe("distinct icons for assistants from before icon choice", () => {
  const assistants = [
    { id: "p-m1", environmentId: m1, createdAt: "2026-10-01T00:00:00.000Z", projectIcon: bell },
    { id: "p-m4", environmentId: m4, createdAt: "2026-10-20T00:00:00.000Z", projectIcon: bell },
  ];

  it("changes the later assistant and leaves the earliest on the bell", () => {
    const changes = distinctAssistantIconChanges({
      assistants,
      everyMachineConnected: true,
      attempted: new Set(),
    });
    expect(changes.map((change) => change.id)).toEqual(["p-m4"]);
    expect(changes[0]!.icon.name).not.toBe("concierge-bell");
  });

  it("waits until every machine is connected, so all windows agree", () => {
    expect(
      distinctAssistantIconChanges({
        assistants,
        everyMachineConnected: false,
        attempted: new Set(),
      }),
    ).toEqual([]);
  });

  it("tries each assistant once per window and uses one command id everywhere", () => {
    expect(
      distinctAssistantIconChanges({
        assistants,
        everyMachineConnected: true,
        attempted: new Set(["env-m4:p-m4"]),
      }),
    ).toEqual([]);
    expect(distinctIconCommandId("p-m4")).toBe("assistant-distinct-icon:v1:p-m4");
  });

  it("leaves a chosen icon alone", () => {
    expect(
      distinctAssistantIconChanges({
        assistants: [
          assistants[0]!,
          { ...assistants[1]!, projectIcon: { kind: "emoji", emoji: "🦊" } },
        ],
        everyMachineConnected: true,
        attempted: new Set(),
      }),
    ).toEqual([]);
  });
});

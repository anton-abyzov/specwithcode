import { ScheduledTaskUpsertSchedule } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  expandRoutinePrompt,
  PROACTIVE_BRIEFING_PROMPT,
  ROUTINE_TEMPLATES,
  routineTemplate,
} from "./routineTemplates.ts";

describe("routine templates", () => {
  it("offers the five personal routines with phone-length names", () => {
    expect(ROUTINE_TEMPLATES.map((template) => template.title)).toEqual([
      "Proactive briefing",
      "Monthly tax prep",
      "Monthly profit and loss",
      "Research brief",
      "Email triage and draft replies",
    ]);
    for (const template of ROUTINE_TEMPLATES) {
      expect(template.title.length).toBeLessThanOrEqual(32);
      expect(template.summary.length).toBeLessThanOrEqual(64);
      expect(routineTemplate(template.id)).toBe(template);
    }
  });

  it("routes project work and never acts outside the Mac", () => {
    for (const template of ROUTINE_TEMPLATES) {
      expect(template.prompt).toContain("studio_project_route");
      // Sending, filing or paying appear only as things not to do.
      expect(template.prompt).not.toMatch(/\b(send|file|pay)\s+(the|my|it|this)\b/i);
    }
    expect(routineTemplate("email-triage")?.prompt).toContain("do not send");
  });

  it("briefs proactively without noise, guessed urgency or sending", () => {
    const prompt = routineTemplate("proactive-briefing")!.prompt;
    expect(prompt).toContain("at most 5");
    expect(prompt).toContain("Nothing needs you right now.");
    expect(prompt).toContain("Drafts saved: N. Nothing was sent.");
    expect(prompt).toContain("Never invent or inflate urgency");
    expect(prompt).toContain("studio_google_gmail_create_draft");
    expect(prompt).toContain("Briefing preferences");
    expect(routineTemplate("proactive-briefing")!.suggestedCadence).toEqual({
      type: "fixed_time",
      timeOfDay: "08:00",
    });
    // Only the briefing starts on its cadence; every other template runs when asked.
    expect(ROUTINE_TEMPLATES.filter((t) => t.cadenceOnByDefault).map((t) => t.id)).toEqual([
      "proactive-briefing",
    ]);
  });

  it("expands the briefing command the assistant writes, keeping the user's wishes", () => {
    expect(expandRoutinePrompt("/proactive-briefing")).toBe(PROACTIVE_BRIEFING_PROMPT);
    expect(expandRoutinePrompt(" /proactive-briefing  only work mail ")).toBe(
      `${PROACTIVE_BRIEFING_PROMPT}\n\nMy wishes for this briefing: only work mail`,
    );
    expect(expandRoutinePrompt("/proactive-briefings")).toBe("/proactive-briefings");
    expect(expandRoutinePrompt("Summarize /proactive-briefing")).toBe(
      "Summarize /proactive-briefing",
    );
  });

  it("suggests only valid cadences", () => {
    const decode = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
    for (const template of ROUTINE_TEMPLATES)
      if (template.suggestedCadence !== null)
        expect(decode(template.suggestedCadence)).toEqual(template.suggestedCadence);
  });
});
